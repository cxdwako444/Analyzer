import { ProxyAgent, fetch as undiciFetch } from "undici";

// `Response` from "express" shadows the global fetch Response in route files,
// so expose the global one explicitly here.
export type FetchResponse = globalThis.Response;
export type FetchFn = (url: string, opts?: object) => Promise<FetchResponse>;

/**
 * Normalize a user-supplied proxy string into a URL that ProxyAgent accepts.
 * Supports the common formats people paste from proxy providers:
 *   - http://user:pass@host:port  / socks5://host:port  (already a URL)
 *   - user:pass@host:port         (no scheme)
 *   - host:port
 *   - host:port:user:pass         (Decodo / Smartproxy / Bright Data style)
 * Returns null for empty input.
 */
export function normalizeProxy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Already has a scheme (http://, https://, socks5://, …)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;

  // user:pass@host:port without a scheme
  if (s.includes("@")) return `http://${s}`;

  const parts = s.split(":");
  if (parts.length === 2) {
    const [host, port] = parts;
    return `http://${host}:${port}`;
  }
  if (parts.length >= 4) {
    // host:port:user:pass  (password may itself contain ":")
    const [host, port, user, ...rest] = parts;
    const pass = rest.join(":");
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Fallback: treat as host[:port] and prepend a scheme
  return `http://${s}`;
}

/**
 * Build a fetch function that routes through `rawProxy` when provided, else uses
 * the platform fetch. Returns the normalized proxy URL too (for error messages).
 */
export function makeFetcher(rawProxy: string | null | undefined): {
  fetch: FetchFn;
  proxyUrl: string | null;
} {
  const proxyUrl = normalizeProxy(rawProxy);
  if (!proxyUrl) {
    return {
      fetch: (url, opts) => fetch(url, opts as RequestInit),
      proxyUrl: null,
    };
  }
  const agent = new ProxyAgent(proxyUrl);
  const fn: FetchFn = async (url, opts) => {
    const resp = await undiciFetch(url, {
      ...(opts ?? {}),
      dispatcher: agent,
    });
    // undici's response is Fetch API compatible
    return resp as unknown as FetchResponse;
  };
  return { fetch: fn, proxyUrl };
}
