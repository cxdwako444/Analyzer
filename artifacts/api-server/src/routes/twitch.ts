import { Router } from "express";
import type { Request, Response } from "express";
import { makeFetcher } from "../lib/proxy";

const router = Router();

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const QUERY_HASH =
  "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

function extractVideoId(raw: string): string {
  const m = raw.match(/(?:twitch\.tv\/videos?\/)(\d+)/);
  if (m) return m[1];
  const bare = raw.trim().replace(/\D/g, "");
  return bare || raw.trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseWrite(res: Response, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function makeDeviceId(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 32; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

router.get("/twitch-chat", async (req: Request, res: Response) => {
  const { videoId: rawId, proxy: rawProxy } = req.query;
  if (!rawId || typeof rawId !== "string") {
    res.status(400).json({ error: "videoId query param is required" });
    return;
  }

  // Optional proxy — Twitch bot-checks datacenter IPs (e.g. Replit) after the
  // first page, so a residential proxy is needed to walk a full VOD.
  const { fetch: twitchFetch, proxyUrl } = makeFetcher(
    typeof rawProxy === "string" ? rawProxy : null,
  );

  const videoId = extractVideoId(rawId);
  if (!videoId || !/^\d+$/.test(videoId)) {
    res
      .status(400)
      .json({ error: `Could not extract a numeric video ID from: ${rawId}` });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  // Send an immediate comment so the gateway sees a 200 response right away,
  // then keep the connection warm with heartbeats. Long VOD fetches can
  // otherwise look idle to the proxy and get killed with a 502 Bad Gateway.
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  const messages: Array<{ timestamp: number; user: string; text: string }> = [];

  // Show movement immediately — a residential proxy can make the first request
  // slow, and a static "0 messages" spinner looks frozen.
  sseWrite(res, {
    type: "progress",
    count: 0,
    status: proxyUrl ? "Connecting to Twitch via proxy…" : "Connecting to Twitch…",
  });

  // Pagination state.
  // The FIRST request is by content offset (0 = start of VOD). Every request
  // after that pages forward using the previous page's LAST edge cursor.
  // Cursor paging (not re-querying by offset) is what walks the ENTIRE VOD;
  // re-sending contentOffsetSeconds stalls once chat is dense and stops early.
  let cursor: string | null = null;
  let hasNextPage = true;
  let consecutiveErrors = 0;
  let page = 0;
  const MAX_ERRORS = 4;
  const seenCursors = new Set<string>();

  // Wall-clock deadline so the handler ALWAYS returns a result (or a clear
  // error) before the platform gateway kills a stalled request (~60s on
  // Autoscale). Without this, a hanging proxy yields "Stream ended without a
  // completion event" on the client.
  const DEADLINE_MS = 50_000;
  const startedAt = Date.now();

  try {
    while (hasNextPage && !req.destroyed) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        if (messages.length === 0) {
          sseWrite(res, {
            type: "error",
            message: proxyUrl
              ? "Timed out before any messages came back — the proxy is too slow or is blocking Twitch. Clear the Twitch proxy field and try again; Twitch usually works without one."
              : "Timed out before any messages came back. Try again, or paste a working residential proxy.",
          });
          res.end();
          return;
        }
        sseWrite(res, {
          type: "ratelimit",
          message: `Hit the ${DEADLINE_MS / 1000}s time limit — analyzing the ${messages.length} messages fetched so far. For very long VODs, run the server locally where there's no gateway timeout.`,
          count: messages.length,
        });
        break;
      }

      const variables: Record<string, unknown> = cursor
        ? { videoID: videoId, cursor }
        : { videoID: videoId, contentOffsetSeconds: 0 };

      const body = JSON.stringify([
        {
          operationName: "VideoCommentsByOffsetOrCursor",
          variables,
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: QUERY_HASH,
            },
          },
        },
      ]);

      let resp: globalThis.Response;
      try {
        resp = await twitchFetch(TWITCH_GQL, {
          method: "POST",
          headers: {
            "Client-Id": TWITCH_CLIENT_ID,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Language": "en-US",
            // Fresh Device-ID per request to reduce bot-checks on later pages
            "Device-ID": makeDeviceId(),
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors > MAX_ERRORS) {
          sseWrite(res, {
            type: "error",
            message: proxyUrl
              ? `The proxy failed to reach Twitch after ${MAX_ERRORS} tries (${String(err)}). Clear the Twitch proxy field and try again — Twitch usually works without one.`
              : `Network error reaching Twitch after ${MAX_ERRORS} tries: ${String(err)}`,
          });
          res.end();
          return;
        }
        await sleep(Math.min(500 * Math.pow(2, consecutiveErrors), 3_000));
        continue;
      }

      // Twitch can rate-limit with HTTP 429 or serve errors via 200
      if (resp.status === 429) {
        sseWrite(res, {
          type: "ratelimit",
          message:
            "Twitch rate-limited this server's IP — only the messages fetched so far are available. Long VODs may need a proxy.",
          count: messages.length,
        });
        break;
      }

      if (!resp.ok) {
        consecutiveErrors++;
        if (consecutiveErrors > MAX_ERRORS) {
          sseWrite(res, {
            type: "error",
            message: `Twitch returned HTTP ${resp.status} on ${MAX_ERRORS} consecutive attempts`,
          });
          res.end();
          return;
        }
        await sleep(2000 * consecutiveErrors);
        continue;
      }

      consecutiveErrors = 0;

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        sseWrite(res, { type: "error", message: "Twitch returned non-JSON body" });
        res.end();
        return;
      }

      const root = (
        json as Array<{
          data?: {
            video?: {
              comments?: {
                edges?: unknown[];
                pageInfo?: { hasNextPage?: boolean };
              };
            } | null;
          };
        }>
      )[0];
      const video = root?.data?.video;

      if (!video) {
        // Could be a private/deleted VOD, or an integrity/bot-check failure
        if (messages.length > 0) {
          sseWrite(res, {
            type: "ratelimit",
            message: proxyUrl
              ? "Twitch bot-checked the request even through the proxy — analyzing the messages fetched so far. Try a different residential proxy."
              : "Twitch bot-checked this server's IP after the first page (common on cloud hosts). Add a residential proxy in the Twitch panel to fetch the full VOD. Analyzing what we got so far.",
            count: messages.length,
          });
          break;
        }
        sseWrite(res, {
          type: "error",
          message:
            "VOD not found, is private, or Twitch rejected the request. Check the video ID.",
        });
        res.end();
        return;
      }

      const edges = (video.comments?.edges ?? []) as Array<{
        cursor?: string;
        node: {
          content_offset_seconds: number;
          commenter?: { display_name?: string };
          message?: { fragments?: Array<{ text?: string }> };
        };
      }>;

      if (edges.length === 0) {
        hasNextPage = false;
        break;
      }

      for (const edge of edges) {
        const node = edge.node;
        const ts = node.content_offset_seconds ?? 0;
        const user = node.commenter?.display_name ?? "";
        const text =
          node.message?.fragments?.map((f) => f.text ?? "").join("") ?? "";
        messages.push({ timestamp: ts, user, text });
      }

      // Advance using the LAST edge's cursor. Stop when Twitch reports no more
      // pages, when there's no cursor, or if a cursor repeats (loop guard).
      hasNextPage = video.comments?.pageInfo?.hasNextPage ?? false;
      const nextCursor = edges[edges.length - 1]?.cursor ?? null;

      if (!nextCursor || seenCursors.has(nextCursor)) {
        hasNextPage = false;
      } else {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      // Emit progress every page so the UI shows live movement (residential
      // proxies are slow, so the old every-2000 cadence looked frozen).
      page++;
      const lastTs = messages[messages.length - 1]?.timestamp ?? 0;
      sseWrite(res, {
        type: "progress",
        count: messages.length,
        status: `Page ${page} · up to ${Math.floor(lastTs / 60)}m into the VOD`,
      });

      // Polite pause
      await sleep(80);
    }

    sseWrite(res, {
      type: "done",
      messages,
      totalCount: messages.length,
    });
  } catch (err) {
    sseWrite(res, { type: "error", message: String(err) });
  } finally {
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
