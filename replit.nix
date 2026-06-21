{ pkgs }: {
  # System packages for the Repl. `chromium` is needed by the Kick chat
  # fetcher, which drives a headless browser (via playwright-core) to pass
  # Cloudflare. playwright-core uses the Chromium on PATH — no browser
  # download required.
  deps = [
    pkgs.chromium
  ];
}
