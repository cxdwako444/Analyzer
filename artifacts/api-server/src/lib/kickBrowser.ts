import { execSync } from "node:child_process";
import { normalizeProxy } from "./proxy";

/**
 * A headless-browser session pointed at kick.com. Loading the site in a real
 * Chromium passes Cloudflare (correct TLS fingerprint + JS challenge solved),
 * after which same-origin `fetch()` calls to Kick's API carry the cf_clearance
 * cookie and succeed where a plain server fetch gets a 403.
 */
export interface KickBrowserSession {
  fetchJson(url: string): Promise<{ status: number; json: unknown | null; text: string }>;
  /**
   * Navigate to `url`, give any Cloudflare challenge time to resolve, and
   * capture rich diagnostics about what actually loaded.
   */
  gotoCapture(
    url: string,
    opts?: { settleMs?: number },
  ): Promise<{
    responses: Array<{ url: string; status: number; contentType: string; json: unknown | null }>;
    failed: string[];
    navStatus: number;
    navError: string;
    htmlSnippet: string;
    pageUrl: string;
    title: string;
    embedded: unknown | null;
  }>;
  /**
   * Start VOD playback and capture any chat/message/replay request URLs the
   * page fires — so we can discover Kick's current chat-replay endpoint.
   */
  captureChatRequests(seconds?: number): Promise<string[]>;
  close(): Promise<void>;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Find a Chromium binary to drive. Prefers an explicit env override, otherwise
 * looks for a system Chromium on PATH — which is how Replit/Nix exposes it.
 * We use playwright-core (no bundled browser), so a path is required.
 */
function resolveChromiumPath(): string | undefined {
  const env =
    process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ||
    process.env["CHROMIUM_EXECUTABLE_PATH"];
  if (env) return env;

  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
  ]) {
    try {
      const p = execSync(`which ${name}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (p) return p;
    } catch {
      /* not on PATH, try next */
    }
  }
  return undefined;
}

/** Convert our normalized proxy URL into Playwright's proxy option shape. */
function toPlaywrightProxy(rawProxy: string | null | undefined) {
  const normalized = normalizeProxy(rawProxy);
  if (!normalized) return undefined;
  const u = new URL(normalized);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

export async function openKickSession(
  opts: { proxy?: string | null } = {},
): Promise<KickBrowserSession> {
  // Dynamic import so a missing install doesn't crash the server at boot —
  // only the Kick route needs it. playwright-core has no bundled browser, so
  // we drive a system Chromium (Replit/Nix provides one on PATH).
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error(
      "Headless browser support isn't installed (playwright-core missing). Run `pnpm install`.",
    );
  }

  const executablePath = resolveChromiumPath();
  if (!executablePath) {
    throw new Error(
      "No Chromium found. On Replit, add the `chromium` system package (Nix) — " +
        "tell the Replit Agent to add chromium — or set CHROMIUM_EXECUTABLE_PATH to a Chromium binary.",
    );
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  } catch (err) {
    throw new Error(
      `Could not launch Chromium at ${executablePath}: ${String(err)}. ` +
        "On Replit make sure the chromium Nix package is installed.",
    );
  }

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    proxy: toPlaywrightProxy(opts.proxy),
  });
  const page = await context.newPage();

  // Prime Cloudflare clearance by loading the site, then give any JS challenge
  // a moment to resolve before we start hitting the API.
  await page.goto("https://kick.com/", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(3500);

  return {
    async fetchJson(url: string) {
      const result = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, {
            headers: { Accept: "application/json, text/plain, */*" },
            credentials: "include",
          });
          const t = await r.text();
          return { status: r.status, text: t };
        } catch (e) {
          return { status: 0, text: String(e) };
        }
      }, url);

      let json: unknown = null;
      try {
        json = JSON.parse(result.text);
      } catch {
        /* not JSON (e.g. a Cloudflare HTML challenge page) */
      }
      return { status: result.status, json, text: result.text };
    },
    async gotoCapture(url: string, opts: { settleMs?: number } = {}) {
      const responses: Array<{
        url: string;
        status: number;
        contentType: string;
        json: unknown | null;
      }> = [];
      const failed: string[] = [];
      const handler = (resp: {
        url(): string;
        status(): number;
        headers(): Record<string, string>;
        text(): Promise<string>;
      }) => {
        const u = resp.url();
        const ct = (resp.headers()["content-type"] ?? "").toLowerCase();
        // Skip only heavy static assets; keep documents + data/XHR responses.
        if (/\.(css|png|jpe?g|gif|svg|webp|woff2?|ico|mp4|ts|m3u8)(\?|$)/i.test(u))
          return;
        const isJson = ct.includes("json");
        void resp
          .text()
          .then((t) => {
            let json: unknown = null;
            if (isJson) {
              try {
                json = JSON.parse(t);
              } catch {
                /* ignore */
              }
            }
            responses.push({ url: u, status: resp.status(), contentType: ct, json });
          })
          .catch(() => {});
      };
      const failHandler = (req: {
        url(): string;
        failure(): { errorText: string } | null;
      }) => {
        failed.push(`${req.url()} (${req.failure()?.errorText ?? "failed"})`);
      };
      page.on("response", handler);
      page.on("requestfailed", failHandler);
      let navStatus = 0;
      let navError = "";
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        navStatus = resp ? resp.status() : 0;
      } catch (e) {
        navError = String(e);
      }
      // Give a Cloudflare JS challenge time to clear: poll until the title is
      // real (not a challenge interstitial) or we time out.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const t = await page.title().catch(() => "");
        if (t && !/just a moment|attention required|checking your browser/i.test(t))
          break;
        await page.waitForTimeout(1000);
      }
      try {
        await page.waitForTimeout(opts.settleMs ?? 3000);
      } finally {
        page.off("response", handler);
        page.off("requestfailed", failHandler);
      }
      const htmlSnippet = (await page.content().catch(() => "")).slice(0, 700);

      // Many SPA frameworks embed initial state in the HTML — grab common spots.
      const embedded = await page
        .evaluate(() => {
          // Runs in the browser; access DOM/window via globalThis to keep the
          // Node typechecker happy without pulling in the DOM lib.
          const g = globalThis as unknown as Record<string, unknown> & {
            document?: {
              querySelectorAll(sel: string): Array<{ textContent: string | null }>;
            };
          };
          const out: Record<string, unknown> = {};
          for (const key of ["__NEXT_DATA__", "__NUXT__", "__remixContext"]) {
            if (g[key]) out[key] = g[key];
          }
          // Next.js App Router streams server data into self.__next_f as an
          // array of chunks — concatenate the string payloads so we can mine
          // the SSR'd video metadata without hitting a reCAPTCHA-gated API.
          try {
            const nf = g["__next_f"];
            if (Array.isArray(nf)) {
              let flight = "";
              for (const it of nf) {
                if (Array.isArray(it) && typeof it[1] === "string") flight += it[1];
                else if (typeof it === "string") flight += it;
              }
              if (flight) out["flight"] = flight.slice(0, 800_000);
            }
          } catch {
            /* ignore */
          }
          const nodes = g.document
            ? Array.from(g.document.querySelectorAll('script[type="application/json"]'))
            : [];
          const jsonScripts = nodes
            .map((s) => s.textContent || "")
            .filter(Boolean)
            .slice(0, 5);
          if (jsonScripts.length) out["jsonScripts"] = jsonScripts;
          return out;
        })
        .catch(() => null);

      const pageUrl = page.url();
      const title = await page.title().catch(() => "");
      return { responses, failed, navStatus, navError, htmlSnippet, pageUrl, title, embedded };
    },
    async captureChatRequests(seconds = 12) {
      const urls = new Set<string>();
      const handler = (resp: { url(): string; status(): number }) => {
        const u = resp.url();
        if (/message|chat|comment|replay/i.test(u)) {
          urls.add(`${resp.status()} ${u}`);
        }
      };
      page.on("response", handler);
      try {
        // Try to start playback (autoplay is usually blocked until muted).
        await page
          .evaluate(() => {
            const g = globalThis as unknown as {
              document?: {
                querySelector(s: string): {
                  muted?: boolean;
                  play?: () => unknown;
                  click?: () => unknown;
                } | null;
              };
            };
            const v = g.document?.querySelector("video");
            if (v) {
              v.muted = true;
              v.play?.();
            }
            const btn =
              g.document?.querySelector('[data-testid*="play"]') ||
              g.document?.querySelector('button[aria-label*="lay"]');
            btn?.click?.();
          })
          .catch(() => {});
        await page.waitForTimeout(seconds * 1000);
      } finally {
        page.off("response", handler);
      }
      return [...urls];
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
