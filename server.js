import express from 'express'
import cors from 'cors'
import secure from 'ssl-express-www'
import main from './routes/main.js'

const PORT = process.env.PORT || 7002 || 5000 || 3000

var main = require('./routes/main')

const app = express()
app.enable('trust proxy')
app.set("json spaces", 2)
app.use(cors())
app.use(secure)
app.use(express.static("views"))
app.use(express.static("uploads"))
app.use('/', main)

app.listen(PORT, () => {
    console.log("🚀 Server running on " + PORT)
})

export default app

