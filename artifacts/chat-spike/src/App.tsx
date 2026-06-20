import { useState, useCallback } from "react";
import { BarChart2, MessageSquare, Settings2 } from "lucide-react";
import ChatInput from "./components/ChatInput";
import ActivityChart from "./components/ActivityChart";
import SpikeList from "./components/SpikeList";
import { parseChat, analyzeChat } from "./lib/chatParser";
import type { AnalysisResult } from "./lib/chatParser";

const BUCKET_SIZES = [5, 10, 15, 30, 60, 120];

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 bg-white/[0.04] rounded-xl px-4 py-3 border border-white/[0.06]">
      <span className="text-xs text-white/35 uppercase tracking-wider">{label}</span>
      <span className="text-xl font-bold text-white tabular-nums">{value}</span>
    </div>
  );
}

export default function App() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [keywords, setKeywords] = useState("");
  const [bucketSize, setBucketSize] = useState<number | undefined>(undefined);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastText, setLastText] = useState<string>("");

  const handleAnalyze = useCallback(
    (text: string) => {
      setIsAnalyzing(true);
      setError(null);
      setLastText(text);
      setTimeout(() => {
        try {
          const messages = parseChat(text);
          if (messages.length === 0) {
            setError(
              "No messages with recognizable timestamps were found. Check the format — each line should start with a timestamp like [00:01:23], (1:23:45), or HH:MM:SS."
            );
            setResult(null);
          } else {
            const analysis = analyzeChat(messages, keywords, bucketSize);
            setResult(analysis);
          }
        } catch (e) {
          setError("Something went wrong parsing the chat. Please check the format.");
          console.error(e);
        }
        setIsAnalyzing(false);
      }, 50);
    },
    [keywords, bucketSize]
  );

  const handleReanalyze = useCallback(() => {
    if (lastText) handleAnalyze(lastText);
  }, [lastText, handleAnalyze]);

  function formatDuration(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  return (
    <div className="min-h-screen bg-[#0e0e1a] text-white">
      {/* Header */}
      <header className="border-b border-white/[0.06] bg-[#0e0e1a]/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <BarChart2 size={20} className="text-violet-400" />
          <span className="font-bold text-sm tracking-tight">Chat Spike Analyzer</span>
          <span className="ml-1 text-xs text-white/30 hidden sm:inline">
            — find the hype moments in your stream
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
        {/* Input panel */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* Chat input */}
          <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <MessageSquare size={15} className="text-white/40" />
              <h2 className="text-sm font-semibold text-white/70">Chat Log</h2>
            </div>
            <ChatInput onAnalyze={handleAnalyze} isAnalyzing={isAnalyzing} />
          </div>

          {/* Options */}
          <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Settings2 size={15} className="text-white/40" />
              <h2 className="text-sm font-semibold text-white/70">Options</h2>
            </div>

            {/* Keywords */}
            <div className="flex flex-col gap-2">
              <label className="text-xs text-white/50 uppercase tracking-wider">
                Keyword tracking
              </label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. W, LMAO, PogChamp (comma-separated)"
                className="w-full rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white/80 placeholder-white/20 px-3 py-2.5 focus:outline-none focus:border-violet-500/40 focus:bg-white/[0.06] transition-colors"
              />
              <p className="text-xs text-white/25 leading-relaxed">
                Track specific words or emotes. Each gets its own line on the chart and a ranked peak list.
              </p>
            </div>

            {/* Bucket size */}
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

            {result && lastText && (
              <button
                onClick={handleReanalyze}
                disabled={isAnalyzing}
                className="mt-auto flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Re-analyze with new settings
              </button>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Messages" value={result.totalMessages.toLocaleString()} />
              <StatCard label="Duration" value={formatDuration(result.duration)} />
              <StatCard label="Bucket size" value={`${result.bucketSize}s`} />
              <StatCard label="Spikes found" value={result.spikes.length} />
            </div>

            {/* Chart */}
            <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-sm font-semibold text-white/70">Activity Timeline</h2>
                <div className="flex items-center gap-3 text-xs text-white/30">
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

            {/* Spike list */}
            <div className="bg-white/[0.03] rounded-2xl border border-white/[0.07] p-5">
              <SpikeList
                spikes={result.spikes}
                keywordSpikes={result.keywordSpikes}
                keywords={result.keywords}
              />
            </div>
          </>
        )}

        {/* Empty state */}
        {!result && !error && (
          <div className="text-center py-16 text-white/20">
            <BarChart2 size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Paste a chat log above and hit Analyze to see your stream's hype moments</p>
          </div>
        )}
      </main>
    </div>
  );
}
