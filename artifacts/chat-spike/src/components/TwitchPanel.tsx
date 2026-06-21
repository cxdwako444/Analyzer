import { useState } from "react";
import { Tv2, Play, Loader2, AlertTriangle, CheckCircle2, X } from "lucide-react";

interface TwitchPanelProps {
  onFetch: (videoId: string, proxy: string) => void;
  isFetching: boolean;
  progress: { count: number; status?: string } | null;
  warning: string | null;
  onClearWarning: () => void;
}

export default function TwitchPanel({
  onFetch,
  isFetching,
  progress,
  warning,
  onClearWarning,
}: TwitchPanelProps) {
  const [url, setUrl] = useState("");
  const [proxy, setProxy] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = extractId(url.trim());
    if (id) onFetch(id, proxy.trim());
  }

  function extractId(raw: string): string {
    const m = raw.match(/(?:twitch\.tv\/videos?\/)(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(raw)) return raw;
    return "";
  }

  const idOk = !!extractId(url.trim());

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Tv2 size={15} className="text-purple-400" />
        <span className="text-sm font-semibold text-white/70">Twitch VOD URL</span>
      </div>

      <div className="flex flex-col gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.twitch.tv/videos/123456789"
          disabled={isFetching}
          className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-purple-500/40 focus:bg-white/[0.06] disabled:opacity-50 transition-colors font-mono"
        />
        <p className="text-xs text-white/25 leading-relaxed">
          Paste a full Twitch VOD URL or bare video ID. Chat is fetched from Twitch's API — no login needed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-white/40 uppercase tracking-wider">
          Proxy{" "}
          <span className="text-white/20 normal-case tracking-normal">(recommended for full VODs)</span>
        </label>
        <input
          type="text"
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          placeholder="host:port:user:pass or http://user:pass@host:port"
          disabled={isFetching}
          className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-purple-500/40 focus:bg-white/[0.06] disabled:opacity-50 transition-colors font-mono"
        />
        <p className="text-xs text-white/25 leading-relaxed">
          On cloud hosts (Replit) Twitch bot-checks after ~1 page. A residential proxy fetches the whole VOD. Leave blank to try without.
        </p>
      </div>

      {/* Warning banner */}
      {warning && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300 leading-relaxed flex-1">{warning}</p>
          <button
            type="button"
            onClick={onClearWarning}
            className="text-amber-400/50 hover:text-amber-400 transition-colors shrink-0"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Progress */}
      {isFetching && progress !== null && (
        <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2.5">
          <Loader2 size={13} className="animate-spin text-purple-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/60 tabular-nums">
              {progress.count.toLocaleString()} messages fetched…
            </p>
            {progress.status && (
              <p className="text-xs text-white/30 truncate">{progress.status}</p>
            )}
          </div>
        </div>
      )}

      {!isFetching && progress !== null && progress.count > 0 && (
        <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5">
          <CheckCircle2 size={13} className="text-green-400 shrink-0" />
          <p className="text-xs text-green-300">
            Fetched {progress.count.toLocaleString()} messages — analyzing…
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={!idOk || isFetching}
        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm transition-all bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg shadow-purple-900/30"
      >
        {isFetching ? (
          <><Loader2 size={15} className="animate-spin" /> Fetching chat…</>
        ) : (
          <><Play size={15} /> Fetch & Analyze</>
        )}
      </button>
    </form>
  );
}
