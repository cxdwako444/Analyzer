import { useState } from "react";
import { Zap, Play, Loader2, AlertTriangle, CheckCircle2, X, ShieldAlert } from "lucide-react";

interface KickPanelProps {
  onFetch: (vodUrl: string, proxy: string) => void;
  isFetching: boolean;
  progress: { count: number; status?: string } | null;
  warning: string | null;
  onClearWarning: () => void;
}

export default function KickPanel({
  onFetch,
  isFetching,
  progress,
  warning,
  onClearWarning,
}: KickPanelProps) {
  const [vodUrl, setVodUrl] = useState("");
  const [proxy, setProxy] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (vodUrl.trim()) onFetch(vodUrl.trim(), proxy.trim());
  }

  const urlOk = vodUrl.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Zap size={15} className="text-green-400" />
        <span className="text-sm font-semibold text-white/70">Kick VOD</span>
        <span className="text-xs text-white/25 ml-auto">best-effort (Cloudflare)</span>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-white/40 uppercase tracking-wider">VOD URL</label>
          <input
            type="text"
            value={vodUrl}
            onChange={(e) => setVodUrl(e.target.value)}
            placeholder="https://kick.com/channel/videos/uuid"
            disabled={isFetching}
            className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-green-500/40 focus:bg-white/[0.06] disabled:opacity-50 transition-colors font-mono"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-white/40 uppercase tracking-wider">
            Proxy{" "}
            <span className="text-white/20 normal-case tracking-normal">(required to bypass Cloudflare)</span>
          </label>
          <input
            type="text"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://user:pass@host:port"
            disabled={isFetching}
            className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-green-500/40 focus:bg-white/[0.06] disabled:opacity-50 transition-colors font-mono"
          />
          <p className="text-xs text-white/25 leading-relaxed">
            Kick uses Cloudflare. Without a residential proxy the request will likely be blocked. Leave blank to try anyway.
          </p>
        </div>
      </div>

      {/* Cloudflare notice */}
      <div className="flex items-start gap-2 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
        <ShieldAlert size={13} className="text-white/25 shrink-0 mt-0.5" />
        <p className="text-xs text-white/30 leading-relaxed">
          Kick's chat replay API is undocumented. Results depend on Cloudflare clearance and proxy quality. If blocked, the error will explain why.
        </p>
      </div>

      {/* Warning */}
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
          <Loader2 size={13} className="animate-spin text-green-400 shrink-0" />
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
        disabled={!urlOk || isFetching}
        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm transition-all bg-green-800 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg shadow-green-900/30"
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
