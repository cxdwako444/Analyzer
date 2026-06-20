export interface ChatMessage {
  timestamp: number;    // seconds from stream start (offset)
  wallClockTime: string; // original datetime string for display
  user: string;
  text: string;
  raw: string;
}

export interface BucketData {
  bucketStart: number;  // seconds offset from stream start
  count: number;
  distinctUsers: number;
  hypeScore: number;    // raw hype token hits in this bucket
  label: string;        // formatted offset "H:MM:SS"
  wallClockTime: string; // first message wall clock time
  snippets: string[];   // up to 5 representative messages
  keywordCounts: Record<string, number>;
}

export interface SpikePoint {
  bucketStart: number;
  label: string;
  count: number;
  magnitude: number;
}

export interface KeywordSpike {
  keyword: string;
  bucketStart: number;
  label: string;
  count: number;
}

export interface ViralMoment {
  bucketStart: number;
  label: string;
  wallClockTime: string;
  viralityScore: number;  // 0–100
  speedScore: number;     // 0–100 component
  uniqueScore: number;    // 0–100 component
  hypeNormScore: number;  // 0–100 component
  count: number;
  distinctUsers: number;
  hypeScore: number;
  snippets: string[];
}

export interface AnalysisResult {
  buckets: BucketData[];
  spikes: SpikePoint[];
  keywordSpikes: KeywordSpike[];
  viralMoments: ViralMoment[];
  totalMessages: number;
  duration: number;
  bucketSize: number;
  keywords: string[];
  streamStart: string;  // wall-clock time of first message
}

// ─── Hype token set ────────────────────────────────────────────────────────
const HYPE_TOKENS = new Set([
  "w","l","gg","ggs","ez","rip","lol","lmao","lmaoo","lmaooo","lmaooooo",
  "omg","omfg","wtf","pog","poggers","pogchamp","kekw","lulw","omegalul",
  "pagman","monkas","5head","copium","sadge","weirdchamp","pepega",
  "clap","peeposhy","dankdance","peeporun","oooo","ooo","yikes","noooo",
  "bruh","insane","crazy","sheesh","bro","lets go","letsgo","lets gooo",
  "gooo","goooo","gg ez","nerd","ratio","based","cringe","imagine",
  "forsen","xqc","ice","poke",
]);

// ─── Utility ────────────────────────────────────────────────────────────────
export function formatOffset(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function capsRatio(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 4) return 0;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length;
}

function scoreHype(text: string): number {
  let score = 0;
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,!?.]+/).filter(Boolean);
  for (const w of words) {
    if (HYPE_TOKENS.has(w)) score++;
  }
  // Bonus for all-caps message
  if (capsRatio(text) > 0.6) score += 0.5;
  // Bonus for spammed characters like "OOOOOO" or "AAAAAAA"
  if (/(.)\1{3,}/i.test(text)) score += 0.5;
  return score;
}

// ─── CSV parser (handles quoted fields) ─────────────────────────────────────
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseDateTimeString(s: string): number | null {
  // "YYYY-MM-DD HH:MM:SS" — treat as local (no TZ shift)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return (
    Date.UTC(
      parseInt(m[1]),
      parseInt(m[2]) - 1,
      parseInt(m[3]),
      parseInt(m[4]),
      parseInt(m[5]),
      parseInt(m[6])
    ) / 1000
  );
}

function detectCSV(raw: string): boolean {
  const firstLine = raw.split(/\r?\n/)[0] || "";
  return (
    firstLine.toLowerCase().includes("date") &&
    firstLine.toLowerCase().includes("messages") &&
    firstLine.toLowerCase().includes("user")
  );
}

