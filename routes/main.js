import express from "express";
import multer from "multer";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { Buffer } from "buffer";

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
    const outputPath = path.join(outputDirVideo, fileName);

    await ai.files.download({
      file: videoFile,
      downloadPath: outputPath,
    });

    res.json({ videoUrl: `/public/video/${fileName}`, fileName });
  } catch (err) {
    console.error("❌ ERROR:", err);
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
    const filePath = path.join(outputDirImage, fileName);
    const imageBuffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(filePath, imageBuffer);

    res.json({ imageUrl: `/public/images/${fileName}` });
  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.json({ error: "Terjadi kesalahan saat membuat gambar." });
  }
});

// ✅ Daftar semua file di /tmp
router.get("/admin/files", (req, res) => {
  const files = {
    videos: fs.readdirSync(outputDirVideo).map(f => ({ type: "video", name: f })),
    images: fs.readdirSync(outputDirImage).map(f => ({ type: "image", name: f })),
  };
  res.json(files);
});

// ✅ Hapus file tertentu
router.delete("/admin/delete/:type/:filename", (req, res) => {
  const { type, filename } = req.params;
  let baseDir;

  if (type === "video") baseDir = outputDirVideo;
  else if (type === "image") baseDir = outputDirImage;
  else return res.status(400).json({ error: "Type harus image atau video" });

  const filePath = path.join(baseDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File tidak ditemukan" });
  }

  fs.unlinkSync(filePath);
  res.json({ success: true, message: `File ${filename} berhasil dihapus` });
});


export default router;
