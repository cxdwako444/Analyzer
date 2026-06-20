import { Router } from "express";
import type { Request, Response } from "express";

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

router.get("/twitch-chat", async (req: Request, res: Response) => {
  const { videoId: rawId } = req.query;
  if (!rawId || typeof rawId !== "string") {
    res.status(400).json({ error: "videoId query param is required" });
    return;
  }

  const videoId = extractVideoId(rawId);
  if (!videoId || !/^\d+$/.test(videoId)) {
    res.status(400).json({ error: `Could not extract a numeric video ID from: ${rawId}` });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  const messages: Array<{ timestamp: number; user: string; text: string }> = [];
  let contentOffset = 0;
  let hasNextPage = true;
  let consecutiveErrors = 0;
  const MAX_ERRORS = 6;
  let lastPageOffset = -1;

  try {
    while (hasNextPage && !req.destroyed) {
      const body = JSON.stringify([
        {
          operationName: "VideoCommentsByOffsetOrCursor",
          variables: {
            videoID: videoId,
            contentOffsetSeconds: contentOffset,
          },
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
        resp = await fetch(TWITCH_GQL, {
          method: "POST",
          headers: {
            "Client-Id": TWITCH_CLIENT_ID,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors > MAX_ERRORS) {
          sseWrite(res, {
            type: "error",
            message: `Network error after ${MAX_ERRORS} retries: ${String(err)}`,
          });
          res.end();
          return;
        }
        await sleep(Math.min(1000 * Math.pow(2, consecutiveErrors), 16_000));
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

      const root = (json as Array<{ data?: { video?: { comments?: { edges?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | null } }>)[0];
      const video = root?.data?.video;

      if (!video) {
        // Could be a private/deleted VOD, or an integrity check failure
        if (messages.length > 0) {
          // Treat as rate limit / bot check — return what we have
          sseWrite(res, {
            type: "ratelimit",
            message:
              "Twitch returned empty data — this is often a bot-check or rate limit. Analyzing the messages fetched so far.",
            count: messages.length,
          });
          break;
        }
        sseWrite(res, {
          type: "error",
          message: "VOD not found, is private, or Twitch rejected the request. Check the video ID.",
        });
        res.end();
        return;
      }

      const edges = (video.comments?.edges ?? []) as Array<{
        node: {
          content_offset_seconds: number;
          commenter?: { display_name?: string };
          message?: { fragments?: Array<{ text?: string }> };
        };
      }>;
      hasNextPage = video.comments?.pageInfo?.hasNextPage ?? false;

      if (edges.length === 0) {
        hasNextPage = false;
        break;
      }

      let furthestOffset = contentOffset;
      for (const edge of edges) {
        const node = edge.node;
        const ts = node.content_offset_seconds ?? 0;
        const user = node.commenter?.display_name ?? "";
        const text =
          node.message?.fragments?.map((f) => f.text ?? "").join("") ?? "";
        messages.push({ timestamp: ts, user, text });
        if (ts > furthestOffset) furthestOffset = ts;
      }

      // Guard: if we made no progress, break to avoid infinite loop
      if (furthestOffset === lastPageOffset) {
        hasNextPage = false;
        break;
      }
      lastPageOffset = furthestOffset;
      contentOffset = furthestOffset;

      // Progress event roughly every 2 000 messages
      if (messages.length % 2000 < edges.length) {
        sseWrite(res, { type: "progress", count: messages.length });
      }

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
  }

  res.end();
});

export default router;
