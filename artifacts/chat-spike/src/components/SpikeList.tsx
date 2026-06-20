import { Zap, TrendingUp } from "lucide-react";
import type { SpikePoint, KeywordSpike } from "../lib/chatParser";

const KEYWORD_COLORS = [
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#a78bfa",
  "#fb923c",
  "#2dd4bf",
];

interface SpikeListProps {
  spikes: SpikePoint[];
  keywordSpikes: KeywordSpike[];
  keywords: string[];
}

export default function SpikeList({ spikes, keywordSpikes, keywords }: SpikeListProps) {
  const topSpikes = spikes.slice(0, 10);

  // Group keyword spikes by keyword
  const kwGroups: Record<string, KeywordSpike[]> = {};
  for (const kw of keywords) {
    kwGroups[kw] = keywordSpikes
      .filter((s) => s.keyword === kw)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  const maxCount = topSpikes[0]?.count ?? 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Overall spikes */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={15} className="text-violet-400" />
          <h3 className="text-sm font-semibold text-white/80">Top Spike Moments</h3>
        </div>
        {topSpikes.length === 0 ? (
          <p className="text-xs text-white/30 italic">No significant spikes detected.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {topSpikes.map((spike, i) => (
              <div key={spike.label} className="flex items-center gap-3 group">
                <span className="text-xs text-white/30 w-4 shrink-0 tabular-nums">{i + 1}</span>
                <span className="font-mono text-sm text-violet-300 w-20 shrink-0">{spike.label}</span>
                <div className="flex-1 min-w-0">
                  <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all"
                      style={{ width: `${(spike.count / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-sm font-bold text-white tabular-nums">{spike.count}</span>
                  <span className="text-xs text-white/30">msg</span>
                  <span className="text-xs text-violet-400/60 tabular-nums">
                    +{spike.magnitude.toFixed(1)}σ
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Keyword spike groups */}
      {keywords.map((kw, ki) => {
        const kwSpikes = kwGroups[kw] ?? [];
        const kwMax = kwSpikes[0]?.count ?? 1;
        const color = KEYWORD_COLORS[ki % KEYWORD_COLORS.length];

        return (
          <div key={kw}>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp size={14} style={{ color }} />
              <h3 className="text-sm font-semibold" style={{ color }}>
                "{kw}" peaks
              </h3>
            </div>
            {kwSpikes.length === 0 ? (
              <p className="text-xs text-white/30 italic">No notable spikes for this keyword.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {kwSpikes.map((spike, i) => (
                  <div key={`${kw}-${spike.label}`} className="flex items-center gap-3">
                    <span className="text-xs text-white/30 w-4 shrink-0 tabular-nums">{i + 1}</span>
                    <span className="font-mono text-sm w-20 shrink-0" style={{ color }}>
                      {spike.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${(spike.count / kwMax) * 100}%`,
                            background: color,
                            opacity: 0.7,
                          }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-sm font-bold text-white tabular-nums">{spike.count}</span>
                      <span className="text-xs text-white/30">×</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
