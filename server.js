const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { YoutubeTranscript } = require("youtube-transcript");
const { Innertube } = require("youtubei.js");

// ─── CONFIG ───────────────────────────────────────────────
const GEMINI_API_KEY = "AIzaSyA5ZH06B4pyPTvczxiW-5r23wNtam5YCi4";
const PORT = process.env.PORT || 5000;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve frontend from /public folder

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
    return null;
  }
}

// ─── HELPER: Fetch Title & Channel ────────────────────────
async function fetchVideoInfo(videoId) {
  try {
    const yt = await Innertube.create({ generate_session_locally: true });
    const info = await yt.getInfo(videoId);
    const title = info.basic_info?.title || "Unknown Title";
    const channel = info.basic_info?.channel?.name || "Unknown Channel";
    return { title, channel };
  } catch (err) {
    return { title: "YouTube Video", channel: "Unknown Channel" };
  }
}

// ─── HELPER: Generate Summary via Gemini ──────────────────
async function generateSummary(transcript, language, summaryType) {
  const isDetailed = summaryType === "detailed";
  const langNote = language === "Hindi" ? "Respond entirely in Hindi language." : "Respond in English.";

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
  const { videoUrl, language = "English", summaryType = "short" } = req.body;

  // Validate URL
  if (!videoUrl) {
    return res.status(400).json({ success: false, error: "Video URL is required." });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ success: false, error: "Invalid YouTube URL. Please check and try again." });
  }

  try {
    // Fetch transcript + video info in parallel for speed
    const [transcript, videoInfo] = await Promise.all([
      fetchTranscript(videoId),
      fetchVideoInfo(videoId)
    ]);

    // Check transcript
    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: "Transcript not available for this video. The video may have subtitles disabled or be restricted."
      });
    }

    // Generate summary
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
      error: "Something went wrong on our end. Please try again."
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
