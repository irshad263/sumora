const express = require("express");
const cors = require("cors");
const https = require("https");
const helmet = require("helmet");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ─── CONFIG ───────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 5000;

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set. Summarize route will not work.");
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── RATE LIMITER (In-Memory, 3 requests/day per IP) ──────
const rateLimitMap = new Map();
const DAILY_LIMIT = 3;

// ─── SUMMARY CACHE (In-Memory) ────────────────────────────
const summaryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

// Auto-cleanup expired cache every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
}, 30 * 60 * 1000);

// ─── ANALYTICS (In-Memory) ────────────────────────────────
const analytics = {
  totalRequests: 0,
  cacheHits: 0,
  geminiFails: 0,
  successfulSummaries: 0
};

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
}

function isLimitReached(ip) {
  const today = getToday();
  const key = `${ip}__${today}`;
  for (const [k] of rateLimitMap) {
    if (!k.endsWith(today)) rateLimitMap.delete(k);
  }
  const count = rateLimitMap.get(key) || 0;
  return count >= DAILY_LIMIT;
}

function incrementUsage(ip) {
  const today = getToday();
  const key = `${ip}__${today}`;
  const count = rateLimitMap.get(key) || 0;
  rateLimitMap.set(key, count + 1);
}

function getUsageCount(ip) {
  const today = getToday();
  const key = `${ip}__${today}`;
  return rateLimitMap.get(key) || 0;
}

// ─── HELPER: Extract YouTube Video ID ─────────────────────
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// ─── HELPER: Fetch Title & Channel via YouTube oEmbed ─────
function fetchVideoInfo(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ title: json.title || "YouTube Video", channel: json.author_name || "Unknown Channel" });
        } catch {
          resolve({ title: "YouTube Video", channel: "Unknown Channel" });
        }
      });
    }).on("error", () => {
      resolve({ title: "YouTube Video", channel: "Unknown Channel" });
    });
  });
}

// ─── HELPER: Generate Summary via Gemini (Direct URL) ─────
async function generateSummary(videoUrl, language, summaryType) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi"
    ? "Respond entirely in Hindi language."
    : "Respond in English.";

  const prompt = isDetailed
    ? `You are an expert content summarizer. ${langNote}

You are given a YouTube video URL. Based on the content available at this URL, provide a DETAILED summary with:
1. Overview (4-5 sentences)
2. Key Points (at least 7 bullet points)
3. Conclusion (2-3 sentences)

YouTube URL: ${videoUrl}`
    : `You are an expert content summarizer. ${langNote}

You are given a YouTube video URL. Based on the content available at this URL, provide a SHORT summary with:
1. Brief Overview (2-3 sentences)
2. Key Points (4-5 bullet points)

YouTube URL: ${videoUrl}`;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), 30000)
  );

  const geminiPromise = model.generateContent(prompt);

  const result = await Promise.race([geminiPromise, timeoutPromise]);
  return result.response.text();
}

// ─── MAIN ROUTE: POST /api/summarize ──────────────────────
app.post("/api/summarize", async (req, res) => {
  analytics.totalRequests++;

  const clientIP = getClientIP(req);

  if (isLimitReached(clientIP)) {
    return res.status(429).json({
      success: false,
      code: "rate_limit",
      error: "Daily free limit reached. Please try again tomorrow.",
      usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT }
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "Server configuration error. GEMINI_API_KEY is not set."
    });
  }

  const { videoUrl, language = "English", summaryType = "short" } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ success: false, error: "Video URL is required." });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ success: false, error: "Invalid YouTube URL. Please check and try again." });
  }

  // ── Cache Check ──
  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);

  if (cached) {
    if (Date.now() - cached.createdAt > CACHE_TTL) {
      summaryCache.delete(cacheKey);
    } else {
      analytics.cacheHits++;
      const usedNow = getUsageCount(clientIP);
      return res.json({
        success: true,
        summary: cached.summary,
        title: cached.title,
        channel: cached.channel,
        usage: { used: usedNow, limit: DAILY_LIMIT },
        fromCache: true
      });
    }
  }

  try {
    // Fetch video info + summary in parallel
    const [summary, videoInfo] = await Promise.all([
      generateSummary(videoUrl, language, summaryType),
      fetchVideoInfo(videoId)
    ]);

    // ── FIFO eviction if cache is full ──
    if (summaryCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = summaryCache.keys().next().value;
      summaryCache.delete(oldestKey);
    }

    // ── Store in cache ──
    summaryCache.set(cacheKey, {
      summary,
      title: videoInfo.title,
      channel: videoInfo.channel,
      createdAt: Date.now()
    });

    // ── Increment only on success ──
    analytics.successfulSummaries++;
    incrementUsage(clientIP);
    const usedAfter = getUsageCount(clientIP);

    return res.json({
      success: true,
      summary,
      title: videoInfo.title,
      channel: videoInfo.channel,
      usage: { used: usedAfter, limit: DAILY_LIMIT }
    });

  } catch (err) {
    console.error("Server error:", err.message);
    analytics.geminiFails++;

    if (err.message === "TIMEOUT") {
      return res.status(504).json({
        success: false,
        code: "gemini_failed",
        error: "Request timed out. Please try again."
      });
    }

    return res.status(500).json({
      success: false,
      code: "server_error",
      error: "Something went wrong. Please try again."
    });
  }
});

// ─── USAGE ROUTE: GET /api/usage ─────────────────────────
app.get("/api/usage", (req, res) => {
  const clientIP = getClientIP(req);
  const used = getUsageCount(clientIP);
  return res.json({ used, limit: DAILY_LIMIT });
});

// ─── STATS ROUTE: GET /api/stats ─────────────────────────
app.get("/api/stats", (req, res) => {
  res.json({ ...analytics, cacheSize: summaryCache.size, activeIPs: rateLimitMap.size });
});

// ─── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Sumora Backend Running!");
});

// ─── GLOBAL ERROR HANDLERS ───────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ─── START SERVER ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Sumora server running on port ${PORT}`);
});
