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
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
