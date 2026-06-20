import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Legend,
} from "recharts";
import type { AnalysisResult } from "../lib/chatParser";

interface ActivityChartProps {
  result: AnalysisResult;
}

const KEYWORD_COLORS = [
  "#f472b6", // pink
  "#34d399", // emerald
  "#fbbf24", // amber
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#fb923c", // orange
  "#2dd4bf", // teal
];

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-[#1a1a2e] border border-white/10 rounded-xl px-4 py-3 shadow-xl text-sm">
      <p className="text-white/50 text-xs mb-2 font-mono">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1 last:mb-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-white/60 text-xs">{p.name}:</span>
          <span className="text-white font-semibold tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ActivityChart({ result }: ActivityChartProps) {
  const { buckets, spikes, keywords } = result;

  // Compute spike threshold line value (min spike count)
  const spikeThreshold = spikes.length > 0 ? Math.min(...spikes.map((s) => s.count)) : undefined;

  const chartData = buckets.map((b) => {
    const point: Record<string, string | number> = {
      label: b.label,
      "Chat Activity": b.count,
    };
    for (const kw of keywords) {
      point[kw] = b.keywordCounts[kw];
    }
    return point;
  });

  const spikeLabels = new Set(spikes.map((s) => s.label));

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="label"
            tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11, fontFamily: "monospace" }}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip content={<CustomTooltip />} />
          {keywords.length > 0 && (
            <Legend
              wrapperStyle={{ paddingTop: 12, fontSize: 12, color: "rgba(255,255,255,0.5)" }}
            />
          )}

          {/* Spike reference lines */}
          {spikeThreshold !== undefined && (
            <ReferenceLine
              y={spikeThreshold}
              stroke="rgba(251,191,36,0.3)"
              strokeDasharray="4 3"
              label={{ value: "spike floor", fill: "rgba(251,191,36,0.4)", fontSize: 10, position: "right" }}
            />
          )}

          {/* Mark spike buckets */}
          {spikes.slice(0, 10).map((spike) => (
            <ReferenceLine
              key={spike.label}
              x={spike.label}
              stroke={spikeLabels.has(spike.label) ? "rgba(167,139,250,0.25)" : "transparent"}
              strokeWidth={buckets.length < 200 ? 2 : 1}
            />
          ))}

          <Line
            type="monotone"
            dataKey="Chat Activity"
            stroke="#7c3aed"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#a78bfa", strokeWidth: 0 }}
          />

          {keywords.map((kw, i) => (
            <Line
              key={kw}
              type="monotone"
              dataKey={kw}
              stroke={KEYWORD_COLORS[i % KEYWORD_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
