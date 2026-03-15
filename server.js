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
const MIN_TRANSCRIPT_LENGTH = 200;

setInterval(() => {
  const now = Date.now();
  // Clean expired cache entries
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
  // Clean old rate limit keys (keep only today's)
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

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
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

  // Reject junk: too many non-alphabetic characters
  const alphaChars = (transcript.match(/[a-zA-Z\u0900-\u097F]/g) || []).length;
  const alphaRatio = alphaChars / transcript.length;
  if (alphaRatio < 0.4) return "low"; // mostly symbols/numbers/junk

  // Reject repetitive: check if same phrase repeats too much
  const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length < 20) return "low"; // too few meaningful words
  const uniqueWords = new Set(words);
  const uniqueRatio = uniqueWords.size / words.length;
  if (uniqueRatio < 0.2) return "low"; // extremely repetitive

  if (transcript.length < 800) return "medium";
  return "high";
}

function getConfidence(quality) {
  if (quality === "high") return "High";
  if (quality === "medium") return "Medium";
  return "Low";
}

// Validate Gemini output — reject weak/filler responses
function isValidSummary(text) {
  if (!text || text.trim().length < 100) return false;
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
      path: `/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
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
          else reject(new Error("No response"));
        } catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

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

async function trySupadata(videoId) {
  if (!SUPADATA_KEY) return null;
  const data = await httpsGet("api.supadata.ai", `/v1/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`, { "x-api-key": SUPADATA_KEY });
  const text = data?.content || data?.text || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid1(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcripts.p.rapidapi.com", `/youtube/transcript?videoId=${videoId}&chunkSize=500`, { "x-rapidapi-host": "youtube-transcripts.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  if (!data?.content) return null;
  const text = data.content.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();
  return text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid2(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube2transcript.p.rapidapi.com", `/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube2transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  const text = data?.transcript || data?.text || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid3(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("fetch-youtube-transcript.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "fetch-youtube-transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  const text = data?.transcript || data?.text || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid4(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcript3.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  const text = data?.transcript || data?.text || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid5(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("ytscript.p.rapidapi.com", `/transcript?videoId=${videoId}`, { "x-rapidapi-host": "ytscript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  const text = data?.transcript || data?.text || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
}

async function tryRapid6(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet("youtube-transcript-generator.p.rapidapi.com", `/api/transcript?videoId=${videoId}`, { "x-rapidapi-host": "youtube-transcript-generator.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY });
  const text = data?.transcript || data?.text || data?.content || null;
  return text && text.length >= MIN_TRANSCRIPT_LENGTH ? text : null;
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
      if (text) return { text, source: source.name };
    } catch { continue; }
  }
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

app.post("/api/summarize", async (req, res) => {
  analytics.totalRequests++;
  const clientIP = getClientIP(req);

  if (isLimitReached(clientIP)) {
    return res.status(429).json({ success: false, code: "rate_limit", error: "Daily limit reached. Try again tomorrow.", usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT } });
  }

  if (!GEMINI_API_KEY) return res.status(500).json({ success: false, code: "server_error", error: "Server misconfigured." });

  const { videoUrl, language = "English", summaryType = "short" } = req.body;

  if (!videoUrl) return res.status(400).json({ success: false, code: "invalid_url", error: "Please provide a YouTube URL." });

  const videoId = extractVideoId(videoUrl);
  if (!videoId) return res.status(400).json({ success: false, code: "invalid_url", error: "Invalid YouTube URL. Please check and try again." });

  const short = isShort(videoUrl);

  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    analytics.cacheHits++;
    const cachedMusicWarning = cached.isMusicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;
    return res.json({ success: true, summary: cached.summary, title: cached.title, channel: cached.channel, sourceUsed: cached.sourceUsed, confidence: cached.confidence, isShort: short, isMusicLike: cached.isMusicLike, musicWarning: cachedMusicWarning, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT }, fromCache: true });
  }

  try {
    const videoInfo = await fetchVideoInfo(videoId);
    const result = await fetchTranscript(videoId);

    if (!result) {
      analytics.transcriptNotFound++;
      if (short) {
        analytics.shortsRejected++;
        return res.status(404).json({ success: false, code: "transcript_not_found", error: "This YouTube Short does not have enough transcript data to generate a reliable summary.", isShort: true });
      }
      return res.status(404).json({ success: false, code: "transcript_not_found", error: "No transcript found for this video. The video may not have captions enabled." });
    }

    const { text: transcript, source: sourceUsed } = result;

    // Increment analytics counter for whichever source succeeded
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
      return res.status(422).json({ success: false, code: "not_enough_data", error: "Not enough transcript data available for an accurate summary." });
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
      return res.status(500).json({ success: false, code: "server_error", error: "Summary generation failed. Please try again." });
    }

    if (!summary || !isValidSummary(summary)) {
      analytics.geminiFails++;
      return res.status(422).json({ success: false, code: "not_enough_data", error: "Not enough transcript data available for an accurate summary." });
    }

    const confidence = getConfidence(quality);

    if (summaryCache.size >= MAX_CACHE_ENTRIES) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(cacheKey, { summary, title: videoInfo.title, channel: videoInfo.channel, sourceUsed, confidence, isMusicLike: musicLike, createdAt: Date.now() });

    analytics.successfulSummaries++;
    incrementUsage(clientIP); // only increment on fresh summary, not cache hits

    const musicWarning = musicLike ? "This video appears to be music or low-dialogue content. Summary accuracy may be limited." : null;

    return res.json({ success: true, summary, title: videoInfo.title, channel: videoInfo.channel, sourceUsed, confidence, isShort: short, isMusicLike: musicLike, musicWarning, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT } });

  } catch (err) {
    console.error("Error:", err.message);
    analytics.geminiFails++;
    return res.status(500).json({ success: false, code: "server_error", error: "Something went wrong. Please try again." });
  }
});

app.get("/api/usage", (req, res) => res.json({ used: getUsageCount(getClientIP(req)), limit: DAILY_LIMIT }));
app.get("/api/stats", (req, res) => res.json({ ...analytics, cacheSize: summaryCache.size }));
app.get("/", (req, res) => res.send("Sumora Backend Running!"));

process.on("uncaughtException", err => console.error("Exception:", err.message));
process.on("unhandledRejection", reason => console.error("Rejection:", reason));

app.listen(PORT, "0.0.0.0", () => console.log(`Sumora running on port ${PORT}`));
