import type { ApiMessage } from "./sseStream";

// Twitch's public web Client-ID and the persisted-query hash for VOD comments.
const TWITCH_GQL = "https://gql.twitch.tv/gql";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const QUERY_HASH =
  "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface Edge {
  cursor?: string;
  node: {
    content_offset_seconds: number;
    commenter?: { display_name?: string };
    message?: { fragments?: Array<{ text?: string }> };
  };
}

/**
 * Fetch a Twitch VOD's chat replay DIRECTLY from the user's browser.
 *
 * This runs client-side on purpose: the request comes from the user's own
 * (residential/mobile) IP, which Twitch trusts — unlike a datacenter/server IP,
 * which gets bot-checked after ~100 messages. Twitch's GraphQL endpoint allows
 * cross-origin browser calls (Access-Control-Allow-Origin: *), so no proxy or
 * backend is needed.
 */
export async function fetchTwitchChatClient(
  videoId: string,
  onProgress: (count: number, status?: string) => void,
  signal?: AbortSignal,
): Promise<ApiMessage[]> {
  const messages: ApiMessage[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let page = 0;
  let errors = 0;
  const seen = new Set<string>();

  onProgress(0, "Fetching directly from your device (no proxy)…");

  while (hasNextPage) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const variables = cursor
      ? { videoID: videoId, cursor }
      : { videoID: videoId, contentOffsetSeconds: 0 };

    const body = JSON.stringify([
      {
        operationName: "VideoCommentsByOffsetOrCursor",
        variables,
        extensions: {
          persistedQuery: { version: 1, sha256Hash: QUERY_HASH },
        },
      },
    ]);

    let resp: Response;
    try {
      resp = await fetch(TWITCH_GQL, {
        method: "POST",
        headers: { "Client-Id": CLIENT_ID, "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      errors++;
      if (errors > 5)
        throw new Error("Couldn't reach Twitch from your browser — check your connection.");
      await sleep(800 * errors);
      continue;
    }

    if (resp.status === 429) {
      if (messages.length > 0) break;
      throw new Error("Twitch rate-limited your device. Wait a minute and try again.");
    }
    if (!resp.ok) {
      errors++;
      if (errors > 5) throw new Error(`Twitch returned HTTP ${resp.status}.`);
      await sleep(1000 * errors);
      continue;
    }
    errors = 0;

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      throw new Error("Twitch returned a non-JSON response.");
    }

    const video = (
      json as Array<{
        data?: {
          video?: {
            comments?: { edges?: Edge[]; pageInfo?: { hasNextPage?: boolean } };
          } | null;
        };
      }>
    )[0]?.data?.video;

    if (!video) {
      if (messages.length > 0) break;
      throw new Error("VOD not found, private, or deleted — check the URL.");
    }

    const edges = video.comments?.edges ?? [];
    if (edges.length === 0) break;

    for (const e of edges) {
      const n = e.node;
      messages.push({
        timestamp: n.content_offset_seconds ?? 0,
        user: n.commenter?.display_name ?? "",
        text: (n.message?.fragments ?? []).map((f) => f.text ?? "").join(""),
      });
    }

    hasNextPage = video.comments?.pageInfo?.hasNextPage ?? false;
    const next = edges[edges.length - 1]?.cursor ?? null;
    if (!next || seen.has(next)) {
      hasNextPage = false;
    } else {
      seen.add(next);
      cursor = next;
    }

    page++;
    const lastTs = messages[messages.length - 1]?.timestamp ?? 0;
    onProgress(messages.length, `Page ${page} · up to ${Math.floor(lastTs / 60)}m into the VOD`);

    await sleep(50);
  }

  return messages;
}
