import { Router } from "express";
import type { Request, Response } from "express";
import { openKickSession, type KickBrowserSession } from "../lib/kickBrowser";

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

function makeDeviceId(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 32; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
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
    res
      .status(400)
      .json({ error: `Could not extract a numeric video ID from: ${rawId}` });
    return;
  }

  // ── SSE setup ────────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  const messages: Array<{ timestamp: number; user: string; text: string }> = [];

  // ── Open a real browser ON the Twitch VOD page (no proxy) ─────────────────
  // A genuine browser session on twitch.tv gets real cookies + Twitch's own
  // integrity token, so the GraphQL chat calls below look like a real viewer —
  // this is what gets past the datacenter-IP bot-check without a proxy.
  sseWrite(res, {
    type: "progress",
    count: 0,
    status: "Launching browser on Twitch (no proxy)…",
  });

  let session: KickBrowserSession;
  try {
    session = await openKickSession({
      primeUrl: `https://www.twitch.tv/videos/${videoId}`,
    });
  } catch (err) {
    sseWrite(res, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  const deviceId = makeDeviceId();
  let cursor: string | null = null;
  let hasNextPage = true;
  let page = 0;
  let consecutiveErrors = 0;
  const MAX_ERRORS = 4;
  const seenCursors = new Set<string>();
  // Generous deadline; on Replit Autoscale the gateway still caps ~60s, so for
  // long VODs use a Reserved VM. We always return what we have.
  const DEADLINE_MS = 280_000;
  const startedAt = Date.now();

  try {
    while (hasNextPage && !req.destroyed) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        sseWrite(res, {
          type: "ratelimit",
          message: `Hit the time limit — analyzing the ${messages.length} messages fetched so far.`,
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
            persistedQuery: { version: 1, sha256Hash: QUERY_HASH },
          },
        },
      ]);

      const r = await session.fetchRaw(TWITCH_GQL, {
        method: "POST",
        headers: {
          "Client-Id": TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
          "Device-ID": deviceId,
        },
        body,
      });

      if (r.status !== 200) {
        consecutiveErrors++;
        if (consecutiveErrors > MAX_ERRORS) {
          if (messages.length > 0) {
            sseWrite(res, {
              type: "ratelimit",
              message: `Twitch returned HTTP ${r.status} repeatedly — analyzing the ${messages.length} messages fetched so far.`,
              count: messages.length,
            });
            break;
          }
          sseWrite(res, {
            type: "error",
            message: `Twitch returned HTTP ${r.status} (${r.text.slice(0, 120)})`,
          });
          throw new Error("twitch-http");
        }
        await new Promise((s) => setTimeout(s, 800 * consecutiveErrors));
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(r.text);
      } catch {
        sseWrite(res, { type: "error", message: "Twitch returned non-JSON body" });
        throw new Error("twitch-nonjson");
      }

      const root = (
        json as Array<{
          data?: {
            video?: {
              comments?: {
                edges?: Array<{
                  cursor?: string;
                  node: {
                    content_offset_seconds: number;
                    commenter?: { display_name?: string };
                    message?: { fragments?: Array<{ text?: string }> };
                  };
                }>;
                pageInfo?: { hasNextPage?: boolean };
              };
            } | null;
          };
        }>
      )[0];
      const video = root?.data?.video;

      if (!video) {
        if (messages.length > 0) {
          sseWrite(res, {
            type: "ratelimit",
            message: `Twitch stopped returning data after ${messages.length} messages (bot-check). Analyzing what we have. For full VODs, run locally.`,
            count: messages.length,
          });
          break;
        }
        sseWrite(res, {
          type: "error",
          message:
            "Twitch returned no data on the first page — the VOD may be private/deleted, or this IP is hard bot-checked.",
        });
        throw new Error("twitch-empty");
      }

      consecutiveErrors = 0;
      const edges = video.comments?.edges ?? [];
      if (edges.length === 0) break;

      for (const edge of edges) {
        const node = edge.node;
        messages.push({
          timestamp: node.content_offset_seconds ?? 0,
          user: node.commenter?.display_name ?? "",
          text: node.message?.fragments?.map((f) => f.text ?? "").join("") ?? "",
        });
      }

      hasNextPage = video.comments?.pageInfo?.hasNextPage ?? false;
      const nextCursor = edges[edges.length - 1]?.cursor ?? null;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        hasNextPage = false;
      } else {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      page++;
      const lastTs = messages[messages.length - 1]?.timestamp ?? 0;
      sseWrite(res, {
        type: "progress",
        count: messages.length,
        status: `Page ${page} · up to ${Math.floor(lastTs / 60)}m into the VOD`,
      });

      await new Promise((s) => setTimeout(s, 60));
    }

    sseWrite(res, { type: "done", messages, totalCount: messages.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!["twitch-http", "twitch-nonjson", "twitch-empty"].includes(msg)) {
      sseWrite(res, { type: "error", message: msg });
    }
  } finally {
    await session.close();
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
