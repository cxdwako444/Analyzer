import { useState, useCallback, useRef } from "react";
import {
  BarChart2,
  MessageSquare,
  Settings2,
  Flame,
  Activity,
  Tv2,
  Zap,
} from "lucide-react";
import ChatInput from "./components/ChatInput";
import TwitchPanel from "./components/TwitchPanel";
import KickPanel from "./components/KickPanel";
import ActivityChart from "./components/ActivityChart";
import SpikeList from "./components/SpikeList";
import ViralMoments from "./components/ViralMoments";
import { parseChat, analyzeChat, buildMessagesFromApi } from "./lib/chatParser";
import { streamFetch } from "./lib/sseStream";
import type { AnalysisResult } from "./lib/chatParser";

const BUCKET_SIZES = [5, 10, 15, 30, 60, 120];
type InputMode = "file" | "twitch" | "kick";
type ResultTab = "timeline" | "virality";

// BUILD_VERSION — bump this on EVERY change so the banner at the top of the
// screen visibly confirms a new version is live after each deploy.
const BUILD_VERSION = "v16 · 2026-06-21 · Kick VOD matched by UUID + object dump";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 bg-white/[0.04] rounded-xl px-4 py-3 border border-white/[0.06]">
      <span className="text-xs text-white/35 uppercase tracking-wider">{label}</span>
      <span className="text-xl font-bold text-white tabular-nums">{value}</span>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active
          ? `bg-white/[0.08] ${color} shadow`
          : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export default function App() {
  const [inputMode, setInputMode] = useState<InputMode>("file");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [keywords, setKeywords] = useState("");
  const [bucketSize, setBucketSize] = useState<number | undefined>(undefined);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMessages, setLastMessages] = useState<ReturnType<typeof parseChat>>([]);
  const [activeTab, setActiveTab] = useState<ResultTab>("timeline");

  // Fetch progress state (Twitch/Kick)
  const [twitchProgress, setTwitchProgress] = useState<{ count: number; status?: string } | null>(null);
  const [kickProgress, setKickProgress] = useState<{ count: number; status?: string } | null>(null);
  const [twitchFetching, setTwitchFetching] = useState(false);
  const [kickFetching, setKickFetching] = useState(false);
  const [twitchWarning, setTwitchWarning] = useState<string | null>(null);
  const [kickWarning, setKickWarning] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  function runAnalysis(messages: ReturnType<typeof parseChat>) {
    setLastMessages(messages);
    if (messages.length === 0) {
      setError("No messages with recognizable timestamps found.");
      setResult(null);
      setIsAnalyzing(false);
      return;
    }
    const analysis = analyzeChat(messages, keywords, bucketSize);
    setResult(analysis);
    setIsAnalyzing(false);
  }

  // ── CSV / text file analysis ─────────────────────────────────────────────
  const handleFileAnalyze = useCallback(
    (text: string) => {
      setIsAnalyzing(true);
      setError(null);
      setTimeout(() => {
        try {
          const messages = parseChat(text);
          runAnalysis(messages);
        } catch (e) {
          setError("Something went wrong parsing the chat. Check the format.");
          console.error(e);
          setIsAnalyzing(false);
        }
      }, 50);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keywords, bucketSize]
  );

  // ── Twitch fetch ──────────────────────────────────────────────────────────
  const handleTwitchFetch = useCallback(
    async (videoId: string, proxy: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setTwitchFetching(true);
      setTwitchProgress({ count: 0 });
      setTwitchWarning(null);
      setError(null);
      setResult(null);
      setIsAnalyzing(false);

      const params = new URLSearchParams({ videoId });
      if (proxy) params.set("proxy", proxy);

      try {
        const raw = await streamFetch(`/api/twitch-chat?${params.toString()}`, {
          onProgress: (count, status) => setTwitchProgress({ count, status }),
          onWarning: (msg) => setTwitchWarning(msg),
          signal: ctrl.signal,
        });

        setTwitchProgress({ count: raw.length });
        setTwitchFetching(false);

        if (raw.length === 0) {
          setError("No messages were fetched from Twitch.");
          return;
        }

        setIsAnalyzing(true);
        setTimeout(() => {
          try {
            const messages = buildMessagesFromApi(raw);
            runAnalysis(messages);
          } catch (e) {
            setError("Error building analysis from fetched data.");
            console.error(e);
            setIsAnalyzing(false);
          }
        }, 50);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(String(e));
        setTwitchFetching(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keywords, bucketSize]
  );

  // ── Kick fetch ────────────────────────────────────────────────────────────
  const handleKickFetch = useCallback(
    async (vodUrl: string, proxy: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setKickFetching(true);
      setKickProgress({ count: 0 });
      setKickWarning(null);
      setError(null);
      setResult(null);
      setIsAnalyzing(false);

      const params = new URLSearchParams({ url: vodUrl });
      if (proxy) params.set("proxy", proxy);

      try {
        const raw = await streamFetch(`/api/kick-chat?${params.toString()}`, {
          onProgress: (count, status) => setKickProgress({ count, status }),
          onWarning: (msg) => setKickWarning(msg),
          signal: ctrl.signal,
        });

        setKickProgress({ count: raw.length });
        setKickFetching(false);

        if (raw.length === 0) {
          setError("No messages were fetched from Kick.");
          return;
        }

        setIsAnalyzing(true);
        setTimeout(() => {
          try {
            const messages = buildMessagesFromApi(raw);
            runAnalysis(messages);
          } catch (e) {
            setError("Error building analysis from fetched Kick data.");
            console.error(e);
            setIsAnalyzing(false);
          }
        }, 50);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(String(e));
        setKickFetching(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keywords, bucketSize]
  );

  // ── Re-analyze with current settings ─────────────────────────────────────
  const handleReanalyze = useCallback(() => {
    if (!lastMessages.length) return;
    setIsAnalyzing(true);
    setError(null);
    setTimeout(() => {
      const analysis = analyzeChat(lastMessages, keywords, bucketSize);
      setResult(analysis);
      setIsAnalyzing(false);
    }, 50);
  }, [lastMessages, keywords, bucketSize]);

  function formatDuration(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  const isBusy = isAnalyzing || twitchFetching || kickFetching;

  return (
    <div className="min-h-screen bg-[#0e0e1a] text-white">
      {/* Update banner — confirms a fresh deploy is live (see BUILD_VERSION) */}
      <div className="w-full bg-emerald-500 text-black text-center text-xs font-bold py-1.5 px-2 tracking-wide">
        ✅ UPDATED — {BUILD_VERSION}
      </div>

      {/* Header */}
      <header className="border-b border-white/[0.06] bg-[#0e0e1a]/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <BarChart2 size={20} className="text-violet-400" />
          <span className="font-bold text-sm tracking-tight">Chat Spike Analyzer</span>
          <span className="ml-1 text-xs text-white/30 hidden sm:inline">
            — find the hype moments in your stream
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">

        {/* ── Input area ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_300px] gap-4">

          {/* Left: CSV / Twitch panels (tabbed) */}
          <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-4">
            {/* Mode tabs */}
            <div className="flex gap-1">
              <ModeTab
                active={inputMode === "file"}
                onClick={() => setInputMode("file")}
                icon={<MessageSquare size={13} />}
                label="Upload / Paste"
                color="text-violet-300"
              />
              <ModeTab
                active={inputMode === "twitch"}
                onClick={() => setInputMode("twitch")}
                icon={<Tv2 size={13} />}
                label="Twitch"
                color="text-purple-300"
              />
            </div>

            {inputMode === "file" && (
              <ChatInput onAnalyze={handleFileAnalyze} isAnalyzing={isAnalyzing} />
            )}
            {inputMode === "twitch" && (
              <TwitchPanel
                onFetch={handleTwitchFetch}
                isFetching={twitchFetching}
                progress={twitchProgress}
                warning={twitchWarning}
                onClearWarning={() => setTwitchWarning(null)}
              />
            )}
          </div>

          {/* Middle: Kick panel (always visible as its own section) */}
          <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5">
            <KickPanel
              onFetch={handleKickFetch}
              isFetching={kickFetching}
              progress={kickProgress}
              warning={kickWarning}
              onClearWarning={() => setKickWarning(null)}
            />
          </div>

          {/* Right: Options */}
          <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Settings2 size={15} className="text-white/40" />
              <h2 className="text-sm font-semibold text-white/70">Options</h2>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs text-white/50 uppercase tracking-wider">
                Keyword tracking
              </label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. W, LMAO, PogChamp"
                className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-violet-500/40 focus:bg-white/[0.06] transition-colors"
              />
              <p className="text-xs text-white/25 leading-relaxed">
                Comma-separated. Each keyword gets its own chart line and peak list.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs text-white/50 uppercase tracking-wider">
                Time bucket
              </label>
              <div className="flex gap-1.5 flex-wrap">
                <button
                  onClick={() => setBucketSize(undefined)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    bucketSize === undefined
                      ? "bg-violet-600 text-white"
                      : "bg-white/[0.05] text-white/40 hover:bg-white/[0.09]"
                  }`}
                >
                  Auto
                </button>
                {BUCKET_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setBucketSize(s)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      bucketSize === s
                        ? "bg-violet-600 text-white"
                        : "bg-white/[0.05] text-white/40 hover:bg-white/[0.09]"
                    }`}
                  >
                    {s >= 60 ? `${s / 60}m` : `${s}s`}
                  </button>
                ))}
              </div>
            </div>

            {lastMessages.length > 0 && (
              <button
                onClick={handleReanalyze}
                disabled={isBusy}
                className="mt-auto flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Re-analyze with new settings
              </button>
            )}
          </div>
        </div>

        {/* ── Error ──────────────────────────────────────────────────────────── */}
        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* ── Results ────────────────────────────────────────────────────────── */}
        {result && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Messages" value={result.totalMessages.toLocaleString()} />
              <StatCard label="Duration" value={formatDuration(result.duration)} />
              <StatCard label="Bucket size" value={`${result.bucketSize}s`} />
              <StatCard label="Spikes found" value={result.spikes.length} />
            </div>

            {/* Result tab bar */}
            <div className="flex gap-1 bg-white/[0.04] p-1 rounded-xl border border-white/[0.06] self-start">
              <button
                onClick={() => setActiveTab("timeline")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === "timeline"
                    ? "bg-violet-600 text-white shadow-lg"
                    : "text-white/40 hover:text-white/70 hover:bg-white/[0.05]"
                }`}
              >
                <Activity size={14} />
                Timeline & Spikes
              </button>
              <button
                onClick={() => setActiveTab("virality")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === "virality"
                    ? "bg-violet-600 text-white shadow-lg"
                    : "text-white/40 hover:text-white/70 hover:bg-white/[0.05]"
                }`}
              >
                <Flame size={14} />
                Virality Score
                {result.viralMoments.length > 0 && (
                  <span className="bg-white/10 text-white/60 text-xs px-1.5 py-0.5 rounded-md tabular-nums">
                    {result.viralMoments.length}
                  </span>
                )}
              </button>
            </div>

            {activeTab === "timeline" && (
              <>
                <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h2 className="text-sm font-semibold text-white/70">Activity Timeline</h2>
                    <div className="flex items-center gap-3 text-xs text-white/30 flex-wrap">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-0.5 rounded bg-violet-500 inline-block" />
                        Chat activity
                      </span>
                      {result.keywords.map((kw, i) => (
                        <span key={kw} className="flex items-center gap-1.5">
                          <span
                            className="w-3 h-0.5 rounded inline-block"
                            style={{
                              background: ["#f472b6","#34d399","#fbbf24","#60a5fa","#a78bfa","#fb923c","#2dd4bf"][i % 7],
                            }}
                          />
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ActivityChart result={result} />
                </div>

                <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5">
                  <SpikeList
                    spikes={result.spikes}
                    keywordSpikes={result.keywordSpikes}
                    keywords={result.keywords}
                  />
                </div>
              </>
            )}

            {activeTab === "virality" && (
              <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-white/70 flex items-center gap-2">
                    <Flame size={15} className="text-orange-400" />
                    Top Viral Moments
                  </h2>
                  <p className="text-xs text-white/30 mt-1 leading-relaxed max-w-xl">
                    0–100 clip-worthiness per {result.bucketSize}s window — chat-speed surge (45%), distinct-chatter surge (30%), hype-token density (25%), each normalized to this stream's peak.
                  </p>
                </div>
                <ViralMoments moments={result.viralMoments} bucketSize={result.bucketSize} />
              </div>
            )}
          </>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────────── */}
        {!result && !error && !isBusy && (
          <div className="text-center py-16 text-white/20">
            <BarChart2 size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Upload a CSV, paste chat, or fetch a VOD above to analyze</p>
            <div className="flex items-center justify-center gap-4 mt-3 text-xs text-white/15">
              <span className="flex items-center gap-1"><MessageSquare size={11} /> CSV / text log</span>
              <span className="flex items-center gap-1"><Tv2 size={11} /> Twitch VOD URL</span>
              <span className="flex items-center gap-1"><Zap size={11} /> Kick VOD + proxy</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
