const express = require("express");
const cors = require("cors");
const https = require("https");
const helmet = require("helmet");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPADATA_KEY = process.env.SUPADATA_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const PORT = process.env.PORT || 5000;

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ── CONSTANTS ──────────────────────────────────────────────
const DAILY_LIMIT = 3;
const DAILY_ATTEMPT_LIMIT = 12;  // max total attempts per day (anti-spam)
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MIN_TRANSCRIPT_LENGTH = 150;

// ── MAPS ───────────────────────────────────────────────────
const successMap = new Map();
const attemptMap = new Map();
const summaryCache = new Map();

// ── CLEANUP ────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const today = getToday();
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
  for (const key of successMap.keys()) {
    if (!key.endsWith(`__${today}`)) successMap.delete(key);
  }
  for (const key of attemptMap.keys()) {
    if (!key.endsWith(`__${today}`)) attemptMap.delete(key);
  }
}, 30 * 60 * 1000);

// ── ANALYTICS ──────────────────────────────────────────────
const analytics = {
  totalRequests: 0, cacheHits: 0, geminiFails: 0, successfulSummaries: 0,
  supadataHits: 0, rapid1Hits: 0, rapid2Hits: 0, rapid3Hits: 0,
  rapid4Hits: 0, rapid5Hits: 0, rapid6Hits: 0,
  transcriptNotFound: 0, notEnoughData: 0, shortsRejected: 0
};

// ── HELPERS ────────────────────────────────────────────────
function getToday() { return new Date().toISOString().slice(0, 10); }

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress;
}

// Successful summaries count
function getSuccessCount(ip) { return successMap.get(`${ip}__${getToday()}`) || 0; }
function isSuccessLimitReached(ip) { return getSuccessCount(ip) >= DAILY_LIMIT; }
function incrementSuccess(ip) {
  const key = `${ip}__${getToday()}`;
  successMap.set(key, (successMap.get(key) || 0) + 1);
}

// Attempt tracking (anti-spam)
function getAttemptCount(ip) { return attemptMap.get(`${ip}__${getToday()}`) || 0; }
function isAttemptLimitReached(ip) { return getAttemptCount(ip) >= DAILY_ATTEMPT_LIMIT; }
function incrementAttempt(ip) {
  const key = `${ip}__${getToday()}`;
  attemptMap.set(key, (attemptMap.get(key) || 0) + 1);
}

// FIX: YouTube IDs are exactly 11 characters
function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function isShort(url) { return url.includes("/shorts/"); }

function isMusicLike(title, transcript) {
  const musicKeywords = ["official video", "official audio", "lyrics", "music video", "feat.", "ft.", "audio only", "visualizer", "vevo"];
  const titleLower = (title || "").toLowerCase();
  const hasMusikTitle = musicKeywords.some(k => titleLower.includes(k));
  if (transcript) {
    const lines = transcript.split("\n").filter(l => l.trim().length > 0);
    const shortLines = lines.filter(l => l.trim().length < 40);
    const isMostlyShortLines = lines.length > 5 && shortLines.length / lines.length > 0.7;
    return hasMusikTitle || isMostlyShortLines;
  }
  return hasMusikTitle;
}

function getTranscriptQuality(transcript) {
  if (!transcript || transcript.length < MIN_TRANSCRIPT_LENGTH) return "low";
  const alphaChars = (transcript.match(/[a-zA-Z\u0900-\u097F\u0600-\u06FF\u4e00-\u9fff]/g) || []).length;
  const alphaRatio = alphaChars / transcript.length;
  if (alphaRatio < 0.25) return "low";
  const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length < 10) return "low";
  const uniqueWords = new Set(words);
  if (uniqueWords.size / words.length < 0.1) return "low";
  if (transcript.length < 800) return "medium";
  return "high";
}

function getConfidence(quality) {
  if (quality === "high") return "High";
  if (quality === "medium") return "Medium";
  return "Low";
}

function isValidSummary(text) {
  if (!text || text.trim().length < 80) return false;
  const lower = text.toLowerCase();
  const fillerPhrases = [
    "i cannot summarize", "i don't have enough", "i'm unable to",
    "no transcript", "not enough information", "cannot provide a summary",
    "unable to generate", "i cannot provide", "insufficient data", "no meaningful content"
  ];
  return !fillerPhrases.some(p => lower.includes(p));
}

