export interface ChatMessage {
  timestamp: number; // seconds from stream start
  raw: string;
  text: string;
}

export interface BucketData {
  bucketStart: number; // seconds
  count: number;
  label: string;
  keywordCounts: Record<string, number>;
}

export interface SpikePoint {
  bucketStart: number;
  label: string;
  count: number;
  magnitude: number; // how many std deviations above mean
}

export interface KeywordSpike {
  keyword: string;
  bucketStart: number;
  label: string;
  count: number;
}

export interface AnalysisResult {
  buckets: BucketData[];
  spikes: SpikePoint[];
  keywordSpikes: KeywordSpike[];
  totalMessages: number;
  duration: number;
  bucketSize: number;
  keywords: string[];
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimestamp(raw: string): number | null {
  // [HH:MM:SS] or [MM:SS]
  let m = raw.match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);

  m = raw.match(/\[?(\d{1,2}):(\d{2})\]?/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);

  // Unix timestamp (large number)
  const unix = parseFloat(raw.replace(/[^\d.]/g, ""));
  if (!isNaN(unix) && unix > 1e9) {
    return unix; // we'll normalize later
  }

  // ISO 8601
  try {
    const d = new Date(raw.trim());
    if (!isNaN(d.getTime())) return d.getTime() / 1000;
  } catch {
    /* ignore */
  }

  return null;
}

const TIMESTAMP_PATTERNS = [
  // [HH:MM:SS] username: message
  /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+\S.*?:\s+(.+)$/,
  // HH:MM:SS | username: message
  /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[|–-]\s*\S.*?:\s*(.+)$/,
  // username (HH:MM:SS): message
  /^\S.*?\s+\((\d{1,2}:\d{2}(?::\d{2})?)\):\s+(.+)$/,
  // unix/ISO timestamp followed by anything
  /^(\d{10,}(?:\.\d+)?)\s+(.+)$/,
  // ISO timestamp
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.+)$/,
  // Twitch export: (HH:MM:SS) username: message
  /^\((\d{1,2}:\d{2}(?::\d{2})?)\)\s+\S.*?:\s+(.+)$/,
  // YouTube: [HH:MM:SS] message
  /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+)$/,
  // Generic: timestamp at start of line
  /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/,
];

export function parseChat(raw: string): ChatMessage[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const messages: ChatMessage[] = [];
  const rawTimestamps: Array<{ ts: number; text: string; raw: string }> = [];

  for (const line of lines) {
    let parsed = false;
    for (const pattern of TIMESTAMP_PATTERNS) {
      const m = line.match(pattern);
      if (m) {
        const tsRaw = m[1];
        const text = m[2] || "";
        const ts = parseTimestamp(tsRaw);
        if (ts !== null) {
          rawTimestamps.push({ ts, text, raw: line });
          parsed = true;
          break;
        }
      }
    }
    if (!parsed) {
      // Try to find any timestamp-like pattern anywhere in the line
      const tsMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (tsMatch) {
        const ts = parseTimestamp(tsMatch[1]);
        if (ts !== null) {
          const text = line.replace(tsMatch[0], "").trim();
          rawTimestamps.push({ ts, text, raw: line });
        }
      }
    }
  }

  if (rawTimestamps.length === 0) return [];

  // Detect if timestamps are unix (all > 1e9), normalize to seconds from start
  const isUnix = rawTimestamps.every((r) => r.ts > 1e9);
  const minTs = Math.min(...rawTimestamps.map((r) => r.ts));

  for (const { ts, text, raw } of rawTimestamps) {
    const normalized = isUnix ? ts - minTs : ts - (isUnix ? minTs : 0);
    // For HH:MM:SS style, keep as-is (already in seconds from start)
    const finalTs = isUnix ? normalized : ts;
    messages.push({ timestamp: finalTs, text, raw });
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

export function analyzeChat(
  messages: ChatMessage[],
  keywordsRaw: string,
  bucketSizeOverride?: number
): AnalysisResult {
  if (messages.length === 0) {
    return { buckets: [], spikes: [], keywordSpikes: [], totalMessages: 0, duration: 0, bucketSize: 10, keywords: [] };
  }

  const keywords = keywordsRaw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);

  const minTs = Math.min(...messages.map((m) => m.timestamp));
  const maxTs = Math.max(...messages.map((m) => m.timestamp));
  const duration = maxTs - minTs;

  // Auto-select bucket size
  let bucketSize = bucketSizeOverride ?? 10;
  if (!bucketSizeOverride) {
    if (duration < 60) bucketSize = 5;
    else if (duration < 300) bucketSize = 10;
    else if (duration < 1800) bucketSize = 15;
    else if (duration < 7200) bucketSize = 30;
    else bucketSize = 60;
  }

  const numBuckets = Math.ceil((duration + 1) / bucketSize) || 1;
  const buckets: BucketData[] = Array.from({ length: numBuckets }, (_, i) => ({
    bucketStart: minTs + i * bucketSize,
    count: 0,
    label: formatTimestamp(minTs + i * bucketSize),
    keywordCounts: Object.fromEntries(keywords.map((k) => [k, 0])),
  }));

  for (const msg of messages) {
    const idx = Math.floor((msg.timestamp - minTs) / bucketSize);
    const bucket = buckets[Math.min(idx, buckets.length - 1)];
    bucket.count++;
    const lower = msg.text.toLowerCase();
    for (const kw of keywords) {
      // Count occurrences (word boundary optional — count substrings)
      let pos = 0;
      while ((pos = lower.indexOf(kw, pos)) !== -1) {
        bucket.keywordCounts[kw]++;
        pos += kw.length;
      }
    }
  }

  // Spike detection: mean + 1.5 std dev threshold
  const counts = buckets.map((b) => b.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const std = Math.sqrt(variance);
  const threshold = mean + Math.max(1.5 * std, mean * 0.5, 1);

  const spikes: SpikePoint[] = buckets
    .filter((b) => b.count >= threshold)
    .map((b) => ({
      bucketStart: b.bucketStart,
      label: b.label,
      count: b.count,
      magnitude: std > 0 ? (b.count - mean) / std : b.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Keyword spikes: per keyword, top moments
  const keywordSpikes: KeywordSpike[] = [];
  for (const kw of keywords) {
    const kwCounts = buckets.map((b) => b.keywordCounts[kw]);
    const kwMean = kwCounts.reduce((a, b) => a + b, 0) / kwCounts.length;
    const kwVariance = kwCounts.reduce((a, b) => a + (b - kwMean) ** 2, 0) / kwCounts.length;
    const kwStd = Math.sqrt(kwVariance);
    const kwThreshold = Math.max(kwMean + kwStd, 1);

    for (const bucket of buckets) {
      if (bucket.keywordCounts[kw] >= kwThreshold) {
        keywordSpikes.push({
          keyword: kw,
          bucketStart: bucket.bucketStart,
          label: bucket.label,
          count: bucket.keywordCounts[kw],
        });
      }
    }
  }

  keywordSpikes.sort((a, b) => b.count - a.count);

  return {
    buckets,
    spikes,
    keywordSpikes,
    totalMessages: messages.length,
    duration,
    bucketSize,
    keywords,
  };
}
