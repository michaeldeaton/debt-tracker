const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// ── Database setup ────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'debt-tracker.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    data  TEXT NOT NULL,
    saved_at TEXT NOT NULL
  )
`)

// ── Middleware ────────────────────────────────────────────────
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── API ───────────────────────────────────────────────────────

// Load state
app.get('/api/data', (req, res) => {
  const row = db.prepare('SELECT data, saved_at FROM state WHERE id = 1').get()
  if (!row) return res.json({ data: null })
  res.json({ data: JSON.parse(row.data), saved_at: row.saved_at })
})

// Save state
app.post('/api/data', (req, res) => {
  const saved_at = new Date().toISOString()
  db.prepare(`
    INSERT INTO state (id, data, saved_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at
  `).run(JSON.stringify(req.body), saved_at)
  res.json({ ok: true, saved_at })
})

// Catch-all → serve the app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Debt Tracker running at http://localhost:${PORT}`)
  console.log(`  Database: ${path.join(__dirname, 'debt-tracker.db')}`)
  console.log(`  Ctrl+C to stop\n`)
})
