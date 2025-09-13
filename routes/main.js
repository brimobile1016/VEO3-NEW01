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

// ====================== API GENERATE VIDEO ======================
router.post("/generate-video", upload.single("image"), async (req, res) => {
    try {
        console.log("🚀 [DEBUG] Mulai endpoint /generate-video");
        const { apiKey, prompt, aspectRatio, veoModel } = req.body;
        const file = req.file;

        if (!apiKey) return res.status(400).json({ error: "API Key wajib diisi!" });
        if (!prompt) return res.status(400).json({ error: "Prompt wajib diisi!" });

        const ai = new GoogleGenAI({ apiKey });
        let imageData = null;

        if (file) {
            console.log("📷 [DEBUG] Menggunakan file upload...");
            imageData = {
                imageBytes: fs.readFileSync(file.path).toString("base64"),
                mimeType: file.mimetype,
            };
            fs.unlinkSync(file.path); // Bersihkan file gambar yang diunggah
        }

        console.log("🎬 [DEBUG] Generate video dengan Veo...");
        let operation = await ai.models.generateVideos({
            model: veoModel || "veo-3.0-generate-001",
            prompt,
            image: imageData, // Akan null jika tidak ada gambar
            config: { numberOfVideos: 1, aspectRatio: aspectRatio || "16:9" },
        });

        while (!operation.done) {
            console.log("⏳ [DEBUG] Menunggu proses video selesai...");
            await new Promise((r) => setTimeout(r, 5000));
            operation = await ai.operations.getVideosOperation({ operation });
        }

        const videoFile = operation.response?.generatedVideos?.[0]?.video;
        if (!videoFile) {
            console.error("❌ [DEBUG] Video tidak tersedia dalam response.");
            return res.status(500).json({ error: "Video tidak tersedia dalam response." });
        }

        console.log("📥 [DEBUG] Mengunduh video dari AI sebagai buffer...");
        let videoBuffer;
        try {
            videoBuffer = await ai.files.download({
                file: videoFile,
                returnAs: 'buffer'
            });
        } catch (downloadErr) {
            console.error("❌ [DEBUG] Gagal mengunduh video:", downloadErr);
            return res.status(500).json({ error: "Gagal mengunduh video dari layanan AI." });
        }

        // Periksa apakah videoBuffer benar-benar berisi data
        if (!videoBuffer || videoBuffer.length === 0) {
            console.error("❌ [DEBUG] Video buffer kosong setelah diunduh.");
            return res.status(500).json({ error: "Data video kosong setelah diunduh." });
        }
        console.log(`✅ [DEBUG] Video berhasil diunduh. Ukuran buffer: ${videoBuffer.length} bytes`);
      
        // Buat nama file unik untuk Supabase
        const randomNumber = Math.floor(10000 + Math.random() * 90000);
        const fileName = `generated_video_${randomNumber}.mp4`;

        console.log("⬆️ [DEBUG] Mengunggah video ke Supabase Storage...");
        const { data, error: uploadError } = await supabase.storage
            .from('generated-files') // Ganti dengan nama bucket Anda
            .upload(`videos/${fileName}`, videoBuffer, {
                contentType: 'video/mp4',
            });

        if (uploadError) {
            console.error("❌ [DEBUG] Gagal mengunggah ke Supabase:", uploadError);
            return res.status(500).json({ error: "Gagal mengunggah video ke penyimpanan." });
        }
        
        // Dapatkan URL publik dari video
        const { data: publicUrlData } = supabase.storage
            .from('generated-files')
            .getPublicUrl(`videos/${fileName}`);

        const videoUrl = publicUrlData.publicUrl;
        console.log("✅ [DEBUG] Video berhasil diunggah. URL:", videoUrl);

        // Kirimkan URL video kembali ke klien
       // res.status(200).json({ videoUrl });
      res.json({ videoUrl: videoUrl, fileName });

    } catch (err) {
        console.error("❌ [DEBUG] ERROR:", err);
        res.status(500).json({ error: "Terjadi kesalahan saat membuat video. Silakan coba lagi." });
    }
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
