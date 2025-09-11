import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { Buffer } from "buffer";


const router = express.Router();
const upload = multer({ dest: "uploads/" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Folder untuk simpan hasil video
const outputDir = path.join(__dirname, "public", "video");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

const outputDirImage = path.join(__dirname, "public", "images");
if (!fs.existsSync(outputDirImage)) fs.mkdirSync(outputDirImage, { recursive: true });


// ✅ Serve file statis
// Rute untuk file root / akan memanggil view/index.html
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "index.html"));
});
router.get("/ayo", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "ayo.html"));
});

// ✅ Serve file statis lainnya dari root folder
router.get("/public/video/:filename", (req, res) => {
  const filePath = path.join(__dirname, "public/video", req.params.filename);

  // cek file ada/tidak
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video tidak ditemukan");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // kalau ada permintaan partial (supaya bisa seek)
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
    // kalau tidak ada range → kirim seluruh file
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Content-Disposition": "inline"
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

router.get("/public/images/:filename", (req, res) => {
  const filePath = path.join(outputDirImage, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.sendStatus(404);
  }
  res.sendFile(filePath);
});


// router.use(express.static("."));

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


// ✅ API untuk generate video
router.post("/generate-video", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, prompt, aspectRatio, veoModel } = req.body;
    const file = req.file;

    if (!apiKey) {
      return res.json({ error: "API Key wajib diisi!" });
    }

    const ai = new GoogleGenAI({ apiKey });

    let imageData = null;

    if (file) {
      // ✅ Jika user upload gambar
      const imageBytes = fs.readFileSync(file.path);
      imageData = {
        imageBytes: imageBytes.toString("base64"),
        mimeType: file.mimetype,
      };
    } else {
      // ✅ Jika tidak ada gambar → generate dengan Imagen
      console.log("📷 Tidak ada gambar, generate image via Imagen...");
      const imagenResponse = await retryRequest(() =>
        ai.models.generateImages({
          model: "imagen-4.0-generate-001",
          prompt,
          config: {
            numberOfImages: 4,
            aspectRatio: aspectRatio || "16:9",
            sampleImageSize: "1K",
          },
        })
      );

      if (!imagenResponse.generatedImages?.length) {
        return res.json({ error: "Gagal generate gambar dengan Imagen." });
      }

      imageData = {
        imageBytes: imagenResponse.generatedImages[0].image.imageBytes,
        mimeType: "image/png",
      };
    }

    // ✅ Lanjut generate video dengan Veo 3
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

    // Ambil ID operasi
    const operationId = operation.name || operation.operationId || operation.id;
    if (!operationId) {
      return res.json({ error: "Gagal mendapatkan operationId dari response." });
    }

    // ✅ Polling sampai selesai
    while (!operation.done) {
      console.log("⏳ Menunggu proses video...");
      await new Promise((r) => setTimeout(r, 8000));
      operation = await ai.operations.getVideosOperation({ operation });
    }

    if (!operation.response?.generatedVideos?.length) {
      return res.json({ error: "Gagal membuat video, coba lagi." });
    }


    const videoFile = operation.response.generatedVideos[0].video;

    const randomNumber = Math.floor(10000 + Math.random() * 90000);
    const fileName = `generated_video_${randomNumber}.mp4`;
const outputPath = path.join(outputDir, fileName);

    // ✅ Simpan ke server lokal
//   const outputPath = path.join(outputDir, "output_video.mp4");
    await ai.files.download({
      file: videoFile,
      downloadPath: outputPath,
    });


    // ✅ Kembalikan URL agar bisa diakses langsung
    res.json({ videoUrl: `/public/video/${fileName}`, fileName: `${fileName}` });

  } catch (err) {
    console.error("❌ ERROR:", err);

    if (err.message && err.message.includes("API key not valid")) {
      return res.json({ error: "API Key tidak valid atau salah. Periksa kembali API Key Anda." });
    }

    return res.json({ error: "Terjadi kesalahan saat membuat video. Silakan coba lagi." });
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

    const image = imagenResponse.generatedImages[0].image;
    const base64Data = image.imageBytes;
    const mimeType = image.mimeType;
    const extension = mimeType.split("/")[1];

    // ✅ Simpan gambar ke server lokal
    const fileName = `generated_image_${Date.now()}.${extension}`;
    const filePath = path.join(outputDirImage, fileName);
    const imageBuffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(filePath, imageBuffer);

    // ✅ Kembalikan URL gambar yang dapat diakses publik
    res.json({ imageUrl: `/public/images/${fileName}` });

  } catch (err) {
    console.error("❌ ERROR:", err);
    if (err.message && err.message.includes("API key not valid")) {
      return res.json({ error: "API Key tidak valid atau salah." });
    }
    return res.json({ error: "Terjadi kesalahan saat membuat gambar. Silakan coba lagi." });
  }
});


export default router
