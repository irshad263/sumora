const express = require("express");
const cors = require("cors");
const https = require("https");
const helmet = require("helmet");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPADATA_KEY = process.env.SUPADATA_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY; // Solid API - youtube-transcripts.p.rapidapi.com
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

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
}, 30 * 60 * 1000);

const analytics = {
  totalRequests: 0, cacheHits: 0, geminiFails: 0, successfulSummaries: 0,
  geminiUrlHits: 0, supadataHits: 0,
  rapid1Hits: 0, rapid2Hits: 0, rapid3Hits: 0, rapid4Hits: 0
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

// ─── GEMINI API ───────────────────────────────────────────
function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
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

// ─── HTTPS HELPER ─────────────────────────────────────────
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

// ─── METHOD 1: GEMINI URL (Unlimited FREE) ────────────────
async function tryGeminiUrl(videoUrl, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi" ? "Respond entirely in Hindi." : "Respond in English.";

  const prompt = isDetailed
    ? `You are an expert YouTube video summarizer. ${langNote}
If you have knowledge about this specific video, provide a DETAILED summary in plain text, no emojis:

Detailed Video Summary

Overview
[4-5 sentences about actual video content]

Key Points
- [actual point]
- [actual point]
- [actual point]
- [actual point]
- [actual point]
- [actual point]
- [actual point]

Conclusion
[2-3 sentences]

If you do NOT have specific knowledge about this video, respond with exactly: NEEDS_TRANSCRIPT

YouTube URL: ${videoUrl}`
    : `You are an expert YouTube video summarizer. ${langNote}
If you have knowledge about this specific video, provide a SHORT summary in plain text, no emojis:

Video Summary

Overview
[2-3 sentences about actual video content]

Key Points
- [actual point]
- [actual point]
- [actual point]
- [actual point]

If you do NOT have specific knowledge about this video, respond with exactly: NEEDS_TRANSCRIPT

YouTube URL: ${videoUrl}`;

  const result = await callGemini(prompt);
  if (result.includes("NEEDS_TRANSCRIPT") || result.includes("I don't have") || result.includes("I cannot access")) {
    return null;
  }
  return result;
}

// ─── METHOD 2: SUPADATA ───────────────────────────────────
async function trySupadata(videoId) {
  if (!SUPADATA_KEY) return null;
  const data = await httpsGet(
    "api.supadata.ai",
    `/v1/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
    { "x-api-key": SUPADATA_KEY }
  );
  const text = data?.content || data?.text || null;
  return text && text.length > 50 ? text : null;
}

// ─── METHOD 3: RAPID API 1 - Solid API ───────────────────
async function tryRapid1(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "youtube-transcripts.p.rapidapi.com",
    `/youtube/transcript?videoId=${videoId}&chunkSize=500`,
    { "x-rapidapi-host": "youtube-transcripts.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  if (!data?.content) return null;
  const text = data.content.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 50 ? text : null;
}

// ─── METHOD 4: RAPID API 2 - LeadXpert ───────────────────
async function tryRapid2(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "youtube2transcript.p.rapidapi.com",
    `/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube2transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  const text = data?.transcript || data?.text || null;
  return text && text.length > 50 ? text : null;
}

// ─── METHOD 5: RAPID API 3 - Blazing Fast ────────────────
async function tryRapid3(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "fetch-youtube-transcript.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "fetch-youtube-transcript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  const text = data?.transcript || data?.text || null;
  return text && text.length > 50 ? text : null;
}

// ─── METHOD 6: RAPID API 4 - Api-city ────────────────────
async function tryRapid4(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "youtube-transcript3.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  const text = data?.transcript || data?.text || null;
  return text && text.length > 50 ? text : null;
}

// ─── METHOD 7: RAPID API 5 - YTScript ────────────────────
async function tryRapid5(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "ytscript.p.rapidapi.com",
    `/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "ytscript.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  const text = data?.transcript || data?.text || null;
  return text && text.length > 50 ? text : null;
}

// ─── METHOD 8: RAPID API 6 - WAVALIDAT YouTube Transcript Generator ──
async function tryRapid6(videoId) {
  if (!RAPIDAPI_KEY) return null;
  const data = await httpsGet(
    "youtube-transcript-generator.p.rapidapi.com",
    `/api/transcript?videoId=${videoId}`,
    { "x-rapidapi-host": "youtube-transcript-generator.p.rapidapi.com", "x-rapidapi-key": RAPIDAPI_KEY }
  );
  const text = data?.transcript || data?.text || data?.content || null;
  return text && text.length > 50 ? text : null;
}

// ─── SUMMARIZE FROM TRANSCRIPT ────────────────────────────
async function summarizeFromTranscript(transcript, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi" ? "Respond entirely in Hindi." : "Respond in English.";
  const chunk = transcript.slice(0, isDetailed ? 12000 : 8000);

  const prompt = isDetailed
    ? `You are an expert summarizer. ${langNote} Summarize this transcript. Plain text, no emojis.\n\nDetailed Video Summary\n\nOverview\n[4-5 sentences]\n\nKey Points\n- point\n- point\n- point\n- point\n- point\n- point\n- point\n\nConclusion\n[2-3 sentences]\n\nTranscript:\n${chunk}`
    : `You are an expert summarizer. ${langNote} Summarize this transcript. Plain text, no emojis.\n\nVideo Summary\n\nOverview\n[2-3 sentences]\n\nKey Points\n- point\n- point\n- point\n- point\n\nTranscript:\n${chunk}`;

  return callGemini(prompt);
}

// ─── MAIN ROUTE ───────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  analytics.totalRequests++;
  const clientIP = getClientIP(req);

  if (isLimitReached(clientIP)) {
    return res.status(429).json({ success: false, code: "rate_limit", error: "Daily limit reached. Try tomorrow.", usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT } });
  }

  if (!GEMINI_API_KEY) return res.status(500).json({ success: false, error: "GEMINI_API_KEY not set." });

  const { videoUrl, language = "English", summaryType = "short" } = req.body;
  if (!videoUrl) return res.status(400).json({ success: false, error: "Video URL required." });

  const videoId = extractVideoId(videoUrl);
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL." });

  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    analytics.cacheHits++;
    return res.json({ success: true, summary: cached.summary, title: cached.title, channel: cached.channel, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT }, fromCache: true });
  }

  try {
    const videoInfo = await fetchVideoInfo(videoId);
    let summary = null;
    let method = "";

    // STEP 1: Gemini URL - FREE unlimited
    try {
      summary = await Promise.race([
        tryGeminiUrl(videoUrl, language, summaryType),
        new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 20000))
      ]);
      if (summary) { analytics.geminiUrlHits++; method = "gemini_url"; }
    } catch { summary = null; }

    // STEP 2: Supadata - 100/month
    if (!summary) {
      const t = await trySupadata(videoId);
      if (t) {
        analytics.supadataHits++; method = "supadata";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 3: Solid API - 100/month
    if (!summary) {
      const t = await tryRapid1(videoId);
      if (t) {
        analytics.rapid1Hits++; method = "rapid_solid";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 4: LeadXpert - 150/month
    if (!summary) {
      const t = await tryRapid2(videoId);
      if (t) {
        analytics.rapid2Hits++; method = "rapid_leadxpert";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 5: Blazing Fast - 100/month
    if (!summary) {
      const t = await tryRapid3(videoId);
      if (t) {
        analytics.rapid3Hits++; method = "rapid_blazing";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 6: Api-city - 100/month
    if (!summary) {
      const t = await tryRapid4(videoId);
      if (t) {
        analytics.rapid4Hits++; method = "rapid_apicity";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 7: YTScript - 300/month
    if (!summary) {
      const t = await tryRapid5(videoId);
      if (t) {
        method = "rapid_ytscript";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    // STEP 8: WAVALIDAT YouTube Transcript Generator - 300/month
    if (!summary) {
      const t = await tryRapid6(videoId);
      if (t) {
        method = "rapid_wavalidat";
        summary = await Promise.race([summarizeFromTranscript(t, language, summaryType), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), 30000))]);
      }
    }

    if (!summary) {
      return res.status(404).json({ success: false, code: "unavailable", error: "Could not generate summary for this video. Please try another video." });
    }

    if (summaryCache.size >= MAX_CACHE_ENTRIES) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(cacheKey, { summary, title: videoInfo.title, channel: videoInfo.channel, createdAt: Date.now() });

    analytics.successfulSummaries++;
    incrementUsage(clientIP);

    return res.json({ success: true, summary, title: videoInfo.title, channel: videoInfo.channel, usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT }, method });

  } catch (err) {
    console.error("Error:", err.message);
    analytics.geminiFails++;
    if (err.message === "TIMEOUT") return res.status(504).json({ success: false, code: "gemini_failed", error: "Request timed out." });
    return res.status(500).json({ success: false, code: "server_error", error: "Something went wrong. Please try again." });
  }
});

app.get("/api/usage", (req, res) => res.json({ used: getUsageCount(getClientIP(req)), limit: DAILY_LIMIT }));
app.get("/api/stats", (req, res) => res.json({ ...analytics, cacheSize: summaryCache.size }));
app.get("/", (req, res) => res.send("Sumora Backend Running!"));

process.on("uncaughtException", err => console.error("Exception:", err.message));
process.on("unhandledRejection", reason => console.error("Rejection:", reason));

app.listen(PORT, "0.0.0.0", () => console.log(`Sumora running on port ${PORT}`));

