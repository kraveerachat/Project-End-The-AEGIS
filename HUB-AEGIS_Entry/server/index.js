// server/index.js
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionMiddleware } from './auth/session.js'
import { apiRouter } from './routes/api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 3001

const app = express()

app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(express.json({ limit: '16kb' }))
app.use(sessionMiddleware())

app.use('/api', apiRouter)
app.use(express.static(DIST))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) next()
  })
})

app.listen(PORT, () => {
  console.log(`[aegis] entry server on :${PORT}`)
})
