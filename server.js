const express = require("express");
const cors = require("cors");
const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { YoutubeTranscript } = require("youtube-transcript");

// ─── CONFIG ───────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 5000;

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set. Summarize route will not work.");
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── RATE LIMITER (In-Memory, 3 requests/day per IP) ──────
const rateLimitMap = new Map();
const DAILY_LIMIT = 3;

function getToday() {
  return new Date().toISOString().slice(0, 10); // "2026-02-27"
}

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
}

function checkRateLimit(ip) {
  const today = getToday();
  const key = `${ip}__${today}`;

  // Clean old entries (different day)
  for (const [k] of rateLimitMap) {
    if (!k.endsWith(today)) rateLimitMap.delete(k);
  }

  const count = rateLimitMap.get(key) || 0;

  if (count >= DAILY_LIMIT) return false;

  rateLimitMap.set(key, count + 1);
  return true;
}

// ─── HELPER: Extract YouTube Video ID ─────────────────────
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// ─── HELPER: Fetch Transcript ──────────────────────────────
async function fetchTranscript(videoId) {
  try {
    const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
    if (!transcriptData || transcriptData.length === 0) return null;
    return transcriptData.map(item => item.text).join(" ");
  } catch (err) {
    console.error("Transcript error:", err.message);
    return null;
  }
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
          resolve({
            title: json.title || "YouTube Video",
            channel: json.author_name || "Unknown Channel"
          });
        } catch {
          resolve({ title: "YouTube Video", channel: "Unknown Channel" });
        }
      });
    }).on("error", () => {
      resolve({ title: "YouTube Video", channel: "Unknown Channel" });
    });
  });
}

// ─── HELPER: Generate Summary via Gemini ──────────────────
async function generateSummary(transcript, language, summaryType) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi"
    ? "Respond entirely in Hindi language."
    : "Respond in English.";

  const prompt = isDetailed
    ? `You are an expert summarizer. ${langNote}

Provide a DETAILED summary of this YouTube video transcript with:
1. Overview (4-5 sentences)
2. Key Points (at least 7 bullet points)
3. Conclusion (2-3 sentences)

Transcript:
${transcript.slice(0, 12000)}`
    : `You are an expert summarizer. ${langNote}

Provide a SHORT summary of this YouTube video transcript with:
1. Brief Overview (2-3 sentences)
2. Key Points (4-5 bullet points)

Transcript:
${transcript.slice(0, 8000)}`;

  const result = await model.generateContent({
    contents: [{ parts: [{ text: prompt }] }]
  });

  return result.response.text();
}

// ─── MAIN ROUTE: POST /api/summarize ──────────────────────
app.post("/api/summarize", async (req, res) => {
  // ── Rate Limit Check ──
  const clientIP = getClientIP(req);
  const allowed = checkRateLimit(clientIP);

  if (!allowed) {
    return res.status(429).json({
      success: false,
      error: "Daily free limit reached. Please try again tomorrow."
    });
  }

  // ── API Key Check ──
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

  try {
    // Fetch transcript + video info in parallel
    const [transcript, videoInfo] = await Promise.all([
      fetchTranscript(videoId),
      fetchVideoInfo(videoId)
    ]);

    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: "Transcript not available for this video. Try a video with subtitles enabled."
      });
    }

    const summary = await generateSummary(transcript, language, summaryType);

    return res.json({
      success: true,
      summary,
      title: videoInfo.title,
      channel: videoInfo.channel
    });

  } catch (err) {
    console.error("Server error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again."
    });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Sumora Backend Running!");
});

// ─── START SERVER ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Sumora server running on port ${PORT}`);
});