function parseCSV(raw: string): ChatMessage[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const dateIdx = header.findIndex((h) => h === "date");
  const msgIdx = header.findIndex((h) => h === "messages");
  const userIdx = header.findIndex((h) => h === "user");

  if (dateIdx === -1 || msgIdx === -1) return [];

  const raw_rows: Array<{ ts: number; wallClock: string; user: string; text: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseCSVLine(line);
    const dateStr = (fields[dateIdx] ?? "").trim();
    const text = (fields[msgIdx] ?? "").trim();
    const user = userIdx !== -1 ? (fields[userIdx] ?? "").trim() : "";

    const ts = parseDateTimeString(dateStr);
    if (ts !== null) {
      raw_rows.push({ ts, wallClock: dateStr, user, text });
    }
  }

  if (raw_rows.length === 0) return [];

  // Find min ts without spread (avoid stack overflow on large arrays)
  let minTs = raw_rows[0].ts;
  for (const r of raw_rows) if (r.ts < minTs) minTs = r.ts;

  return raw_rows
    .map((r) => ({
      timestamp: r.ts - minTs,
      wallClockTime: r.wallClock,
      user: r.user,
      text: r.text,
      raw: r.text,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Legacy text parser ──────────────────────────────────────────────────────
function parseLegacyTimestamp(raw: string): number | null {
  let m = raw.match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
  m = raw.match(/\[?(\d{1,2}):(\d{2})\]?/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  const unix = parseFloat(raw.replace(/[^\d.]/g, ""));
  if (!isNaN(unix) && unix > 1e9) return unix;
  try {
    const d = new Date(raw.trim());
    if (!isNaN(d.getTime())) return d.getTime() / 1000;
  } catch { /* ignore */ }
  return null;
}

const LEGACY_PATTERNS = [
  /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+\S.*?:\s+(.+)$/,
  /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[|–-]\s*\S.*?:\s*(.+)$/,
  /^\S.*?\s+\((\d{1,2}:\d{2}(?::\d{2})?)\):\s+(.+)$/,
  /^(\d{10,}(?:\.\d+)?)\s+(.+)$/,
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.+)$/,
  /^\((\d{1,2}:\d{2}(?::\d{2})?)\)\s+\S.*?:\s+(.+)$/,
  /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+)$/,
  /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/,
];

function parseTextChat(raw: string): ChatMessage[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: Array<{ ts: number; text: string }> = [];

  for (const line of lines) {
    let hit = false;
    for (const pat of LEGACY_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        const ts = parseLegacyTimestamp(m[1]);
        if (ts !== null) { rows.push({ ts, text: m[2] || "" }); hit = true; break; }
      }
    }
    if (!hit) {
      const tsMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (tsMatch) {
        const ts = parseLegacyTimestamp(tsMatch[1]);
        if (ts !== null) rows.push({ ts, text: line.replace(tsMatch[0], "").trim() });
      }
    }
  }

  if (rows.length === 0) return [];

  const isUnix = rows.every((r) => r.ts > 1e9);
  let minTs = rows[0].ts;
  for (const r of rows) if (r.ts < minTs) minTs = r.ts;

  return rows
    .map((r) => ({
      timestamp: isUnix ? r.ts - minTs : r.ts,
      wallClockTime: "",
      user: "",
      text: r.text,
      raw: r.text,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Public parse entry point ────────────────────────────────────────────────
export function parseChat(raw: string): ChatMessage[] {
  if (detectCSV(raw)) return parseCSV(raw);
  return parseTextChat(raw);
}

// ─── Build from API (Twitch / Kick) ─────────────────────────────────────────
export interface RawApiMessage {
  timestamp: number; // seconds from stream start
  user: string;
  text: string;
}

export function buildMessagesFromApi(raw: RawApiMessage[]): ChatMessage[] {
  if (raw.length === 0) return [];
  // Timestamps from the Twitch/Kick APIs are already offset from VOD start.
  return raw
    .map((m) => ({
      timestamp: m.timestamp,
      wallClockTime: "",
      user: m.user,
      text: m.text,
      raw: m.text,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Rolling baseline ────────────────────────────────────────────────────────
function rollingMean(values: number[], halfWindow: number): number[] {
  const n = values.length;
  const result = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n - 1, i + halfWindow);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    result[i] = sum / (hi - lo + 1);
  }
  return result;
}

function normalize(arr: number[]): number[] {
  let max = 0;
  for (const v of arr) if (v > max) max = v;
  if (max === 0) return arr.map(() => 0);
  return arr.map((v) => v / max);
}

// ─── Main analysis ───────────────────────────────────────────────────────────
export function analyzeChat(
  messages: ChatMessage[],
  keywordsRaw: string,
  bucketSizeOverride?: number
): AnalysisResult {
  if (messages.length === 0) {
    return {
      buckets: [], spikes: [], keywordSpikes: [], viralMoments: [],
      totalMessages: 0, duration: 0, bucketSize: 15, keywords: [], streamStart: "",
    };
  }

  const keywords = keywordsRaw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);

  // Already sorted, offsets from 0
  const minTs = messages[0].timestamp;  // should be 0 after parsing
  let maxTs = messages[0].timestamp;
  for (const m of messages) if (m.timestamp > maxTs) maxTs = m.timestamp;
  const duration = maxTs - minTs;
  const streamStart = messages[0].wallClockTime;

  // Auto bucket size
  let bucketSize = bucketSizeOverride ?? 15;
  if (!bucketSizeOverride) {
    if (duration < 120) bucketSize = 5;
    else if (duration < 600) bucketSize = 10;
    else if (duration < 3600) bucketSize = 15;
    else bucketSize = 15; // keep 15s for long streams — fine granularity
  }

  const numBuckets = Math.ceil((duration + 1) / bucketSize) || 1;

  // Temporary per-bucket user sets for distinct-user count
  const userSets: Set<string>[] = Array.from({ length: numBuckets }, () => new Set<string>());

  const buckets: BucketData[] = Array.from({ length: numBuckets }, (_, i) => ({
    bucketStart: i * bucketSize,
    count: 0,
    distinctUsers: 0,
    hypeScore: 0,
    label: formatOffset(i * bucketSize),
    wallClockTime: "",
    snippets: [],
    keywordCounts: Object.fromEntries(keywords.map((k) => [k, 0])),
  }));

  for (const msg of messages) {
    const idx = Math.min(Math.floor((msg.timestamp - minTs) / bucketSize), numBuckets - 1);
    const bucket = buckets[idx];
    bucket.count++;

    if (bucket.wallClockTime === "" && msg.wallClockTime) {
      bucket.wallClockTime = msg.wallClockTime;
    }
    if (msg.user) userSets[idx].add(msg.user);
    bucket.hypeScore += scoreHype(msg.text);
    if (bucket.snippets.length < 5 && msg.text.trim()) {
      const snippet = msg.user ? `${msg.user}: ${msg.text}` : msg.text;
      bucket.snippets.push(snippet.slice(0, 120));
    }

    const lower = msg.text.toLowerCase();
    for (const kw of keywords) {
      let pos = 0;
      while ((pos = lower.indexOf(kw, pos)) !== -1) {
        bucket.keywordCounts[kw]++;
        pos += kw.length;
      }
    }
  }

  // Fill distinct users from sets
  for (let i = 0; i < numBuckets; i++) {
    buckets[i].distinctUsers = userSets[i].size;
  }

  // ─── Spike detection ───
  const counts = buckets.map((b) => b.count);
  let sum = 0; for (const c of counts) sum += c;
  const mean = sum / counts.length;
  let varSum = 0; for (const c of counts) varSum += (c - mean) ** 2;
  const std = Math.sqrt(varSum / counts.length);
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

  // ─── Keyword spikes ───
  const keywordSpikes: KeywordSpike[] = [];
  for (const kw of keywords) {
    const kwCounts = buckets.map((b) => b.keywordCounts[kw]);
    let kwSum = 0; for (const c of kwCounts) kwSum += c;
    const kwMean = kwSum / kwCounts.length;
    let kwVarSum = 0; for (const c of kwCounts) kwVarSum += (c - kwMean) ** 2;
    const kwStd = Math.sqrt(kwVarSum / kwCounts.length);
    const kwThreshold = Math.max(kwMean + kwStd, 1);
    for (const bucket of buckets) {
      if (bucket.keywordCounts[kw] >= kwThreshold) {
        keywordSpikes.push({ keyword: kw, bucketStart: bucket.bucketStart, label: bucket.label, count: bucket.keywordCounts[kw] });
      }
    }
  }
  keywordSpikes.sort((a, b) => b.count - a.count);

  // ─── Virality scoring ───
  const ROLLING_HALF = Math.max(10, Math.round(300 / bucketSize)); // ~5-min baseline window

  const msgCounts = buckets.map((b) => b.count);
  const userCounts = buckets.map((b) => b.distinctUsers);
  const hypeDensity = buckets.map((b) => b.count > 0 ? b.hypeScore / b.count : 0);

  const baselineMsg = rollingMean(msgCounts, ROLLING_HALF);
  const baselineUser = rollingMean(userCounts, ROLLING_HALF);

  // Raw component: how much this bucket exceeds baseline (clamped at 0)
  const rawSpeed = msgCounts.map((v, i) => Math.max(0, v - baselineMsg[i]));
  const rawUnique = userCounts.map((v, i) => Math.max(0, v - baselineUser[i]));
  const rawHype = hypeDensity;

  const normSpeed = normalize(rawSpeed);
  const normUnique = normalize(rawUnique);
  const normHype = normalize(rawHype);

  const blended = normSpeed.map((s, i) => 0.45 * s + 0.30 * normUnique[i] + 0.25 * normHype[i]);
  const normBlended = normalize(blended);

  const viralMoments: ViralMoment[] = buckets
    .map((b, i) => ({
      bucketStart: b.bucketStart,
      label: b.label,
      wallClockTime: b.wallClockTime,
      viralityScore: Math.round(normBlended[i] * 100),
      speedScore: Math.round(normSpeed[i] * 100),
      uniqueScore: Math.round(normUnique[i] * 100),
      hypeNormScore: Math.round(normHype[i] * 100),
      count: b.count,
      distinctUsers: b.distinctUsers,
      hypeScore: b.hypeScore,
      snippets: b.snippets,
    }))
    .filter((v) => v.viralityScore >= 10 && v.count > 0)
    .sort((a, b) => b.viralityScore - a.viralityScore)
    .slice(0, 20);

  return {
    buckets,
    spikes,
    keywordSpikes,
    viralMoments,
    totalMessages: messages.length,
    duration,
    bucketSize,
    keywords,
    streamStart,
  };
}
