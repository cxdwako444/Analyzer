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

  type VideoData = {
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

  function looksLikeVideo(json: unknown): json is VideoData {
    if (!json || typeof json !== "object") return false;
    const o = json as Record<string, unknown>;
    // Require a duration AND some time/channel info to avoid false positives.
    const hasDuration = "duration" in o || "livestream" in o;
    const hasContext =
      "start_time" in o || "channel" in o || "livestream" in o || "uuid" in o;
    return hasDuration && hasContext;
  }

  // Recursively search an embedded-state tree for a video-shaped object.
  function findVideoInTree(node: unknown, depth = 0): VideoData | undefined {
    if (depth > 6 || !node || typeof node !== "object") return undefined;
    if (looksLikeVideo(node)) return node;
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findVideoInTree(value, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  try {
    // ── Step 1: resolve video metadata ──────────────────────────────────────
    // Load the real VOD page and capture whatever video API Kick's frontend
    // calls — more reliable than guessing the endpoint (which 404s when Kick
    // changes their API).
    sseWrite(res, { type: "progress", count: 0, status: "Loading VOD page & resolving metadata…" });

    const cap = await session.gotoCapture(rawUrl, { settleMs: 5000 });

    // Look for metadata in captured network JSON first…
    let videoData: VideoData | undefined = cap.responses.find(
      (c) => c.status === 200 && looksLikeVideo(c.json),
    )?.json as VideoData | undefined;

    // …then in embedded page state (Kick may server-render the data)…
    if (!videoData && cap.embedded) {
      const found = findVideoInTree(cap.embedded);
      if (found) videoData = found;
    }

    // …then fall back to known direct endpoints.
    if (!videoData) {
      for (const ep of [
        `https://kick.com/api/v1/video/${parsed.videoId}`,
        `https://kick.com/api/v2/video/${parsed.videoId}`,
      ]) {
        const r = await session.fetchJson(ep);
        if (r.status === 200 && looksLikeVideo(r.json)) {
          videoData = r.json as VideoData;
          break;
        }
      }
    }

    if (!videoData) {
      // Surface everything we saw so we can adapt to Kick's current API.
      const seen = cap.responses
        .map((c) => `${c.status} ${c.url}`)
        .slice(0, 15)
        .join(" | ");
      const embeddedKeys =
        cap.embedded && typeof cap.embedded === "object"
          ? Object.keys(cap.embedded as object).join(",")
          : "none";
      const html = cap.htmlSnippet.replace(/\s+/g, " ").slice(0, 300);
      sseWrite(res, {
        type: "error",
        message:
          `Couldn't find Kick VOD metadata. nav=${cap.navStatus}${cap.navError ? ` navErr=${cap.navError}` : ""} ` +
          `title="${cap.title}" embedded=${embeddedKeys} ` +
          `failed=${cap.failed.length ? cap.failed.slice(0, 4).join(" ; ") : "none"} ` +
          `responses=${seen || "none"} html="${html}"`,
      });
      throw new Error("no-metadata");
    }

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
