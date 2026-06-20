import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import type { AnalysisResult } from "../lib/chatParser";

interface ActivityChartProps {
  result: AnalysisResult;
}

const KEYWORD_COLORS = [
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#a78bfa",
  "#fb923c",
  "#2dd4bf",
];

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-[#1a1a2e] border border-white/10 rounded-xl px-4 py-3 shadow-xl text-sm pointer-events-none">
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

  // Only render every Nth data point to keep recharts fast on large datasets
  // but keep ALL data in the LineChart — just control tick labels on x-axis
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

  // Spike threshold floor
  const spikeThreshold =
    spikes.length > 0 ? Math.min(...spikes.map((s) => s.count)) : undefined;

  // Control how many x-axis labels appear (aim for ~10-15 labels)
  const totalBuckets = buckets.length;
  const targetLabels = 12;
  const labelInterval = Math.max(1, Math.round(totalBuckets / targetLabels));

  // Top spike labels for reference lines
  const topSpikeLabels = new Set(spikes.slice(0, 8).map((s) => s.label));

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 16, left: 0, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 11, fontFamily: "monospace" }}
            axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
            tickLine={false}
            interval={labelInterval - 1}
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip content={<CustomTooltip />} />

          {spikeThreshold !== undefined && (
            <ReferenceLine
              y={spikeThreshold}
              stroke="rgba(251,191,36,0.25)"
              strokeDasharray="4 3"
              label={{
                value: "spike floor",
                fill: "rgba(251,191,36,0.35)",
                fontSize: 10,
                position: "right",
              }}
            />
          )}

          {/* Vertical markers for top spikes */}
          {spikes.slice(0, 8).map((spike) =>
            topSpikeLabels.has(spike.label) ? (
              <ReferenceLine
                key={spike.label}
                x={spike.label}
                stroke="rgba(167,139,250,0.2)"
                strokeWidth={1}
              />
            ) : null
          )}

          {/* Main activity line */}
          <Line
            type="monotone"
            dataKey="Chat Activity"
            stroke="#7c3aed"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 4, fill: "#a78bfa", strokeWidth: 0 }}
            isAnimationActive={false}
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
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
