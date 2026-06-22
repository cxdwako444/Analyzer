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
  onWarning?: (msg: string) => void,
): Promise<ApiMessage[]> {
  const messages: ApiMessage[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let page = 0;
  let errors = 0;
  let stopReason = "completed normally";
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
      stopReason = `HTTP 429 (rate limited) after ${page} pages / ${messages.length} msgs`;
      break;
    }
    if (!resp.ok) {
      errors++;
      if (errors > 5) {
        stopReason = `HTTP ${resp.status} repeatedly after ${page} pages`;
        break;
      }
      await sleep(1000 * errors);
      continue;
    }
    errors = 0;

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      stopReason = "non-JSON response";
      break;
    }

    const root = (
      json as Array<{
        errors?: Array<{ message?: string }>;
        data?: {
          video?: {
            comments?: { edges?: Edge[]; pageInfo?: { hasNextPage?: boolean } };
          } | null;
        };
      }>
    )[0];
    const gqlErrors = root?.errors;
    const video = root?.data?.video;

    if (!video) {
      stopReason = `video=null at page ${page + 1}, msgs=${messages.length}${
        gqlErrors ? ` · gqlErrors=${JSON.stringify(gqlErrors).slice(0, 200)}` : ""
      }`;
      break;
    }

    const edges = video.comments?.edges ?? [];
    if (edges.length === 0) {
      stopReason = `empty edges at page ${page + 1}, msgs=${messages.length}`;
      break;
    }

    for (const e of edges) {
      const n = e.node;
      messages.push({
        timestamp: n.content_offset_seconds ?? 0,
        user: n.commenter?.display_name ?? "",
        text: (n.message?.fragments ?? []).map((f) => f.text ?? "").join(""),
      });
    }

    const apiHasNext = video.comments?.pageInfo?.hasNextPage;
    const next = edges[edges.length - 1]?.cursor ?? null;
    page++;

    if (apiHasNext === false) {
      stopReason = `pageInfo.hasNextPage=false at page ${page}, msgs=${messages.length}, lastEdgeCursor=${next ? "present" : "null"}`;
      hasNextPage = false;
    } else if (!next) {
      stopReason = `no cursor on last edge at page ${page}, msgs=${messages.length} (apiHasNext=${apiHasNext})`;
      hasNextPage = false;
    } else if (seen.has(next)) {
      stopReason = `cursor repeated at page ${page}, msgs=${messages.length}`;
      hasNextPage = false;
    } else {
      seen.add(next);
      cursor = next;
    }

    const lastTs = messages[messages.length - 1]?.timestamp ?? 0;
    onProgress(messages.length, `Page ${page} · up to ${Math.floor(lastTs / 60)}m into the VOD`);

    await sleep(50);
  }

  // Always surface why we stopped so we can diagnose short pulls.
  onWarning?.(`Stopped: ${stopReason}`);
  return messages;
}
