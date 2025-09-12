import express from 'express'
import cors from 'cors'
import secure from 'ssl-express-www'
import main from './routes/main.js'
import { supabase } from './routes/supabase.js'

const PORT = process.env.PORT || 7002 || 5000 || 3000

async function ensureBucketExists(bucketName = "generated-files") {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets()
    if (error) {
      console.error("❌ Gagal cek bucket:", error.message)
      return
    }

    const exists = buckets.some(b => b.name === bucketName)
    if (!exists) {
      console.log(`⚡ Bucket "${bucketName}" belum ada, membuat...`)
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
      })
      if (createError) {
        console.error("❌ Gagal membuat bucket:", createError.message)
      } else {
        console.log(`✅ Bucket "${bucketName}" berhasil dibuat.`)
      }
    } else {
      console.log(`✅ Bucket "${bucketName}" sudah ada.`)
    }
  } catch (err) {
    console.error("❌ ERROR ensureBucketExists:", err.message)
  }
}

const app = express()
app.enable('trust proxy')
app.set("json spaces", 2)
app.use(cors())
app.use(secure)
app.use(express.static("views"))
app.use(express.static("uploads"))
app.use('/', main)

async function startServer() {
  await ensureBucketExists("generated-files")
  app.listen(PORT, () => {
    console.log("🚀 Server running on " + PORT)
  })
}

startServer()

export default app
