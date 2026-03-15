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

const rateLimitMap = new Map();
const DAILY_LIMIT = 3;
const summaryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MIN_TRANSCRIPT_LENGTH = 150; // relaxed from 200

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
  const today = getToday();
  for (const key of rateLimitMap.keys()) {
    if (!key.endsWith(`__${today}`)) rateLimitMap.delete(key);
  }
}, 30 * 60 * 1000);

const analytics = {
  totalRequests: 0, cacheHits: 0, geminiFails: 0, successfulSummaries: 0,
  supadataHits: 0, rapid1Hits: 0, rapid2Hits: 0, rapid3Hits: 0,
  rapid4Hits: 0, rapid5Hits: 0, rapid6Hits: 0,
  transcriptNotFound: 0, notEnoughData: 0, shortsRejected: 0
};

function getToday() { return new Date().toISOString().slice(0, 10); }

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress;
}

function isLimitReached(ip) { return (rateLimitMap.get(`${ip}__${getToday()}`) || 0) >= DAILY_LIMIT; }

function incrementUsage(ip) {
  const key = `${ip}__${getToday()}`;
  rateLimitMap.set(key, (rateLimitMap.get(key) || 0) + 1);
}

function getUsageCount(ip) { return rateLimitMap.get(`${ip}__${getToday()}`) || 0; }

// FIX 1: relaxed regex {10,12} to match both 10 and 11 char video IDs
function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{10,12})/);
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

// FIX 2: relaxed quality check - was rejecting valid transcripts
function getTranscriptQuality(transcript) {
  if (!transcript || transcript.length < MIN_TRANSCRIPT_LENGTH) return "low";

  // Reject pure junk: very low alpha ratio (relaxed from 0.4 to 0.25)
  const alphaChars = (transcript.match(/[a-zA-Z\u0900-\u097F]/g) || []).length;
  const alphaRatio = alphaChars / transcript.length;
  if (alphaRatio < 0.25) return "low";

  // Reject if too few words (relaxed from 20 to 10)
  const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length < 10) return "low";

  // Reject only extremely repetitive (relaxed from 0.2 to 0.1)
  const uniqueWords = new Set(words);
  const uniqueRatio = uniqueWords.size / words.length;
  if (uniqueRatio < 0.1) return "low";

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
    "i cannot summarize",
    "i don't have enough",
    "i'm unable to",
    "no transcript",
    "not enough information",
    "cannot provide a summary",
    "unable to generate",
    "i cannot provide",
    "insufficient data",
    "no meaningful content"
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

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.error("[GEMINI ERROR]", json.error.message);
            return reject(new Error(json.error.message));
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) resolve(text);
          else {
            console.error("[GEMINI] No text in response:", JSON.stringify(json).slice(0, 200));
            reject(new Error("No response from Gemini"));
          }
        } catch (e) {
          console.error("[GEMINI PARSE ERROR]", e.message);
          reject(new Error("Parse error"));
        }
      });
    });
    req.on("error", (e) => { console.error("[GEMINI REQUEST ERROR]", e.message); reject(e); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.write(body);
    req.end();
  });
}

