import { Router } from "express";
import type { Request, Response } from "express";
import { makeFetcher, type FetchResponse } from "../lib/proxy";

const router = Router();

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://kick.com/",
  Origin: "https://kick.com",
  "sec-ch-ua": '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

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

  const { fetch: kickFetch, proxyUrl } = makeFetcher(
    typeof rawProxy === "string" ? rawProxy : null,
  );

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

  try {
    // ── Step 1: resolve video metadata ──────────────────────────────────────
    sseWrite(res, { type: "progress", count: 0, status: "Resolving VOD metadata…" });

    let videoResp: FetchResponse;
    try {
      videoResp = await kickFetch(
        `https://kick.com/api/v1/video/${parsed.videoId}`,
        {
          headers: BROWSER_HEADERS,
          signal: AbortSignal.timeout(20_000),
        }
      );
    } catch (err) {
      const msg = proxyUrl
        ? `Could not reach Kick API through proxy (${proxyUrl}): ${String(err)}`
        : `Could not reach Kick API: ${String(err)}. Kick requires a proxy to bypass Cloudflare — paste one in the Proxy field.`;
      sseWrite(res, { type: "error", message: msg });
      res.end();
      return;
    }

    if (videoResp.status === 403 || videoResp.status === 429 || videoResp.status === 503) {
      sseWrite(res, {
        type: "error",
        message: `Kick returned HTTP ${videoResp.status} — Cloudflare blocked the request. ${
          proxyUrl
            ? "Try a different proxy or a residential IP."
            : "Add a proxy in the Kick panel to bypass Cloudflare."
        }`,
      });
      res.end();
      return;
    }

    if (!videoResp.ok) {
      sseWrite(res, {
        type: "error",
        message: `Kick API returned HTTP ${videoResp.status}. Check the VOD URL.`,
      });
      res.end();
      return;
    }

    let videoData: {
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
    try {
      videoData = (await videoResp.json()) as typeof videoData;
    } catch {
      sseWrite(res, { type: "error", message: "Could not parse Kick video metadata JSON." });
      res.end();
      return;
    }

    // Kick's video API can wrap data in `livestream` key
    const channelSlug =
      videoData.channel?.slug ??
      videoData.livestream?.channel?.slug ??
      parsed.channel;

    if (!channelSlug) {
      sseWrite(res, {
        type: "error",
        message: "Could not determine the channel from Kick video metadata. Check the VOD URL.",
      });
      res.end();
      return;
    }

    const rawStartTime =
      videoData.start_time ?? videoData.livestream?.start_time;
    const durationSecs =
      (videoData.duration ?? videoData.livestream?.duration ?? 0) / 1000;

    // start_time is ISO string; convert to unix seconds
    const startUnix = rawStartTime ? Date.parse(rawStartTime) / 1000 : 0;

    if (durationSecs <= 0) {
      sseWrite(res, {
        type: "error",
        message: "Could not determine VOD duration from Kick metadata.",
      });
      res.end();
      return;
    }

    // ── Step 2: page through chat replay in 2-min windows ────────────────
    const WINDOW = 120; // seconds per chunk request
    const totalWindows = Math.ceil(durationSecs / WINDOW);
    sseWrite(res, {
      type: "progress",
      count: 0,
      status: `Fetching chat for a ${Math.round(durationSecs / 60)}-min VOD…`,
    });

    for (let w = 0; w < totalWindows && !req.destroyed; w++) {
      const windowStart = startUnix + w * WINDOW;
      const windowEnd = windowStart + WINDOW;

      let chunkResp: FetchResponse;
      try {
        const url =
          `https://kick.com/api/v2/channels/${channelSlug}/messages` +
          `?start_time=${Math.floor(windowStart)}&end_time=${Math.floor(windowEnd)}`;
        chunkResp = await kickFetch(url, {
          headers: BROWSER_HEADERS,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        sseWrite(res, {
          type: "error",
          message: `Kick request failed${proxyUrl ? " through proxy" : ""}: ${String(err)}`,
        });
        res.end();
        return;
      }

      if (chunkResp.status === 403 || chunkResp.status === 503) {
        sseWrite(res, {
          type: "ratelimit",
          message: `Kick returned HTTP ${chunkResp.status} — Cloudflare blocked the chat request. Analyzing the ${messages.length} messages fetched so far.`,
          count: messages.length,
        });
        break;
      }

      if (!chunkResp.ok) {
        // Non-fatal: skip this window and continue
        await sleep(500);
        continue;
      }

      let chunkData: {
        data?: Array<{
          created_at?: string;
          content?: string;
          sender?: { username?: string };
        }>;
      };
      try {
        chunkData = (await chunkResp.json()) as typeof chunkData;
      } catch {
        await sleep(300);
        continue;
      }

      const rows = chunkData.data ?? [];
      for (const row of rows) {
        const user = row.sender?.username ?? "";
        const text = row.content ?? "";
        const createdAt = row.created_at ? Date.parse(row.created_at) / 1000 : windowStart;
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
    sseWrite(res, { type: "error", message: String(err) });
  } finally {
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
