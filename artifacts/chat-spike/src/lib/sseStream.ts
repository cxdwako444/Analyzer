export interface ApiMessage {
  timestamp: number;
  user: string;
  text: string;
}

export interface SseProgressEvent {
  type: "progress";
  count: number;
  status?: string;
}

export interface SseDoneEvent {
  type: "done";
  messages: ApiMessage[];
  totalCount: number;
}

export interface SseErrorEvent {
  type: "error";
  message: string;
}

export interface SseRateLimitEvent {
  type: "ratelimit";
  message: string;
  count: number;
}

export type SseEvent =
  | SseProgressEvent
  | SseDoneEvent
  | SseErrorEvent
  | SseRateLimitEvent;

export interface StreamOptions {
  onProgress: (count: number, status?: string) => void;
  onWarning: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Read a text/event-stream response (SSE) from a URL (GET).
 * Returns the messages array from the "done" event.
 * Throws on fatal error.
 */
export async function streamFetch(
  url: string,
  opts: StreamOptions
): Promise<ApiMessage[]> {
  const { onProgress, onWarning, signal } = opts;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    throw new Error(`Could not connect to server: ${String(err)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Server error ${response.status}: ${body || response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";
  let warning: string | null = null;

  while (true) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await reader.read();
    } catch {
      break;
    }

    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    // SSE events are delimited by double newlines
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;

      // Strip "data: " prefix (standard SSE)
      const dataLine = line.startsWith("data: ")
        ? line.slice(6)
        : line;

      let event: SseEvent;
      try {
        event = JSON.parse(dataLine) as SseEvent;
      } catch {
        continue;
      }

      switch (event.type) {
        case "progress":
          onProgress(event.count, event.status);
          break;

        case "ratelimit":
          warning = event.message;
          onWarning(event.message);
          onProgress(event.count);
          break;

        case "error":
          reader.cancel().catch(() => {});
          throw new Error(event.message);

        case "done":
          reader.cancel().catch(() => {});
          return event.messages;
      }
    }
  }

  // If we exited the loop without a done event (e.g. after ratelimit break on server side),
  // try to parse whatever is left in the buffer
  if (buffer.trim()) {
    const dataLine = buffer.trim().startsWith("data: ")
      ? buffer.trim().slice(6)
      : buffer.trim();
    try {
      const event = JSON.parse(dataLine) as SseEvent;
      if (event.type === "done") return event.messages;
    } catch { /* ignore */ }
  }

  if (warning) {
    // We got a ratelimit warning — the server will have sent done after it
    return [];
  }

  throw new Error("Stream ended without a completion event.");
}
