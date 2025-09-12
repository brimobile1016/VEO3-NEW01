import express from "express";
import multer from "multer";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { Buffer } from "buffer";
import mime from "mime-types";
import { createClient } from '@supabase/supabase-js'

// --- AWAL MODIFIKASI KODE ANDA ---
// PERINGATAN: MENEMPELKAN KUNCI LANGSUNG SANGAT TIDAK AMAN!
// Kunci ini akan terlihat oleh semua orang yang bisa melihat kode Anda.
// Sangat disarankan untuk menggunakan variabel lingkungan.
const supabaseUrl = 'https://nhjbbesruvuwsvdhhbkn.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5oamJiZXNydXZ1d3N2ZGhoYmtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2ODExMjMsImV4cCI6MjA3MzI1NzEyM30.-A3vEup-fFyH7LPS8zcdlL_MFBq7me1tnjY0UDKW6mY';
const supabase = createClient(supabaseUrl, supabaseKey);
// --- AKHIR MODIFIKASI KODE ANDA ---

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), "uploads") // ✅ simpan upload sementara di /tmp/uploads
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ simpan hasil video di /tmp/video
const outputDirVideo = path.join(os.tmpdir(), "video");
if (!fs.existsSync(outputDirVideo)) fs.mkdirSync(outputDirVideo, { recursive: true });

// ✅ simpan hasil image di /tmp/images
const outputDirImage = path.join(os.tmpdir(), "images");
if (!fs.existsSync(outputDirImage)) fs.mkdirSync(outputDirImage, { recursive: true });

// ✅ halaman utama
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "index.html"));
});

router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "admin.html"));
});

// ✅ serve video dari /tmp
router.get("/public/video/:filename", (req, res) => {
  const filePath = path.join(outputDirVideo, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video tidak ditemukan");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunkSize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
      "Content-Disposition": "inline"
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Content-Disposition": "inline"
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// ✅ serve image dari /tmp
router.get("/public/images/:filename", (req, res) => {
  const filePath = path.join(outputDirImage, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.sendStatus(404);
  }
  res.sendFile(filePath);
});

// ✅ Preview file untuk user (tanpa auth)
router.get("/preview/video/:filename", (req, res) => {
  const filePath = path.join(outputDirVideo, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video tidak ditemukan");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  const mimeType = mime.lookup(filePath) || "application/octet-stream";
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", fileSize);
  res.setHeader("Content-Disposition", "inline");

  fs.createReadStream(filePath).pipe(res);
});

// 🔁 helper untuk retry
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

// ✅ API generate video
router.post("/generate-video", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, prompt, aspectRatio, veoModel } = req.body;
    const file = req.file;

    if (!apiKey) return res.json({ error: "API Key wajib diisi!" });

    const ai = new GoogleGenAI({ apiKey });

    let imageData = null;
    if (file) {
      const imageBytes = fs.readFileSync(file.path);
      imageData = {
        imageBytes: imageBytes.toString("base64"),
        mimeType: file.mimetype,
      };
    }

    let options = {
      model: veoModel || "veo-3.0-generate-001",
      prompt,
      image: imageData,
      config: {
        numberOfVideos: 1,
        aspectRatio: aspectRatio || "16:9",
      },
    };

    let operation = await ai.models.generateVideos(options);

    const operationId = operation.name || operation.operationId || operation.id;
    if (!operationId) return res.json({ error: "Gagal mendapatkan operationId." });

    while (!operation.done) {
      await new Promise((r) => setTimeout(r, 8000));
      operation = await ai.operations.getVideosOperation({ operation });
    }

    if (!operation.response?.generatedVideos?.length) {
      return res.json({ error: "Gagal membuat video, coba lagi." });
    }

    const videoFile = operation.response.generatedVideos[0].video;
    const fileName = `generated_video_${Date.now()}.mp4`;
    const localPath = path.join(os.tmpdir(), fileName);

    // ✅ Download dulu ke lokal tmp
    await ai.files.download({
      file: videoFile,
      downloadPath: localPath,
    });
    
    // Pastikan file berhasil diunduh sebelum membacanya
    if (!fs.existsSync(localPath)) {
        return res.json({ error: "Gagal mengunduh video, silakan coba lagi." });
    }

    // ✅ Upload ke Supabase
    const fileBuffer = fs.readFileSync(localPath);
    const { error: uploadError } = await supabase.storage
      .from("generated-files") // pastikan bucket ini sudah ada
      .upload(`videos/${fileName}`, fileBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    // Hapus file sementara dari lokal setelah diunggah ke Supabase
    fs.unlinkSync(localPath);

    if (uploadError) {
      console.error("❌ Upload error:", uploadError.message);
      return res.json({ error: "Gagal upload ke Supabase" });
    }

    // ✅ Ambil public URL
    const { data: publicUrl } = supabase.storage
      .from("generated-files")
      .getPublicUrl(`videos/${fileName}`);

    res.json({ videoUrl: publicUrl.publicUrl, fileName });
  } catch (err) {
    console.error("❌ ERROR:", err);
    if (err.message && err.message.includes("API key not valid")) {
      return res.json({ error: "API Key tidak valid atau salah. Periksa kembali API Key Anda." });
    }
    return res.json({ error: "Terjadi kesalahan saat membuat video." });
  }
});

// ✅ API generate image
router.post("/generate-image", upload.single("image"), async (req, res) => {
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

    const image = imagenResponse.generatedImages[0].image;
    const base64Data = image.imageBytes;
    const mimeType = image.mimeType;
    const extension = mimeType.split("/")[1];
    const fileName = `generated_image_${Date.now()}.${extension}`;
    const buffer = Buffer.from(base64Data, "base64");

    // ✅ Upload ke Supabase
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

    // ✅ Ambil public URL
    const { data: publicUrl } = supabase.storage
      .from("generated-files")
      .getPublicUrl(`images/${fileName}`);

    res.json({ imageUrl: publicUrl.publicUrl });
  } catch (err) {
    console.error("❌ ERROR:", err);
if (err.message && err.message.includes("API key not valid")) {
      return res.json({ error: "API Key tidak valid atau salah. Periksa kembali API Key Anda." });
    }
    return res.json({ error: "Terjadi kesalahan saat membuat gambar." });
  }
});

// List file
router.post("/admin/login", express.json(), (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: ADMIN_TOKEN });
  }
  return res.status(401).json({ error: "Username/password salah" });
});

