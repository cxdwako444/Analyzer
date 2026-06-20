import { Flame, Users, Zap, Clock } from "lucide-react";
import type { ViralMoment } from "../lib/chatParser";

interface ViralMomentsProps {
  moments: ViralMoment[];
  bucketSize: number;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "from-amber-400 to-orange-500" :
    score >= 60 ? "from-violet-400 to-purple-600" :
    score >= 40 ? "from-cyan-400 to-blue-500" :
    "from-slate-400 to-slate-600";

  return (
    <div className={`flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center shadow-lg`}>
      <span className="text-white font-black text-xl tabular-nums leading-none">{score}</span>
    </div>
  );
}

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${value}%`, background: color }}
        />
      </div>
      <span className="text-xs tabular-nums text-white/40 w-6 text-right">{value}</span>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-base">🥇</span>;
  if (rank === 2) return <span className="text-base">🥈</span>;
  if (rank === 3) return <span className="text-base">🥉</span>;
  return (
    <span className="text-xs text-white/30 font-mono w-4 text-center shrink-0">#{rank}</span>
  );
}

export default function ViralMoments({ moments, bucketSize }: ViralMomentsProps) {
  if (moments.length === 0) {
    return (
      <div className="text-center py-10 text-white/25">
        <Flame size={32} className="mx-auto mb-2 opacity-30" />
        <p className="text-sm">No notable viral moments found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {moments.map((m, i) => (
        <div
          key={m.bucketStart}
          className="bg-white/[0.03] border border-white/[0.07] rounded-xl p-4 flex flex-col gap-3"
        >
          {/* Top row */}
          <div className="flex items-start gap-3">
            <ScoreBadge score={m.viralityScore} />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <RankBadge rank={i + 1} />
                <span className="font-mono text-sm font-bold text-white">{m.label}</span>
                {m.wallClockTime && (
                  <span className="text-xs text-white/30 flex items-center gap-1">
                    <Clock size={10} />
                    {m.wallClockTime.split(" ")[1] ?? m.wallClockTime}
                  </span>
                )}
                <span className="text-xs text-white/20">({bucketSize}s window)</span>
              </div>

              {/* Signal breakdown */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2">
                <div className="flex items-center gap-1.5">
                  <Zap size={11} className="text-violet-400 shrink-0" />
                  <span className="text-xs text-white/35">Speed</span>
                  <MiniBar value={m.speedScore} color="#7c3aed" />
                </div>
                <div className="flex items-center gap-1.5">
                  <Users size={11} className="text-cyan-400 shrink-0" />
                  <span className="text-xs text-white/35">Unique</span>
                  <MiniBar value={m.uniqueScore} color="#22d3ee" />
                </div>
                <div className="flex items-center gap-1.5">
                  <Flame size={11} className="text-pink-400 shrink-0" />
                  <span className="text-xs text-white/35">Hype</span>
                  <MiniBar value={m.hypeNormScore} color="#f472b6" />
                </div>
              </div>

              {/* Stats */}
              <div className="flex gap-3 mt-1.5 text-xs text-white/30">
                <span className="tabular-nums">{m.count.toLocaleString()} msgs</span>
                {m.distinctUsers > 0 && (
                  <span className="tabular-nums">{m.distinctUsers.toLocaleString()} chatters</span>
                )}
              </div>
            </div>
          </div>

          {/* Snippets */}
          {m.snippets.length > 0 && (
            <div className="border-t border-white/[0.05] pt-2.5 flex flex-col gap-1">
              {m.snippets.slice(0, 3).map((snippet, si) => (
                <p
                  key={si}
                  className="text-xs text-white/45 leading-relaxed truncate font-mono"
                >
                  {snippet}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
