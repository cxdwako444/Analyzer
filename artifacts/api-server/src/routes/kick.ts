import { Router } from "express";
import type { Request, Response } from "express";
import { openKickSession, type KickBrowserSession } from "../lib/kickBrowser";

const router = Router();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseWrite(res: Response, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseKickUrl(url: string): { videoId: string; channel: string } | null {
  // https://kick.com/channel/videos/uuid
  // https://kick.com/videos/uuid
  const m1 = url.match(/kick\.com\/([^/]+)\/videos\/([a-zA-Z0-9-]+)/);
  if (m1) return { channel: m1[1], videoId: m1[2] };
  const m2 = url.match(/kick\.com\/videos?\/([a-zA-Z0-9-]+)/);
  if (m2) return { channel: "", videoId: m2[1] };
  // Bare UUID / ID
  const bare = url.trim();
  if (/^[a-zA-Z0-9-]+$/.test(bare)) return { channel: "", videoId: bare };
  return null;
}

router.get("/kick-chat", async (req: Request, res: Response) => {
  const { url: rawUrl, proxy: rawProxy } = req.query;

  if (!rawUrl || typeof rawUrl !== "string") {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  const parsed = parseKickUrl(rawUrl);
  if (!parsed) {
    res.status(400).json({ error: `Cannot parse Kick VOD URL: ${rawUrl}` });
    return;
  }

  const proxy = typeof rawProxy === "string" && rawProxy.trim() ? rawProxy.trim() : null;

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  // Immediate response + heartbeats so the gateway doesn't 502 a long fetch.
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  const messages: Array<{ timestamp: number; user: string; text: string }> = [];

  // ── Launch the headless browser to clear Cloudflare ──────────────────────
  let session: KickBrowserSession;
  try {
    sseWrite(res, {
      type: "progress",
      count: 0,
      status: proxy
        ? "Launching headless browser via proxy (passing Cloudflare)…"
        : "Launching headless browser (passing Cloudflare)…",
    });
    session = await openKickSession({ proxy });
  } catch (err) {
    sseWrite(res, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  try {
    // ── Step 1: resolve video metadata ──────────────────────────────────────
    sseWrite(res, { type: "progress", count: 0, status: "Resolving VOD metadata…" });

    const meta = await session.fetchJson(
      `https://kick.com/api/v1/video/${parsed.videoId}`,
    );

    if (meta.status === 403 || meta.status === 429 || meta.status === 503) {
      sseWrite(res, {
        type: "error",
        message: `Kick/Cloudflare returned HTTP ${meta.status} even through the headless browser.${
          proxy
            ? " Try a different residential proxy — this IP may be flagged."
            : " Try again, or add a residential proxy in the Kick panel."
        }`,
      });
      throw new Error("blocked");
    }

    if (meta.status !== 200 || !meta.json) {
      sseWrite(res, {
        type: "error",
        message: `Could not load Kick VOD metadata (HTTP ${meta.status}). Check the VOD URL.`,
      });
      throw new Error("no-metadata");
    }

    const videoData = meta.json as {
      id?: string | number;
      uuid?: string;
      duration?: number;
      start_time?: string;
      channel?: { slug?: string };
      livestream?: {
        channel?: { slug?: string };
        start_time?: string;
        duration?: number;
      };
    };

    const channelSlug =
      videoData.channel?.slug ??
      videoData.livestream?.channel?.slug ??
      parsed.channel;

    if (!channelSlug) {
      sseWrite(res, {
        type: "error",
        message: "Could not determine the channel from Kick video metadata. Check the VOD URL.",
      });
      throw new Error("no-channel");
    }

    const rawStartTime = videoData.start_time ?? videoData.livestream?.start_time;
    const durationSecs =
      (videoData.duration ?? videoData.livestream?.duration ?? 0) / 1000;
    const startUnix = rawStartTime ? Date.parse(rawStartTime) / 1000 : 0;

    if (durationSecs <= 0) {
      sseWrite(res, {
        type: "error",
        message: "Could not determine VOD duration from Kick metadata.",
      });
      throw new Error("no-duration");
    }

    // ── Step 2: page through chat replay in 2-min windows ────────────────
    const WINDOW = 120; // seconds per chunk request
    const totalWindows = Math.ceil(durationSecs / WINDOW);
    sseWrite(res, {
      type: "progress",
      count: 0,
      status: `Fetching chat for a ${Math.round(durationSecs / 60)}-min VOD…`,
    });

    let blockedStreak = 0;
    for (let w = 0; w < totalWindows && !req.destroyed; w++) {
      const windowStart = startUnix + w * WINDOW;
      const windowEnd = windowStart + WINDOW;

      const url =
        `https://kick.com/api/v2/channels/${channelSlug}/messages` +
        `?start_time=${Math.floor(windowStart)}&end_time=${Math.floor(windowEnd)}`;
      const chunk = await session.fetchJson(url);

      if (chunk.status === 403 || chunk.status === 503 || chunk.status === 429) {
        // Cloudflare may start blocking mid-run; tolerate a few then bail.
        blockedStreak++;
        if (blockedStreak >= 3) {
          sseWrite(res, {
            type: "ratelimit",
            message: `Cloudflare started blocking after ${messages.length} messages. Analyzing what we have.`,
            count: messages.length,
          });
          break;
        }
        await sleep(1500);
        continue;
      }
      blockedStreak = 0;

      if (chunk.status !== 200 || !chunk.json) {
        // Non-fatal: skip this window
        await sleep(300);
        continue;
      }

      const chunkData = chunk.json as {
        data?: Array<{
          created_at?: string;
          content?: string;
          sender?: { username?: string };
        }>;
      };

      const rows = chunkData.data ?? [];
      for (const row of rows) {
        const user = row.sender?.username ?? "";
        const text = row.content ?? "";
        const createdAt = row.created_at
          ? Date.parse(row.created_at) / 1000
          : windowStart;
        const timestamp = Math.max(0, createdAt - startUnix);
        messages.push({ timestamp, user, text });
      }

      if (w % 5 === 0 || w === totalWindows - 1) {
        sseWrite(res, {
          type: "progress",
          count: messages.length,
          status: `${Math.round(((w + 1) / totalWindows) * 100)}% of VOD scanned…`,
        });
      }

      await sleep(150);
    }

    sseWrite(res, { type: "done", messages, totalCount: messages.length });
  } catch (err) {
    // Errors we surfaced above are thrown to break out; only report unexpected ones.
    const msg = err instanceof Error ? err.message : String(err);
    if (!["blocked", "no-metadata", "no-channel", "no-duration"].includes(msg)) {
      sseWrite(res, { type: "error", message: msg });
    }
  } finally {
    await session.close();
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
