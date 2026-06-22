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
    id?: string;
    content_offset_seconds: number;
    commenter?: { display_name?: string };
    message?: { fragments?: Array<{ text?: string }> };
  };
}

/**
 * Fetch a Twitch VOD's chat replay DIRECTLY from the user's browser.
 *
 * Pages forward by content offset (re-querying at the last comment's
 * timestamp), NOT by cursor — Twitch's cursor pagination returns empty edges
 * here, capping at one page. Dedup + a small nudge handle dense chat so we walk
 * the whole VOD. Runs client-side so the request comes from the user's own IP.
 */
export async function fetchTwitchChatClient(
  videoId: string,
  onProgress: (count: number, status?: string) => void,
  signal?: AbortSignal,
  onWarning?: (msg: string) => void,
): Promise<ApiMessage[]> {
  const messages: ApiMessage[] = [];
  const seenIds = new Set<string>();
  let offset = 0; // content offset (seconds into the VOD) to query next
  let page = 0;
  let errors = 0;
  let emptyStreak = 0; // consecutive responses with no edges
  let noNewStreak = 0; // consecutive responses that added nothing new
  let stopReason = "reached end of VOD";
  const diag: string[] = []; // per-page diagnostics for the first few pages
  const MAX_PAGES = 8000; // safety guard

  onProgress(0, "Fetching directly from your device (no proxy)…");

  while (page < MAX_PAGES) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const body = JSON.stringify([
      {
        operationName: "VideoCommentsByOffsetOrCursor",
        variables: { videoID: videoId, contentOffsetSeconds: offset },
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
      stopReason = `rate limited (429) at ${messages.length} msgs`;
      break;
    }
    if (!resp.ok) {
      errors++;
      if (errors > 5) {
        stopReason = `HTTP ${resp.status} repeatedly`;
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
            comments?: { edges?: Edge[] };
          } | null;
        };
      }>
    )[0];
    const video = root?.data?.video;
    if (!video) {
      if (root?.errors) {
        stopReason = `gqlErrors=${JSON.stringify(root.errors).slice(0, 160)}`;
        break;
      }
      // No video at this offset — skip ahead in case it's a quiet gap.
      emptyStreak++;
      if (emptyStreak >= 3) {
        stopReason = `video=null x${emptyStreak} at ${offset}s`;
        break;
      }
      offset += 30;
      continue;
    }

    const edges = video.comments?.edges ?? [];
    if (edges.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 3) {
        stopReason = `empty edges x${emptyStreak} near ${offset}s, msgs=${messages.length}`;
        break;
      }
      offset += 30; // jump past a possible chat-free stretch
      continue;
    }
    emptyStreak = 0;

    let maxTs = offset;
    let minTs = Infinity;
    let newCount = 0;
    let withCursor = 0;
    for (const e of edges) {
      const n = e.node;
      const ts = n.content_offset_seconds ?? 0;
      const user = n.commenter?.display_name ?? "";
      const text = (n.message?.fragments ?? []).map((f) => f.text ?? "").join("");
      const id = n.id ?? `${ts}|${user}|${text}`;
      if (e.cursor) withCursor++;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        messages.push({ timestamp: ts, user, text });
        newCount++;
      }
      if (ts > maxTs) maxTs = ts;
      if (ts < minTs) minTs = ts;
    }

    // Capture what the first few queries actually returned, to see whether
    // contentOffsetSeconds is being honored.
    if (diag.length < 4) {
      diag.push(
        `q@${offset}s→edges=${edges.length} off=[${Math.floor(minTs)}..${Math.floor(maxTs)}] new=${newCount} cur=${withCursor}/${edges.length} id=${edges[0]?.node?.id ? "y" : "n"}`,
      );
    }

    page++;

    // Advance. If the whole batch sat on the same second, nudge forward by 1s
    // so we don't loop forever (dedup keeps us from re-counting).
    offset = maxTs > offset ? maxTs : offset + 1;

    if (newCount === 0) {
      noNewStreak++;
      if (noNewStreak >= 4) {
        stopReason = `no new messages for ${noNewStreak} pages, msgs=${messages.length}`;
        break;
      }
    } else {
      noNewStreak = 0;
    }

    onProgress(
      messages.length,
      `Page ${page} · up to ${Math.floor(offset / 60)}m into the VOD`,
    );

    await sleep(40);
  }

  onWarning?.(
    `vod=${videoId} stop="${stopReason}" msgs=${messages.length} pages=${page} | ${diag.join(" ; ")}`,
  );
  return messages;
}