// Middleware cek token
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token || token !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

// ✅ List file dari Supabase
router.get("/admin/files", authMiddleware, async (req, res) => {
  try {
    const files = [];

    // List images
    const { data: imageFiles, error: imageError } = await supabase
      .storage
      .from("generated-files")
      .list("images", { limit: 100 });

    if (imageError) {
      console.error("❌ Supabase list images error:", imageError.message);
    } else {
      imageFiles.forEach(f => files.push({ type: "image", name: f.name }));
    }

    // List videos
    const { data: videoFiles, error: videoError } = await supabase
      .storage
      .from("generated-files")
      .list("videos", { limit: 100 });

    if (videoError) {
      console.error("❌ Supabase list videos error:", videoError.message);
    } else {
      videoFiles.forEach(f => files.push({ type: "video", name: f.name }));
    }

    res.json({ files });
  } catch (err) {
    console.error("❌ ERROR list files:", err);
    res.status(500).json({ error: "Gagal mengambil daftar file dari Supabase" });
  }
});

// ✅ Preview file (ambil public URL dari Supabase)
router.get("/admin/preview/:type/:filename", authMiddleware, async (req, res) => {
  try {
    const { type, filename } = req.params;
    const { data, error } = supabase
      .storage
      .from("generated-files")
      .getPublicUrl(`${type}s/${filename}`);

    if (error) {
      console.error("❌ Supabase preview error:", error.message);
      return res.status(404).json({ error: "File tidak ditemukan di Supabase" });
    }

    // Redirect langsung ke URL publik
    return res.redirect(data.publicUrl);
  } catch (err) {
    console.error("❌ ERROR preview file:", err);
    res.status(500).json({ error: "Gagal preview file dari Supabase" });
  }
});

// ✅ Delete file di Supabase
router.delete("/admin/delete/:type/:filename", authMiddleware, async (req, res) => {
  try {
    const { type, filename } = req.params;

    const { error } = await supabase
      .storage
      .from("generated-files")
      .remove([`${type}s/${filename}`]);

    if (error) {
      console.error("❌ Supabase delete error:", error.message);
      return res.status(404).json({ error: "File tidak ditemukan atau gagal dihapus" });
    }

    res.json({ success: true, message: `File ${filename} dihapus dari Supabase.` });
  } catch (err) {
    console.error("❌ ERROR delete file:", err);
    res.status(500).json({ error: "Gagal menghapus file dari Supabase" });
  }
});

export default router;
