const express = require("express");
const cors = require("cors");
const https = require("https");
const helmet = require("helmet");

// ─── CONFIG ───────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 5000;

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set.");
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── RATE LIMITER ─────────────────────────────────────────
const rateLimitMap = new Map();
const DAILY_LIMIT = 3;

// ─── SUMMARY CACHE ────────────────────────────────────────
const summaryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of summaryCache) {
    if (now - val.createdAt > CACHE_TTL) summaryCache.delete(key);
  }
}, 30 * 60 * 1000);

// ─── ANALYTICS ────────────────────────────────────────────
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
  return (rateLimitMap.get(key) || 0) >= DAILY_LIMIT;
}

function incrementUsage(ip) {
  const today = getToday();
  const key = `${ip}__${today}`;
  rateLimitMap.set(key, (rateLimitMap.get(key) || 0) + 1);
}

function getUsageCount(ip) {
  const key = `${ip}__${getToday()}`;
  return rateLimitMap.get(key) || 0;
}

function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

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

// ─── GEMINI DIRECT API CALL (No SDK) ──────────────────────
function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || "Gemini API error"));
          } else {
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) resolve(text);
            else reject(new Error("No response from Gemini"));
          }
        } catch (e) {
          reject(new Error("Failed to parse Gemini response"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function generateSummary(videoUrl, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi"
    ? "Respond entirely in Hindi language."
    : "Respond in English.";

  const prompt = isDetailed
    ? `You are an expert content summarizer. ${langNote}

You are given a YouTube video URL. Based on the content available at this URL, provide a DETAILED summary in this exact format using plain text only, no emojis:

Detailed Video Summary

Overview
Write 4-5 sentences summarizing the video.

Key Moments
00:00 - Topic 1
01:30 - Topic 2
03:00 - Topic 3
05:00 - Topic 4

Key Points
- Point 1
- Point 2
- Point 3
- Point 4
- Point 5
- Point 6
- Point 7

Conclusion
Write 2-3 sentences concluding the video.

YouTube URL: ${videoUrl}`
    : `You are an expert content summarizer. ${langNote}

You are given a YouTube video URL. Based on the content available at this URL, provide a SHORT summary in this exact format using plain text only, no emojis:

Video Summary

Overview
Write 2-3 sentences summarizing the video.

Key Moments
00:00 - Topic 1
01:20 - Topic 2
02:45 - Topic 3
04:10 - Topic 4

Key Points
- Point 1
- Point 2
- Point 3
- Point 4

YouTube URL: ${videoUrl}`;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), 30000)
  );

  return Promise.race([callGemini(prompt), timeoutPromise]);
}

// ─── MAIN ROUTE ───────────────────────────────────────────
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
    return res.status(500).json({ success: false, error: "GEMINI_API_KEY is not set." });
  }

  const { videoUrl, language = "English", summaryType = "short" } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ success: false, error: "Video URL is required." });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ success: false, error: "Invalid YouTube URL." });
  }

  const cacheKey = `${videoId}_${language}_${summaryType}`;
  const cached = summaryCache.get(cacheKey);

  if (cached) {
    if (Date.now() - cached.createdAt > CACHE_TTL) {
      summaryCache.delete(cacheKey);
    } else {
      analytics.cacheHits++;
      return res.json({
        success: true,
        summary: cached.summary,
        title: cached.title,
        channel: cached.channel,
        usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT },
        fromCache: true
      });
    }
  }

  try {
    const [summary, videoInfo] = await Promise.all([
      generateSummary(videoUrl, language, summaryType),
      fetchVideoInfo(videoId)
    ]);

    if (summaryCache.size >= MAX_CACHE_ENTRIES) {
      summaryCache.delete(summaryCache.keys().next().value);
    }

    summaryCache.set(cacheKey, {
      summary, title: videoInfo.title, channel: videoInfo.channel, createdAt: Date.now()
    });

    analytics.successfulSummaries++;
    incrementUsage(clientIP);

    return res.json({
      success: true,
      summary,
      title: videoInfo.title,
      channel: videoInfo.channel,
      usage: { used: getUsageCount(clientIP), limit: DAILY_LIMIT }
    });

  } catch (err) {
    console.error("Server error:", err.message);
    analytics.geminiFails++;

    if (err.message === "TIMEOUT") {
      return res.status(504).json({ success: false, code: "gemini_failed", error: "Request timed out." });
    }

    return res.status(500).json({ success: false, code: "server_error", error: "Something went wrong. Please try again." });
  }
});

app.get("/api/usage", (req, res) => {
  res.json({ used: getUsageCount(getClientIP(req)), limit: DAILY_LIMIT });
});

app.get("/api/stats", (req, res) => {
  res.json({ ...analytics, cacheSize: summaryCache.size, activeIPs: rateLimitMap.size });
});

app.get("/", (req, res) => res.send("Sumora Backend Running!"));

process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err.message));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sumora server running on port ${PORT}`);
});