function fetchVideoInfo(videoId) {
  return new Promise((resolve) => {
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve({ title: j.title || "YouTube Video", channel: j.author_name || "Unknown" });
        } catch { resolve({ title: "YouTube Video", channel: "Unknown" }); }
      });
    }).on("error", () => resolve({ title: "YouTube Video", channel: "Unknown" }));
  });
}

// ── GEMINI ─────────────────────────────────────────────────
const GEMINI_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

async function callGeminiWithFallback(prompt) {
  for (const model of GEMINI_MODELS) {
    try {
      const result = await callGemini(prompt, model);
      console.log(`[GEMINI SUCCESS] model: ${model}`);
      return result;
    } catch (e) {
      const msg = e.message || "";
      const isQuota = msg.includes("quota") || msg.includes("limit: 0") || msg.includes("RESOURCE_EXHAUSTED");
      const isNotFound = msg.includes("not found") || msg.includes("not supported");
      if (isQuota || isNotFound) continue;
      throw e;
    }
  }
  throw new Error("All Gemini models exhausted");
}

function callGemini(prompt, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) resolve(text);
          else reject(new Error("No response from Gemini"));
        } catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.write(body);
    req.end();
  });
}

// ── HTTPS HELPER ───────────────────────────────────────────
function httpsGet(hostname, path, headers) {
  return new Promise((resolve) => {
    const options = { hostname, path, method: "GET", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── EXTRACT TEXT ───────────────────────────────────────────
function extractText(data, fields) {
  if (!data) return null;
  for (const field of fields) {
    const val = data[field];
    if (!val) continue;
    if (typeof val === "string" && val.length >= MIN_TRANSCRIPT_LENGTH) return val;
    if (Array.isArray(val)) {
      const parts = [];
      for (const item of val) {
        if (typeof item === "string") { parts.push(item); continue; }
        if (typeof item === "object" && item !== null) {
          const direct = item.text || item.content || item.transcript || item.caption || "";
          if (direct) { parts.push(direct); continue; }
          const nested = item.text || item.content;
          if (Array.isArray(nested)) {
            for (const n of nested) {
              const t = typeof n === "string" ? n : (n?.text || n?.content || "");
              if (t) parts.push(t);
            }
          }
        }
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined.length >= MIN_TRANSCRIPT_LENGTH) return joined;
    }
  }
  return null;
}

// ── TRANSCRIPT SOURCES ─────────────────────────────────────
async function trySupadata(videoId) {
  if (!SUPADATA_KEY) return null;
  const paths = [
    `/v1/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true&lang=en`,
    `/v1/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
  ];
  for (const path of paths) {
    const data = await httpsGet("api.supadata.ai", path, { "x-api-key": SUPADATA_KEY });
    const text = extractText(data, ["content", "text"]);
    if (text) return text;
  }
  return null;
}

async function tryRapid1(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcripts.p.rapidapi.com", `/youtube/transcript?videoId=${videoId}&chunkSize=500`, { "x-rapidapi-host": "youtube-transcripts.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["content", "transcript", "text"]);
}

async function tryRapid2(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube2transcript.p.rapidapi.com", `/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube2transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["transcript", "text", "content"]);
}

async function tryRapid3(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("fetch-youtube-transcript.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "fetch-youtube-transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["transcript", "text", "content"]);
}

async function tryRapid4(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcript3.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["transcript", "text", "content"]);
}

async function tryRapid5(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("ytscript.p.rapidapi.com", `/transcript?videoId=${videoId}`, { "x-rapidapi-host": "ytscript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["transcript", "text", "content"]);
}

async function tryRapid6(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcript-generator.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube-transcript-generator.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  return extractText(data, ["transcript", "text", "content"]);
}

async function fetchTranscript(videoId) {
  const sources = [
    { fn: () => trySupadata(videoId), name: "supadata" },
    { fn: () => tryRapid1(videoId), name: "rapid_solid" },
    { fn: () => tryRapid2(videoId), name: "rapid_leadxpert" },
    { fn: () => tryRapid3(videoId), name: "rapid_blazing" },
    { fn: () => tryRapid4(videoId), name: "rapid_apicity" },
    { fn: () => tryRapid5(videoId), name: "rapid_ytscript" },
    { fn: () => tryRapid6(videoId), name: "rapid_wavalidat" },
  ];
  for (const source of sources) {
    try {
      const text = await source.fn();
      if (text) {
        console.log(`[TRANSCRIPT SUCCESS] source: ${source.name}, length: ${text.length}`);
        return { text, source: source.name };
      }
    } catch (e) {
      console.error(`[ERROR] Transcript source ${source.name}:`, e.message);
    }
  }
  return null;
}

// ── SUMMARIZE ──────────────────────────────────────────────
async function summarizeFromTranscript(transcript, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi" ? "Respond entirely in Hindi." : "Respond in English.";
  const chunk = transcript.slice(0, isDetailed ? 12000 : 8000);
  const strict = `IMPORTANT RULES:\n- Use ONLY the transcript text provided below.\n- Do NOT invent facts, scenes, timestamps, or claims not present in the transcript.\n- Do NOT guess what the video might be about.\n- If the transcript is unclear, summarize only what is clearly stated.`;
  const prompt = isDetailed
    ? `You are an expert summarizer. ${langNote}\n${strict}\n\nWrite a DETAILED summary in plain text, no emojis:\n\nDetailed Video Summary\n\nOverview\n[4-5 sentences from transcript]\n\nKey Points\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n\nConclusion\n[2-3 sentences]\n\nTranscript:\n${chunk}`
    : `You are an expert summarizer. ${langNote}\n${strict}\n\nWrite a SHORT summary in plain text, no emojis:\n\nVideo Summary\n\nOverview\n[2-3 sentences from transcript]\n\nKey Points\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n\nTranscript:\n${chunk}`;
  return callGeminiWithFallback(prompt);
}

// ── MAIN ROUTE ─────────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  analytics.totalRequests++;
  const clientIP = getClientIP(req);
  console.log(`[REQUEST] from ${clientIP}`);

  // STEP 1: Check successful summary limit
  if (isSuccessLimitReached(clientIP)) {
    return res.status(429).json({
      success: false, code: "rate_limit",
      error: "You've used all 3 free summaries for today. Come back tomorrow.",
      usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT }
    });
  }

  // STEP 2: Check attempt limit (anti-spam — prevents Shorts/fail spam)
  if (isAttemptLimitReached(clientIP)) {
    return res.status(429).json({
      success: false, code: "rate_limit",
      error: "Too many requests today. Please try again tomorrow.",
      usage: { used: getSuccessCount(clientIP), limit: DAILY_LIMIT }
    });
  }

  // STEP 3: Validate inputs
  if (!GEMINI_API_KEY) return res.status(500).json({ success: false, code: "server_error", error: "Server misconfigured." });

  const { videoUrl, language = "English", summaryType = "short" } = req.body;

  if (!videoUrl) return res.status(400).json({ success: false, code: "invalid_url", error: "Please provide a YouTube URL." });

  const videoId = extractVideoId(videoUrl);
  if (!videoId) return res.status(400).json({ success: false, code: "invalid_url", error: "Invalid YouTube URL. Please check and try again." });

  const short = isShort(videoUrl);

  // STEP 3: Cache check (cache hits don't count as attempts)
  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    analytics.cacheHits++;
    const cachedMusicWarning = cached.isMusicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;
    return res.json({
      success: true, summary: cached.summary, title: cached.title,
      channel: cached.channel, sourceUsed: cached.sourceUsed,
      confidence: cached.confidence, isShort: short,
      isMusicLike: cached.isMusicLike, musicWarning: cachedMusicWarning,
      usage: { used: getSuccessCount(clientIP), limit: DAILY_LIMIT }, fromCache: true
    });
  }

  // STEP 4: Start processing — count this attempt
  incrementAttempt(clientIP);
  try {
    const videoInfo = await fetchVideoInfo(videoId);
    const result = await fetchTranscript(videoId);

    if (!result) {
      analytics.transcriptNotFound++;
      if (short) {
        analytics.shortsRejected++;
        return res.status(404).json({
          success: false, code: "transcript_not_found",
          error: "This YouTube Short does not have enough transcript data to generate a reliable summary.",
          isShort: true
        });
      }
      return res.status(404).json({
        success: false, code: "transcript_not_found",
        error: "No transcript found for this video. The video may not have captions enabled."
      });
    }

    const { text: transcript, source: sourceUsed } = result;

    // Update analytics
    if (sourceUsed === "supadata") analytics.supadataHits++;
    else if (sourceUsed === "rapid_solid") analytics.rapid1Hits++;
    else if (sourceUsed === "rapid_leadxpert") analytics.rapid2Hits++;
    else if (sourceUsed === "rapid_blazing") analytics.rapid3Hits++;
    else if (sourceUsed === "rapid_apicity") analytics.rapid4Hits++;
    else if (sourceUsed === "rapid_ytscript") analytics.rapid5Hits++;
    else if (sourceUsed === "rapid_wavalidat") analytics.rapid6Hits++;

    const quality = getTranscriptQuality(transcript);
    if (quality === "low") {
      analytics.notEnoughData++;
      return res.status(422).json({
        success: false, code: "not_enough_data",
        error: "Not enough transcript data available for an accurate summary."
      });
    }

    const musicLike = isMusicLike(videoInfo.title, transcript);
    let summary = null;

    try {
      summary = await Promise.race([
        summarizeFromTranscript(transcript, language, summaryType),
        new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))
      ]);
    } catch (err) {
      if (err.message === "TIMEOUT") return res.status(504).json({ success: false, code: "summary_timeout", error: "Summary generation timed out. Please try again." });
      analytics.geminiFails++;
      console.error("[ERROR] Gemini failed:", err.message);
      return res.status(500).json({ success: false, code: "server_error", error: "AI failed to generate a reliable summary. Try another video." });
    }

    if (!summary || !isValidSummary(summary)) {
      analytics.geminiFails++;
      return res.status(422).json({ success: false, code: "not_enough_data", error: "Not enough transcript data available for an accurate summary." });
    }

    const confidence = getConfidence(quality);

    // Only cache successful summaries
    if (summaryCache.size >= MAX_CACHE_ENTRIES) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(cacheKey, {
      summary, title: videoInfo.title, channel: videoInfo.channel,
      sourceUsed, confidence, isMusicLike: musicLike, createdAt: Date.now()
    });

    // Increment success count ONLY on successful summary
    analytics.successfulSummaries++;
    incrementSuccess(clientIP);

    const musicWarning = musicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;

    console.log(`[SUCCESS] videoId: ${videoId} | source: ${sourceUsed} | confidence: ${confidence}`);

    return res.json({
      success: true, summary, title: videoInfo.title, channel: videoInfo.channel,
      sourceUsed, confidence, isShort: short, isMusicLike: musicLike, musicWarning,
      usage: { used: getSuccessCount(clientIP), limit: DAILY_LIMIT }
    });

  } catch (err) {
    console.error("[ERROR] Unhandled:", err.message);
    analytics.geminiFails++;
    return res.status(500).json({ success: false, code: "server_error", error: "Something went wrong. Please try again." });
  }
});

app.get("/api/usage", (req, res) => res.json({ used: getSuccessCount(getClientIP(req)), limit: DAILY_LIMIT }));

app.get("/api/stats", (req, res) => {
  const clientIP = getClientIP(req);
  if (clientIP !== "127.0.0.1" && clientIP !== "::1" && !clientIP.startsWith("10.")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json({ ...analytics, cacheSize: summaryCache.size });
});

app.get("/", (req, res) => res.send("Sumora Backend Running!"));

process.on("uncaughtException", err => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", reason => console.error("[UNHANDLED]", reason));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[START] Sumora running on port ${PORT}`);
  console.log(`[CONFIG] GEMINI_API_KEY: ${GEMINI_API_KEY ? "SET" : "MISSING"}`);
  console.log(`[CONFIG] SUPADATA_KEY: ${SUPADATA_KEY ? "SET" : "MISSING"}`);
  console.log(`[CONFIG] RAPIDAPI_KEY: ${RAPIDAPI_KEY ? "SET" : "MISSING"}`);
});
