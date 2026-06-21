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

  // Walk outward from `idx` to the smallest balanced {…} object containing it.
  function enclosingObject(text: string, idx: number): string | null {
    let start = -1;
    let depth = 0;
    for (let i = idx; i >= 0; i--) {
      const c = text[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) return null;
    let d = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // Find the object that IS the VOD, matched by its UUID (avoids matching the
  // channel object, which also has a `livestream` field).
  function findByUuid(node: unknown, uuid: string, depth = 0): VideoData | undefined {
    if (depth > 8 || !node || typeof node !== "object") return undefined;
    const o = node as Record<string, unknown>;
    if (o["uuid"] === uuid || o["id"] === uuid) return o as VideoData;
    for (const v of Object.values(o)) {
      const f = findByUuid(v, uuid, depth + 1);
      if (f) return f;
    }
    return undefined;
  }

  // Deep-search a (VOD-scoped) object for a numeric/string field by name.
  function deepNumber(node: unknown, key: string, depth = 0): number | undefined {
    if (depth > 6 || !node || typeof node !== "object") return undefined;
    const o = node as Record<string, unknown>;
    if (typeof o[key] === "number") return o[key] as number;
    for (const v of Object.values(o)) {
      const f = deepNumber(v, key, depth + 1);
      if (f != null) return f;
    }
    return undefined;
  }
  function deepString(node: unknown, keys: string[], depth = 0): string | undefined {
    if (depth > 6 || !node || typeof node !== "object") return undefined;
    const o = node as Record<string, unknown>;
    for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
    for (const v of Object.values(o)) {
      const f = deepString(v, keys, depth + 1);
      if (f) return f;
    }
    return undefined;
  }
  function extractVideoFromFlight(
    flight: string,
    videoId: string,
  ): { data?: VideoData; rawSnippet: string } {
    const uidx = flight.indexOf(videoId);
    if (uidx >= 0) {
      const obj = enclosingObject(flight, uidx);
      if (obj) {
        try {
          const p = JSON.parse(obj) as Record<string, unknown> & {
            duration?: number;
            start_time?: string;
            created_at?: string;
            channel?: { slug?: string };
            livestream?: {
              duration?: number;
              start_time?: string;
              created_at?: string;
              channel?: { slug?: string };
            };
          };
          const ls = p.livestream ?? {};
          const duration = p.duration ?? ls.duration;
          const start_time =
            p.start_time ?? ls.start_time ?? p.created_at ?? ls.created_at;
          const slug = p.channel?.slug ?? ls.channel?.slug;
          if (duration != null) {
            return {
              data: {
                duration: Number(duration),
                start_time,
                channel: slug ? { slug } : undefined,
              },
              rawSnippet: obj.slice(0, 500),
            };
          }
        } catch {
          /* fall through to regex */
        }
        // Regex within the located object — far more accurate than whole-page.
        const dur = obj.match(/"duration":\s*(\d+(?:\.\d+)?)/);
        const start =
          obj.match(/"start_time":"([^"]+)"/) ||
          obj.match(/"created_at":"([^"]+)"/);
        const slug = obj.match(/"slug":"([^"]+)"/);
        if (dur) {
          return {
            data: {
              duration: Number(dur[1]),
              start_time: start?.[1],
              channel: slug ? { slug: slug[1] } : undefined,
            },
            rawSnippet: obj.slice(0, 500),
          };
        }
        return { rawSnippet: obj.slice(0, 500) };
      }
    }
    return { rawSnippet: "" };
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

    // …then mine the Next.js flight data (SSR'd text) — Kick's data API is
    // reCAPTCHA-gated, but the page itself ships the video metadata.
    const flight =
      cap.embedded &&
      typeof (cap.embedded as Record<string, unknown>)["flight"] === "string"
        ? ((cap.embedded as Record<string, unknown>)["flight"] as string)
        : "";
    let flightSnippet = "";
    if (!videoData && flight) {
      const r = extractVideoFromFlight(flight, parsed.videoId);
      flightSnippet = r.rawSnippet;
      if (r.data) videoData = r.data;
    }

    // …then probe candidate Kick API endpoints from inside the browser. The
    // API is reachable there (a prior probe returned a JSON 500, not a 403);
    // we just need the current video endpoint since api/v1/video/{uuid} 404s.
    const probeResults: string[] = [];
    let metaSource = videoData ? "flight" : "";
    let metaRaw = "";
    if (!videoData) {
      const slug = parsed.channel || "";
      // Videos-list first (contains the VOD with duration); channel object is
      // intentionally NOT used here — it isn't the VOD.
      const candidates = [
        ...(slug
          ? [
              `https://kick.com/api/v2/channels/${slug}/videos/${parsed.videoId}`,
              `https://kick.com/api/v1/channels/${slug}/videos/${parsed.videoId}`,
              `https://kick.com/api/v2/channels/${slug}/videos`,
            ]
          : []),
        `https://kick.com/api/v1/video/${parsed.videoId}`,
        `https://kick.com/api/v2/video/${parsed.videoId}`,
      ];
      for (const ep of candidates) {
        const r = await session.fetchJson(ep);
        probeResults.push(`${r.status} ${ep.replace("https://kick.com", "")}`);
        if (r.status === 200 && r.json) {
          // Strict: only the object whose uuid matches this VOD.
          const match = findByUuid(r.json, parsed.videoId);
          if (match) {
            videoData = match;
            metaSource = ep.replace("https://kick.com", "");
            metaRaw = JSON.stringify(match).slice(0, 600);
            break;
          }
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
      const html = cap.htmlSnippet.replace(/\s+/g, " ").slice(0, 120);
      // Find the uuid in flight to show the region around it (real video data).
      const uidx = flight.indexOf(parsed.videoId);
      const flightInfo = flight
        ? `flightLen=${flight.length} ${
            uidx >= 0
              ? `near-uuid="${flight.slice(Math.max(0, uidx - 100), uidx + 300)}"`
              : "uuid-not-in-flight"
          }`
        : "flight=none";
      sseWrite(res, {
        type: "error",
        message:
          `Couldn't find Kick VOD metadata. nav=${cap.navStatus}${cap.navError ? ` navErr=${cap.navError}` : ""} ` +
          `probes=[${probeResults.join(" | ") || "none"}] ` +
          `title="${cap.title}" embedded=${embeddedKeys} ${flightInfo} ` +
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

    // videoData is the VOD object (uuid-matched), so deep-searching its fields
    // is safe and finds duration/start_time wherever Kick nests them.
    const rawStartTime = deepString(videoData, ["start_time", "created_at"]);
    // Kick's duration is sometimes ms, sometimes seconds — normalize by size.
    const rawDuration = deepNumber(videoData, "duration") ?? 0;
    const durationSecs = rawDuration >= 100_000 ? rawDuration / 1000 : rawDuration;
    const startUnix = rawStartTime ? Date.parse(rawStartTime) / 1000 : 0;

    if (durationSecs <= 0) {
      const dump = metaRaw || JSON.stringify(videoData).slice(0, 600);
      sseWrite(res, {
        type: "error",
        message: `Found VOD metadata (source=${metaSource || "?"}) but no usable duration. probes=[${probeResults.join(" | ") || "none"}] object=${dump}`,
      });
      throw new Error("no-duration");
    }

    // ── Discover the real chat-replay endpoint by playing the VOD ────────
    sseWrite(res, {
      type: "progress",
      count: 0,
      status: "Playing VOD to discover the chat endpoint…",
    });
    const discoveredChat = await session.captureChatRequests(12);

    // ── Step 2: page through chat replay in 2-min windows ────────────────
    const WINDOW = 120; // seconds per chunk request
    const totalWindows = Math.ceil(durationSecs / WINDOW);
    sseWrite(res, {
      type: "progress",
      count: 0,
      status: `Fetching chat for a ${Math.round(durationSecs / 60)}-min VOD…`,
    });

    let blockedStreak = 0;
    let firstProbe = "";
    for (let w = 0; w < totalWindows && !req.destroyed; w++) {
      const windowStart = startUnix + w * WINDOW;
      const windowEnd = windowStart + WINDOW;

      const url =
        `https://kick.com/api/v2/channels/${channelSlug}/messages` +
        `?start_time=${Math.floor(windowStart)}&end_time=${Math.floor(windowEnd)}`;
      const chunk = await session.fetchJson(url);
      if (!firstProbe) {
        firstProbe = `status=${chunk.status} body="${chunk.text.replace(/\s+/g, " ").slice(0, 200)}"`;
      }

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

    if (messages.length === 0) {
      // Tell us what the chat endpoint actually did, and what the page itself
      // requested for chat, so we can target the right endpoint.
      const disc = discoveredChat.length
        ? discoveredChat.slice(0, 6).join(" | ")
        : "none";
      sseWrite(res, {
        type: "error",
        message:
          `Got VOD metadata (channel=${channelSlug}, dur=${Math.round(durationSecs)}s, startUnix=${startUnix}) but 0 chat messages. ` +
          `Our probe: ${firstProbe || "n/a"}. Chat requests the page made: ${disc}. ` +
          `videoObj="${flightSnippet.replace(/\s+/g, " ").slice(0, 300)}"`,
      });
      throw new Error("no-chat");
    }

    sseWrite(res, { type: "done", messages, totalCount: messages.length });
  } catch (err) {
    // Errors we surfaced above are thrown to break out; only report unexpected ones.
    const msg = err instanceof Error ? err.message : String(err);
    if (!["blocked", "no-metadata", "no-channel", "no-duration", "no-chat"].includes(msg)) {
      sseWrite(res, { type: "error", message: msg });
    }
  } finally {
    await session.close();
    clearInterval(heartbeat);
  }

  res.end();
});

export default router;
