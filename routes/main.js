// routes/main.js
import express from "express";
import multer from "multer";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { Buffer } from "buffer";
import { supabase } from "./supabase.js";

const router = express.Router();
const upload = multer({ dest: path.join(os.tmpdir(), "uploads") });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// halaman utama
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "index.html"));
});

router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "admin.html"));
});

// helper retry
async function retryRequest(fn, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`❌ Percobaan ${attempt} gagal:`, error.message);
      if (attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "Saipul";

// API generate video
router.post("/generate-video", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, prompt, aspectRatio, veoModel } = req.body;
    if (!apiKey) return res.json({ error: "API Key wajib diisi!" });

    const ai = new GoogleGenAI({ apiKey });
    const operation = await ai.models.generateVideos({
      model: veoModel || "veo-3.0-generate-001",
      prompt,
      config: {
        numberOfVideos: 1,
        aspectRatio: aspectRatio || "16:9",
      },
    });

    let op = operation;
    while (!op.done) {
      await new Promise((r) => setTimeout(r, 8000));
      op = await ai.operations.getVideosOperation({ operation });
    }

    if (!op.response?.generatedVideos?.length) {
      return res.json({ error: "Gagal membuat video, coba lagi." });
    }

    const videoFile = op.response.generatedVideos[0].video;
    const fileName = `generated_video_${Date.now()}.mp4`;
    const localPath = path.join(os.tmpdir(), fileName);

    await ai.files.download({ file: videoFile, downloadPath: localPath });
    if (!fs.existsSync(localPath)) {
      return res.json({ error: "Gagal mengunduh video, silakan coba lagi." });
    }

    // upload ke Supabase
    const fileBuffer = fs.readFileSync(localPath);
    const { error: uploadError } = await supabase.storage
      .from("generated-files")
      .upload(`videos/${fileName}`, fileBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    fs.unlinkSync(localPath);
    if (uploadError) {
      console.error("❌ Upload error:", uploadError.message);
      return res.json({ error: "Gagal upload ke Supabase" });
    }

    // ambil URL publik dari Supabase
    const { data } = supabase.storage
      .from("generated-files")
      .getPublicUrl(`videos/${fileName}`);

    res.json({ videoUrl: data.publicUrl, fileName });
  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.json({ error: "Terjadi kesalahan saat membuat video." });
  }
});

// API generate image
router.post("/generate-image", async (req, res) => {
  try {
    const { apiKey, prompt, imagenModel, aspectRatio, outputResolution } = req.body;
    if (!apiKey) return res.json({ error: "API Key wajib diisi!" });
    if (!prompt) return res.json({ error: "Prompt wajib diisi!" });

    const ai = new GoogleGenAI({ apiKey });
    const imagenResponse = await retryRequest(() =>
      ai.models.generateImages({
        model: imagenModel || "imagen-4.0-generate-001",
        prompt,
        config: {
          numberOfImages: 1,
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

    res.json({ imageUrl: data.publicUrl, fileName });
  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.json({ error: "Terjadi kesalahan saat membuat gambar." });
  }
});

// admin login
router.post("/admin/login", express.json(), (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: ADMIN_TOKEN });
  }
  return res.status(401).json({ error: "Username/password salah" });
});

// middleware cek token
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token || token !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

// list files
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

// preview file → redirect ke URL Supabase
router.get("/admin/preview/:type/:filename", authMiddleware, async (req, res) => {
  const { type, filename } = req.params;
  const { data } = supabase.storage
    .from("generated-files")
    .getPublicUrl(`${type}s/${filename}`);
  return res.redirect(data.publicUrl);
});

// delete file
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
