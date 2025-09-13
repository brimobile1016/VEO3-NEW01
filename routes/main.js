import express from "express";
import multer from "multer";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { Buffer } from "buffer";
import { supabase } from "./supabase.js";
import fetch from "node-fetch";
// import { PassThrough } from 'stream';

const router = express();
const upload = multer({ dest: path.join(os.tmpdir(), "uploads") });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputDir = path.join(__dirname, "public", "video");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// ✅ Serve file statis
router.get("/", (req, res) => {
//  res.sendFile(path.join(__dirname, "views", "index.html"));
  res.sendFile(path.join(__dirname, "..", "views", "index.html"));
});

router.get("/admin", (req, res) => {
//  res.sendFile(path.join(__dirname, "views", "index.html"));
  res.sendFile(path.join(__dirname, "..", "views", "admin.html"));
});

async function retryRequest(fn, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(); // sukses → return hasil
    } catch (error) {
      console.error(`❌ Percobaan ${attempt} gagal:`, error.message);
      if (attempt === maxRetries) throw error; // sudah max → lempar error
      console.log(`⏳ Menunggu ${delayMs / 1000} detik sebelum mencoba ulang...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "Saipul";

const jobs = {};

// ====================== API GENERATE VIDEO ======================
router.post("/generate-video", upload.single("image"), async (req, res) => {
  const { apiKey, prompt, aspectRatio, veoModel } = req.body;
  const file = req.file;

  if (!apiKey) return res.status(400).json({ error: "API Key wajib diisi!" });
  if (!prompt) return res.status(400).json({ error: "Prompt wajib diisi!" });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: "processing", videoUrl: null, error: null };

  (async () => {
    try {
      const ai = new GoogleGenAI({ apiKey });
      let imageData = null;

      if (file) {
        // ✅ Jika user upload gambar
        console.log("📷 [DEBUG] Menggunakan file upload...");
        const imageBytes = fs.readFileSync(file.path);
        imageData = {
          imageBytes: imageBytes.toString("base64"),
          mimeType: file.mimetype,
        };
        fs.unlinkSync(file.path);
      } else {
        // ✅ Jika tidak ada gambar → generate dengan Imagen
        console.log("📷 Tidak ada gambar, generate image via Imagen...");

        const imagenResponse = await ai.models.generateImages({
          model: "imagen-4.0-generate-001",
          prompt,
          config: {
            numberOfImages: 1, // ambil 1 aja biar simple
            aspectRatio: aspectRatio || "16:9",
            sampleImageSize: "1K",
          },
        });

        if (!imagenResponse.generatedImages?.length) {
          jobs[jobId] = { status: "error", error: "Gagal generate gambar dengan Imagen." };
          return;
        }

        const base64Img = imagenResponse.generatedImages[0].b64Json;
        imageData = {
          imageBytes: base64Img,
          mimeType: "image/png",
        };
      }

      // 🎬 Generate video pakai Veo
      let operation = await ai.models.generateVideos({
        model: veoModel || "veo-3.0-generate-001",
        prompt,
        image: imageData,
        config: { numberOfVideos: 1, aspectRatio: aspectRatio || "16:9" },
      });

      while (!operation.done) {
        await new Promise((r) => setTimeout(r, 10000));
        operation = await ai.operations.getVideosOperation({ operation });
      }

      const generatedVideo = operation.response?.generatedVideos?.[0];
      if (!generatedVideo?.video?.uri) {
        jobs[jobId] = { status: "error", error: "Video tidak tersedia." };
        return;
      }

      // 📥 Download video hasil Veo
      const videoUri = generatedVideo.video.uri;
      const response = await fetch(`${videoUri}&key=${apiKey}`);
      const videoBuffer = await response.arrayBuffer();

      if (videoBuffer.byteLength === 0) {
        jobs[jobId] = { status: "error", error: "Data video kosong setelah diunduh." };
        return;
      }

      // ⬆️ Upload ke Supabase
      const fileName = `generated_video_${Math.floor(Math.random() * 99999)}.mp4`;
      const { error: uploadError } = await supabase.storage
        .from("generated-files")
        .upload(`videos/${fileName}`, Buffer.from(videoBuffer), {
          contentType: "video/mp4",
        });

      if (uploadError) {
        jobs[jobId] = { status: "error", error: "Upload gagal ke Supabase." };
        return;
      }

      const { data: publicUrlData } = supabase.storage
        .from("generated-files")
        .getPublicUrl(`videos/${fileName}`);

      jobs[jobId] = {
        status: "done",
        videoUrl: publicUrlData.publicUrl,
      };
    } catch (err) {
      console.error("❌ [ERROR] generate-video:", err);
      // ✅ cek error API key invalid
      if (err.message && err.message.includes("API key not valid")) {
        jobs[jobId] = { status: "error", error: "API Key tidak valid atau salah." };
        return;
      }
      jobs[jobId] = { status: "error", error: err.message };
    }
  })();

  // 🔥 Balikin jobId langsung, biar frontend polling
  res.json({ jobId });
});

// ====================== API CEK STATUS JOB ======================
router.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: "Job tidak ditemukan" });
  }

  res.json(job);
});






// ✅ API untuk generate gambar (penambahan baru)
router.post("/generate-image", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, prompt, imagenModel, aspectRatio, outputResolution } = req.body;

    if (!apiKey) {
      return res.json({ error: "API Key wajib diisi!" });
    }

    if (!prompt) {
      return res.json({ error: "Prompt wajib diisi untuk membuat gambar." });
    }

    const ai = new GoogleGenAI({ apiKey });

    // ✅ Generate gambar dengan Imagen
    const imagenResponse = await retryRequest(() =>
        ai.models.generateImages({
          model: "imagen-4.0-generate-001",
          prompt,
          config: {
            numberOfImages: 4,
            aspectRatio: aspectRatio || "16:9",
            sampleImageSize: outputResolution || "1K",
          },
        })
      );

    if (!imagenResponse.generatedImages?.length) {
      return res.json({ error: "Gagal membuat gambar." });
    }

    const imageObj = imagenResponse.generatedImages[0].image;
    const base64Data = imageObj.imageBytes;
    const mimeType = imageObj.mimeType || "image/png";
    const extension = mimeType.split("/")[1] || "png";
    const fileName = `generated_image_${Date.now()}.${extension}`;
    const buffer = Buffer.from(base64Data, "base64");

    console.log("📤 Upload image ke Supabase...");
    const { error: uploadError } = await supabase.storage
      .from("generated-files")
      .upload(`images/${fileName}`, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      console.error("❌ Upload error:", uploadError.message);
      return res.json({ error: "Gagal upload ke Supabase" });
    }

    const { data } = supabase.storage
      .from("generated-files")
      .getPublicUrl(`images/${fileName}`);

    console.log("✅ Image URL:", data.publicUrl);
    res.json({ imageUrl: data.publicUrl, fileName });

  } catch (err) {
    console.error("❌ ERROR:", err);
    if (err.message && err.message.includes("API key not valid")) {
      return res.json({ error: "API Key tidak valid atau salah." });
    }
    return res.json({ error: "Terjadi kesalahan saat membuat gambar. Silakan coba lagi." });
  }
});

// ====================== ADMIN ENDPOINTS ======================
router.post("/admin/login", express.json(), (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: ADMIN_TOKEN });
  }
  return res.status(401).json({ error: "Username/password salah" });
});

function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token || token !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

router.get("/admin/files", authMiddleware, async (req, res) => {
  try {
    const files = [];
    const { data: imageFiles } = await supabase.storage.from("generated-files").list("images");
    if (imageFiles) imageFiles.forEach(f => files.push({ type: "image", name: f.name }));

    const { data: videoFiles } = await supabase.storage.from("generated-files").list("videos");
    if (videoFiles) videoFiles.forEach(f => files.push({ type: "video", name: f.name }));

    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil daftar file" });
  }
});

router.get("/admin/preview/:type/:filename", authMiddleware, async (req, res) => {
  const { type, filename } = req.params;
  const { data } = supabase.storage
    .from("generated-files")
    .getPublicUrl(`${type}s/${filename}`);
  return res.redirect(data.publicUrl);
});

router.delete("/admin/delete/:type/:filename", authMiddleware, async (req, res) => {
  const { type, filename } = req.params;
  const { error } = await supabase.storage
    .from("generated-files")
    .remove([`${type}s/${filename}`]);
  if (error) {
    return res.status(500).json({ error: "Gagal hapus file" });
  }
  res.json({ success: true });
});

export default router;
