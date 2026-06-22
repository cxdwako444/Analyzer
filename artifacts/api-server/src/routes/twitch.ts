import { Router } from "express";
import type { Request, Response } from "express";
import { openKickSession, type KickBrowserSession } from "../lib/kickBrowser";

const router = Router();

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_INTEGRITY = "https://gql.twitch.tv/integrity";
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  // Open a real browser on twitch.tv so Twitch's own scripts (Kasada) are
  // active — that's what lets us obtain a valid Client-Integrity token, which
  // VOD comment pagination requires.
  sseWrite(res, {
    type: "progress",
    count: 0,
    status: "Launching browser & getting a Twitch integrity token…",
  });

  let session: KickBrowserSession;
  try {
    session = await openKickSession({
      primeUrl: "https://www.twitch.tv/",
      primeSettleMs: 6000,
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

  try {
    // ── Get a Client-Integrity token (from the twitch.tv page context) ──────
    let integrity = "";
    try {
      const ir = await session.fetchRaw(TWITCH_INTEGRITY, {
        method: "POST",
        headers: {
          "Client-Id": TWITCH_CLIENT_ID,
          "Device-ID": deviceId,
          "X-Device-Id": deviceId,
          "Content-Type": "application/json",
        },
        body: "",
        credentials: "include",
      });
      try {
        integrity = (JSON.parse(ir.text) as { token?: string }).token ?? "";
      } catch {
        /* ignore */
      }
      if (!integrity) {
        sseWrite(res, {
          type: "progress",
          count: 0,
          status: `Integrity token not granted (HTTP ${ir.status}) — trying anyway…`,
        });
      }
    } catch {
      /* proceed without */
    }

    // ── Paginate VOD comments using the cursor + integrity token ────────────
    let cursor: string | null = null;
    let hasNextPage = true;
    let page = 0;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 4;
    const seen = new Set<string>();

    while (hasNextPage && !req.destroyed) {
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

      const headers: Record<string, string> = {
        "Client-Id": TWITCH_CLIENT_ID,
        "Device-ID": deviceId,
        "X-Device-Id": deviceId,
        "Content-Type": "application/json",
      };
      if (integrity) headers["Client-Integrity"] = integrity;

      const r = await session.fetchRaw(TWITCH_GQL, { method: "POST", headers, body });

      if (r.status !== 200) {
        consecutiveErrors++;
        if (consecutiveErrors > MAX_ERRORS) {
          if (messages.length > 0) {
            sseWrite(res, {
              type: "ratelimit",
              message: `Twitch HTTP ${r.status} repeatedly — analyzing the ${messages.length} messages so far.`,
              count: messages.length,
            });
            break;
          }
          sseWrite(res, {
            type: "error",
            message: `Twitch returned HTTP ${r.status}: ${r.text.slice(0, 140)}`,
          });
          throw new Error("twitch-http");
        }
        await sleep(700 * consecutiveErrors);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(r.text);
      } catch {
        sseWrite(res, { type: "error", message: "Twitch returned non-JSON." });
        throw new Error("twitch-nonjson");
      }

      const root = (
        json as Array<{
          errors?: Array<{ message?: string; extensions?: { code?: string } }>;
          data?: {
            video?: {
              comments?: {
                edges?: Array<{
                  cursor?: string;
                  node: {
                    id?: string;
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

      const integrityErr = root?.errors?.some(
        (e) => e.extensions?.code === "IntegrityCheckFailed",
      );
      if (integrityErr) {
        if (messages.length > 0) {
          sseWrite(res, {
            type: "ratelimit",
            message: `Twitch integrity check failed mid-fetch — analyzing the ${messages.length} messages so far.`,
            count: messages.length,
          });
          break;
        }
        sseWrite(res, {
          type: "error",
          message:
            "Twitch rejected pagination with an integrity error even with a token. Twitch's anti-bot (Kasada) is blocking headless requests for this VOD.",
        });
        throw new Error("twitch-integrity");
      }

      const video = root?.data?.video;
      if (!video) {
        if (messages.length > 0) break;
        sseWrite(res, {
          type: "error",
          message: `No data for VOD ${videoId} (private/deleted, or blocked).`,
        });
        throw new Error("twitch-empty");
      }

      consecutiveErrors = 0;
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
      if (!next || seen.has(next)) hasNextPage = false;
      else {
        seen.add(next);
        cursor = next;
      }

      page++;
      const lastTs = messages[messages.length - 1]?.timestamp ?? 0;
      sseWrite(res, {
        type: "progress",
        count: messages.length,
        status: `Page ${page} · up to ${Math.floor(lastTs / 60)}m into the VOD`,
      });
      await sleep(50);
    }

    sseWrite(res, { type: "done", messages, totalCount: messages.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !["twitch-http", "twitch-nonjson", "twitch-integrity", "twitch-empty"].includes(msg)
    ) {
      sseWrite(res, { type: "error", message: msg });
    }
  } finally {
    await session.close();
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