// FIX 3: httpsGet now logs raw response for debugging
function httpsGet(hostname, path, headers) {
  return new Promise((resolve) => {
    const options = { hostname, path, method: "GET", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          console.error(`[HTTPS] Parse fail for ${hostname}${path} — raw:`, data.slice(0, 150));
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      console.error(`[HTTPS ERROR] ${hostname}:`, e.message);
      resolve(null);
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// FIX 4: extractText helper handles all known response formats safely
function extractText(data, fields) {
  if (!data) return null;
  for (const field of fields) {
    const val = data[field];
    if (!val) continue;
    // Handle array of objects with text field (Solid API style)
    if (Array.isArray(val)) {
      const joined = val.map(item =>
        typeof item === "string" ? item :
        item?.text || item?.content || ""
      ).join(" ").replace(/\s+/g, " ").trim();
      if (joined.length >= MIN_TRANSCRIPT_LENGTH) return joined;
    }
    // Handle plain string
    if (typeof val === "string" && val.length >= MIN_TRANSCRIPT_LENGTH) return val;
  }
  return null;
}

// ── TRANSCRIPT SOURCES ─────────────────────────────────────

async function trySupadata(videoId) {
  if (!SUPADATA_KEY) { console.log("[SUPADATA] Key missing"); return null; }
  console.log("[SUPADATA] Trying videoId:", videoId);
  const data = await httpsGet(
    "api.supadata.ai",
    `/v1/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
    { "x-api-key": SUPADATA_KEY }
  );
  console.log("[SUPADATA] Raw keys:", data ? Object.keys(data) : "null");
  // Supadata returns { content: string|array, text: string }
  const text = extractText(data, ["content", "text"]);
  console.log("[SUPADATA] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid1(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID1-Solid] Trying videoId:", videoId);
  const data = await httpsGet(
    "youtube-transcripts.p.rapidapi.com",
    `/youtube/transcript?videoId=${videoId}&chunkSize=500`,
    { "x-rapidapi-host": "youtube-transcripts.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID1-Solid] Raw keys:", data ? Object.keys(data) : "null");
  // Solid API returns { content: [{text: "..."}] }
  const text = extractText(data, ["content", "transcript", "text"]);
  console.log("[RAPID1-Solid] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid2(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID2-LeadXpert] Trying videoId:", videoId);
  const data = await httpsGet(
    "youtube2transcript.p.rapidapi.com",
    `/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube2transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID2-LeadXpert] Raw keys:", data ? Object.keys(data) : "null");
  const text = extractText(data, ["transcript", "text", "content"]);
  console.log("[RAPID2-LeadXpert] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid3(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID3-Blazing] Trying videoId:", videoId);
  const data = await httpsGet(
    "fetch-youtube-transcript.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "fetch-youtube-transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID3-Blazing] Raw keys:", data ? Object.keys(data) : "null");
  const text = extractText(data, ["transcript", "text", "content"]);
  console.log("[RAPID3-Blazing] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid4(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID4-Apicity] Trying videoId:", videoId);
  const data = await httpsGet(
    "youtube-transcript3.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID4-Apicity] Raw keys:", data ? Object.keys(data) : "null");
  const text = extractText(data, ["transcript", "text", "content"]);
  console.log("[RAPID4-Apicity] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid5(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID5-YTScript] Trying videoId:", videoId);
  const data = await httpsGet(
    "ytscript.p.rapidapi.com",
    `/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "ytscript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID5-YTScript] Raw keys:", data ? Object.keys(data) : "null");
  const text = extractText(data, ["transcript", "text", "content"]);
  console.log("[RAPID5-YTScript] Text length:", text ? text.length : 0);
  return text;
}

async function tryRapid6(videoId) {
  if (!RAPIDAPI_KEY) return null;
  console.log("[RAPID6-WAVALIDAT] Trying videoId:", videoId);
  const data = await httpsGet(
    "youtube-transcript-generator.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube-transcript-generator.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  console.log("[RAPID6-WAVALIDAT] Raw keys:", data ? Object.keys(data) : "null");
  const text = extractText(data, ["transcript", "text", "content"]);
  console.log("[RAPID6-WAVALIDAT] Text length:", text ? text.length : 0);
  return text;
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
        console.log(`[TRANSCRIPT] SUCCESS via ${source.name}, length: ${text.length}`);
        return { text, source: source.name };
      }
      console.log(`[TRANSCRIPT] ${source.name} returned nothing, trying next...`);
    } catch (e) {
      console.error(`[TRANSCRIPT] ${source.name} threw error:`, e.message);
    }
  }
  console.log("[TRANSCRIPT] All sources exhausted — no transcript found");
  return null;
}

async function summarizeFromTranscript(transcript, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi" ? "Respond entirely in Hindi." : "Respond in English.";
  const chunk = transcript.slice(0, isDetailed ? 12000 : 8000);
  const strict = `IMPORTANT RULES:\n- Use ONLY the transcript text provided below.\n- Do NOT invent facts, scenes, timestamps, or claims not present in the transcript.\n- Do NOT guess what the video might be about.\n- If the transcript is unclear, summarize only what is clearly stated.`;
  const prompt = isDetailed
    ? `You are an expert summarizer. ${langNote}\n${strict}\n\nWrite a DETAILED summary in plain text, no emojis:\n\nDetailed Video Summary\n\nOverview\n[4-5 sentences from transcript]\n\nKey Points\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n\nConclusion\n[2-3 sentences]\n\nTranscript:\n${chunk}`
    : `You are an expert summarizer. ${langNote}\n${strict}\n\nWrite a SHORT summary in plain text, no emojis:\n\nVideo Summary\n\nOverview\n[2-3 sentences from transcript]\n\nKey Points\n- [from transcript]\n- [from transcript]\n- [from transcript]\n- [from transcript]\n\nTranscript:\n${chunk}`;
  return callGemini(prompt);
}

// ── MAIN ROUTE ─────────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  analytics.totalRequests++;
  const clientIP = getClientIP(req);
  console.log(`\n[REQUEST] from ${clientIP}`);

  if (isLimitReached(clientIP)) {
    console.log("[RATE LIMIT] hit for", clientIP);
    return res.status(429).json({ success: false, code: "rate_limit", error: "Daily limit reached. Try again tomorrow.", usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT } });
  }

  if (!GEMINI_API_KEY) {
    console.error("[CONFIG] GEMINI_API_KEY missing!");
    return res.status(500).json({ success: false, code: "server_error", error: "Server misconfigured." });
  }

  const { videoUrl, language = "English", summaryType = "short" } = req.body;
  console.log(`[REQUEST] url=${videoUrl} lang=${language} type=${summaryType}`);

  if (!videoUrl) return res.status(400).json({ success: false, code: "invalid_url", error: "Please provide a YouTube URL." });

  const videoId = extractVideoId(videoUrl);
  console.log("[VIDEO ID]", videoId);
  if (!videoId) return res.status(400).json({ success: false, code: "invalid_url", error: "Invalid YouTube URL. Please check and try again." });

  const short = isShort(videoUrl);

  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    analytics.cacheHits++;
    console.log("[CACHE] Hit for", cacheKey);
    const cachedMusicWarning = cached.isMusicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;
    return res.json({ success: true, summary: cached.summary, title: cached.title, channel: cached.channel, sourceUsed: cached.sourceUsed, confidence: cached.confidence, isShort: short, isMusicLike: cached.isMusicLike, musicWarning: cachedMusicWarning, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT }, fromCache: true });
  }

  try {
    const videoInfo = await fetchVideoInfo(videoId);
    console.log("[VIDEO INFO]", videoInfo.title);

    const result = await fetchTranscript(videoId);

    if (!result) {
      analytics.transcriptNotFound++;
      if (short) {
        analytics.shortsRejected++;
        console.log("[SHORTS] No transcript for short");
        return res.status(404).json({ success: false, code: "transcript_not_found", error: "This YouTube Short does not have enough transcript data to generate a reliable summary.", isShort: true });
      }
      console.log("[TRANSCRIPT] Not found for", videoId);
      return res.status(404).json({ success: false, code: "transcript_not_found", error: "No transcript found for this video. The video may not have captions enabled." });
    }

    const { text: transcript, source: sourceUsed } = result;

    if (sourceUsed === "supadata") analytics.supadataHits++;
    else if (sourceUsed === "rapid_solid") analytics.rapid1Hits++;
    else if (sourceUsed === "rapid_leadxpert") analytics.rapid2Hits++;
    else if (sourceUsed === "rapid_blazing") analytics.rapid3Hits++;
    else if (sourceUsed === "rapid_apicity") analytics.rapid4Hits++;
    else if (sourceUsed === "rapid_ytscript") analytics.rapid5Hits++;
    else if (sourceUsed === "rapid_wavalidat") analytics.rapid6Hits++;

    const quality = getTranscriptQuality(transcript);
    console.log("[QUALITY]", quality, "| length:", transcript.length);

    if (quality === "low") {
      analytics.notEnoughData++;
      console.log("[QUALITY] Rejected as low quality");
      return res.status(422).json({ success: false, code: "not_enough_data", error: "Not enough transcript data available for an accurate summary." });
    }

    const musicLike = isMusicLike(videoInfo.title, transcript);
    console.log("[MUSIC LIKE]", musicLike);

    let summary = null;
    try {
      console.log("[GEMINI] Calling API...");
      summary = await Promise.race([
        summarizeFromTranscript(transcript, language, summaryType),
        new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))
      ]);
      console.log("[GEMINI] Response length:", summary ? summary.length : 0);
    } catch (err) {
      if (err.message === "TIMEOUT") {
        console.error("[GEMINI] Timed out");
        return res.status(504).json({ success: false, code: "summary_timeout", error: "Summary generation timed out. Please try again." });
      }
      console.error("[GEMINI] Failed:", err.message);
      analytics.geminiFails++;
      return res.status(500).json({ success: false, code: "server_error", error: "Summary generation failed. Please try again." });
    }

    if (!summary || !isValidSummary(summary)) {
      analytics.geminiFails++;
      console.log("[GEMINI] Invalid summary — too short or filler");
      return res.status(422).json({ success: false, code: "not_enough_data", error: "Not enough transcript data available for an accurate summary." });
    }

    const confidence = getConfidence(quality);

    if (summaryCache.size >= MAX_CACHE_ENTRIES) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(cacheKey, { summary, title: videoInfo.title, channel: videoInfo.channel, sourceUsed, confidence, isMusicLike: musicLike, createdAt: Date.now() });

    analytics.successfulSummaries++;
    incrementUsage(clientIP);
    console.log("[SUCCESS]", videoId, "via", sourceUsed, "| confidence:", confidence);

    const musicWarning = musicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;

    return res.json({ success: true, summary, title: videoInfo.title, channel: videoInfo.channel, sourceUsed, confidence, isShort: short, isMusicLike: musicLike, musicWarning, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT } });

  } catch (err) {
    console.error("[UNHANDLED ERROR]", err.message, err.stack);
    analytics.geminiFails++;
    return res.status(500).json({ success: false, code: "server_error", error: "Something went wrong. Please try again." });
  }
});

app.get("/api/usage", (req, res) => res.json({ used: getUsageCount(getClientIP(req)), limit: DAILY_LIMIT }));
app.get("/api/stats", (req, res) => res.json({ ...analytics, cacheSize: summaryCache.size }));
app.get("/", (req, res) => res.send("Sumora Backend Running!"));

process.on("uncaughtException", err => console.error("[UNCAUGHT]", err.message));
process.on("unhandledRejection", reason => console.error("[UNHANDLED]", reason));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[START] Sumora running on port ${PORT}`);
  console.log(`[CONFIG] GEMINI_API_KEY: ${GEMINI_API_KEY ? "SET" : "MISSING"}`);
  console.log(`[CONFIG] SUPADATA_KEY: ${SUPADATA_KEY ? "SET" : "MISSING"}`);
  console.log(`[CONFIG] RAPIDAPI_KEY: ${RAPIDAPI_KEY ? "SET" : "MISSING"}`);
});
