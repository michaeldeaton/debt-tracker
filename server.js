require('dotenv').config()
const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')
const https = require('https')
const http = require('http')
const fs = require('fs')
const pdfParse = require('pdf-parse')

const app = express()
const PORT = process.env.PORT || 3000
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED_USER = process.env.TELEGRAM_USER_ID
const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL

// ── Database setup ────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'debt-tracker.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    data  TEXT NOT NULL,
    saved_at TEXT NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL,
    description     TEXT NOT NULL,
    amount          REAL NOT NULL,
    category        TEXT,
    account         TEXT NOT NULL,
    source_file     TEXT,
    imported_at     TEXT NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS category_mappings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    description_pattern TEXT NOT NULL UNIQUE,
    category            TEXT NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS imports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT,
    bank        TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    tx_count    INTEGER
  )
`)

// ── Prepared statements ───────────────────────────────────────
const stmts = {
  insertTx: db.prepare(`
    INSERT INTO transactions (date, description, amount, category, account, source_file, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  checkDupe: db.prepare(`
    SELECT id FROM transactions WHERE date = ? AND description = ? AND amount = ? AND account = ?
  `),
  insertImport: db.prepare(`
    INSERT INTO imports (filename, bank, imported_at, tx_count) VALUES (?, ?, ?, ?)
  `),
  getMappings: db.prepare(`SELECT description_pattern, category FROM category_mappings`),
  insertMapping: db.prepare(`
    INSERT INTO category_mappings (description_pattern, category) VALUES (?, ?)
    ON CONFLICT(description_pattern) DO UPDATE SET category = excluded.category
  `),
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── Debt tracker API (unchanged) ─────────────────────────────

app.get('/api/data', (req, res) => {
  const row = db.prepare('SELECT data, saved_at FROM state WHERE id = 1').get()
  if (!row) return res.json({ data: null })
  res.json({ data: JSON.parse(row.data), saved_at: row.saved_at })
})

app.post('/api/data', (req, res) => {
  const saved_at = new Date().toISOString()
  db.prepare(`
    INSERT INTO state (id, data, saved_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at
  `).run(JSON.stringify(req.body), saved_at)
  res.json({ ok: true, saved_at })
})

// ── Transaction API ──────────────────────────────────────────

app.get('/api/transactions', (req, res) => {
  const { month, account } = req.query
  let sql = 'SELECT * FROM transactions WHERE 1=1'
  const params = []

  if (month) {
    // month = YYYY-MM
    sql += ' AND date >= ? AND date < ?'
    const [y, m] = month.split('-').map(Number)
    const start = `${y}-${String(m).padStart(2, '0')}-01`
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    params.push(start, nextMonth)
  }

  if (account && account !== 'all') {
    sql += ' AND account = ?'
    params.push(account)
  }

  sql += ' ORDER BY date DESC, id DESC'
  res.json(db.prepare(sql).all(...params))
})

app.get('/api/transactions/uncategorised', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM transactions WHERE category IS NULL ORDER BY date DESC').all()
  )
})

app.post('/api/transactions/:id/category', (req, res) => {
  const { category } = req.body
  if (!category) return res.status(400).json({ error: 'category required' })

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id)
  if (!tx) return res.status(404).json({ error: 'transaction not found' })

  db.prepare('UPDATE transactions SET category = ? WHERE id = ?').run(category, req.params.id)

  // Save mapping for future imports (all banks lack categories in PDF)
  stmts.insertMapping.run(tx.description, category)

  res.json({ ok: true })
})

app.get('/api/imports', (req, res) => {
  res.json(db.prepare('SELECT * FROM imports ORDER BY imported_at DESC').all())
})

// ── PDF parsing ──────────────────────────────────────────────

function detectBank(text) {
  // Check Monzo first (most distinctive)
  if (/monzo/i.test(text)) return 'monzo'

  // HSBC — distinguish credit card from current account
  if (/hsbc/i.test(text)) {
    if (/Visa Card statement/i.test(text)) return 'hsbc_cc'
    return 'hsbc'  // Current account (HSBC Advance)
  }

  // Lloyds — distinguish Michael's IoM account from Amanda's UK account by sort code
  if (/lloyds\s*bank/i.test(text)) {
    // Michael's IoM: sort code 30-12-80, account 50041968
    if (/30-12-80/.test(text)) return 'lloyds'
    // Amanda's UK: sort code 77-17-31, account 28783360
    if (/77-17-31/.test(text)) return 'lloyds_amanda'
    // Fallback — unknown Lloyds account
    return 'lloyds'
  }

  return null
}

// ── Monzo parser ──────────────────────────────────────────────
// pdf-parse extracts Monzo in two forms:
//   Single-line: "28/02/2026Klarna HOKA WC2B 6NH GBR-90.864,649.66"
//   Multi-line:  "28/02/2026\nDown South Hybrid Limited (Faster\nPayments) Reference: M Eaton\n-100.004,952.49"
//                (date alone, then description lines, then amount+balance)

function parseMonzoTransactions(text) {
  const txs = []
  const lines = text.split('\n').map(l => l.trim())

  // Single-line pattern: DD/MM/YYYY + Description + amount + balance
  const singleLine = /^(\d{2}\/\d{2}\/\d{4})(.+?)(-?[\d,]+\.\d{2})([\d,]+\.\d{2})$/
  // Date-only line (start of multi-line entry)
  const dateOnly = /^(\d{2}\/\d{2}\/\d{4})$/
  // Amount+balance line (end of multi-line entry)
  const amountBalance = /^(-?[\d,]+\.\d{2})([\d,]+\.\d{2})$/

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Try single-line match first
    const sm = line.match(singleLine)
    if (sm) {
      const [dd, mm, yyyy] = sm[1].split('/')
      const desc = sm[2].trim()
      const amount = parseFloat(sm[3].replace(/,/g, ''))
      if (desc && !isNaN(amount)) {
        txs.push({ date: `${yyyy}-${mm}-${dd}`, description: desc, amount, category: null })
      }
      i++
      continue
    }

    // Try multi-line: date-only line, then description lines, then amount+balance
    const dm = line.match(dateOnly)
    if (dm) {
      const dateStr = dm[1]
      const descParts = []
      let j = i + 1

      // Collect description lines until we hit an amount+balance line or another date
      while (j < lines.length) {
        if (dateOnly.test(lines[j]) || singleLine.test(lines[j])) break
        const am = lines[j].match(amountBalance)
        if (am) {
          // Found the amount+balance — this completes the entry
          const [dd, mm, yyyy] = dateStr.split('/')
          const desc = descParts.join(' ').trim()
          const amount = parseFloat(am[1].replace(/,/g, ''))
          if (desc && !isNaN(amount)) {
            txs.push({ date: `${yyyy}-${mm}-${dd}`, description: desc, amount, category: null })
          }
          j++
          break
        }
        // Skip "This relates to a previous transaction" sub-lines but keep them in description
        if (lines[j]) descParts.push(lines[j])
        j++
      }
      i = j
      continue
    }

    i++
  }

  return txs
}

// ── Lloyds parser ─────────────────────────────────────────────
// pdf-parse extracts Lloyds with labeled fields like:
//   Date\n02 Mar 26.\nDescription\nA EATON    01MAR26.\nType\nFPI.\n
//   Money In (£)\n10.00.\nMoney Out (£)\nblank.\nBalance (£)\n69.72.

function parseLloydsTransactions(text) {
  const txs = []

  // Extract the statement date range for year context
  // e.g. "01 March 2026 to 11 March 2026" or "01 February 2026 to 28 February 2026"
  const rangeMatch = text.match(/(\d{1,2}\s+\w+\s+(\d{4}))\s+to\s+(\d{1,2}\s+\w+\s+\d{4})/)
  const year = rangeMatch ? rangeMatch[2] : new Date().getFullYear().toString()

  // Split into transaction blocks — each starts with "Date\n"
  // But skip the column header block (which has "Column\nDate.")
  const blocks = text.split(/\nDate\n/)

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const lines = block.split('\n').map(l => l.trim().replace(/\.$/, ''))

    // Expected structure:
    // [0] = date e.g. "02 Mar 26"
    // then "Description" label, then description value
    // then "Type" label, then type value
    // then "Money In (£)" label, then amount or "blank"
    // then "Money Out (£)" label, then amount or "blank"
    // then "Balance (£)" label, then balance

    const dateStr = lines[0] // e.g. "02 Mar 26"
    if (!dateStr || !/^\d{1,2}\s+\w{3}\s+\d{2}$/.test(dateStr)) continue

    // Find field values by looking for labels
    let description = '', moneyIn = null, moneyOut = null

    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === 'Description' && j + 1 < lines.length) {
        description = lines[j + 1]
      }
      if (lines[j] === 'Money In (£)' && j + 1 < lines.length) {
        const val = lines[j + 1].replace(/,/g, '')
        moneyIn = val === 'blank' ? null : parseFloat(val)
      }
      if (lines[j] === 'Money Out (£)' && j + 1 < lines.length) {
        const val = lines[j + 1].replace(/,/g, '')
        moneyOut = val === 'blank' ? null : parseFloat(val)
      }
    }

    if (!description) continue

    // Determine amount: money out is negative, money in is positive
    let amount
    if (moneyOut !== null && !isNaN(moneyOut)) {
      amount = -moneyOut
    } else if (moneyIn !== null && !isNaN(moneyIn)) {
      amount = moneyIn
    } else {
      continue
    }

    // Parse date: "02 Mar 26" → 2026-03-02
    const date = parseBritishShortDate(dateStr, year)
    if (!date) continue

    txs.push({ date, description, amount, category: null })
  }

  return txs
}

// ── HSBC current account parser ───────────────────────────────
// pdf-parse extracts HSBC Advance statements as concatenated text:
//   "23 Jan 26DDCARD SRVS HSBC37.0045.15"  (date+type+desc+paid_out+balance)
//   Multi-line descriptions, and reference numbers can bleed into amounts.
//   Uses balance tracking to reliably compute transaction amounts.

function parseHSBCCurrentTransactions(text) {
  const txs = []
  const lines = text.split('\n').map(l => l.trim())
  const mappings = getMappings()

  // Extract opening balance from "BALANCE BROUGHT FORWARD" line
  const obMatch = text.match(/BALANCE BROUGHT FORWARD\D*?([\d,]+\.\d{2})/)
  let prevBalance = obMatch ? parseFloat(obMatch[1].replace(/,/g, '')) : null

  // Type codes used in HSBC statements
  const TYPE_CODES = 'DD|VIS|\\)\\)\\)|BP|CHQ|TFR|ATM|FPI|FPO|BGC|SO|DEB|FEE|INT|PAY|CRE'
  const txStart = new RegExp(`^(\\d{1,2}\\s+\\w{3}\\s+\\d{2})(${TYPE_CODES})(.*)$`)
  const contType = new RegExp(`^(${TYPE_CODES})(.*)$`)

  // First pass: collect raw transaction blocks (date, type, concatenated text)
  const rawTxs = []
  let i = 0
  let lastDate = null

  while (i < lines.length) {
    const line = lines[i]

    if (/BALANCE (BROUGHT|CARRIED)\s*FORWARD/i.test(line)) { i++; continue }

    // Check for dated transaction line
    let m = line.match(txStart)
    if (m) {
      lastDate = m[1].trim()
      const typeCode = m[2]
      let rest = m[3]

      // Collect continuation lines
      let j = i + 1
      while (j < lines.length) {
        if (txStart.test(lines[j])) break
        if (/BALANCE (BROUGHT|CARRIED)\s*FORWARD/i.test(lines[j])) break
        if (contType.test(lines[j])) break
        if (/^(Cre\s*dit|Arranged|Dat\s*e|AER|upto|ove\s*r\d)/i.test(lines[j])) break
        if (!lines[j]) { j++; break }
        rest += ' ' + lines[j]
        j++
      }

      rawTxs.push({ dateStr: lastDate, rest })
      i = j
      continue
    }

    // Check for continuation type code (same date as previous, e.g. ")))TESCO STORES")
    m = line.match(contType)
    if (m && lastDate) {
      let rest = m[2]
      let j = i + 1
      while (j < lines.length) {
        if (txStart.test(lines[j])) break
        if (/BALANCE (BROUGHT|CARRIED)\s*FORWARD/i.test(lines[j])) break
        if (contType.test(lines[j])) break
        if (/^(Cre\s*dit|Arranged|Dat\s*e|AER|upto|ove\s*r\d)/i.test(lines[j])) break
        if (!lines[j]) { j++; break }
        rest += ' ' + lines[j]
        j++
      }

      rawTxs.push({ dateStr: lastDate, rest })
      i = j
      continue
    }

    i++
  }

  // Second pass: extract amounts using lookbehind + balance tracking
  // Two amounts: "desc37.0045.15" → paid_out=37.00, balance=45.15
  // One amount:  "desc29.49"      → paid_out=29.49, no balance shown
  // Edge case:   "desc1194993010.000.16" → ref number bleeds into amounts
  //   Lookbehind catches this: only gets balance=0.16, computes amount from balance diff

  const twoAmounts = /(?<=\D)(\d[\d,]*\.\d{2})(\d[\d,]*\.\d{2})$/
  const oneAmount = /(?<=\D)(\d[\d,]*\.\d{2})$/

  for (const raw of rawTxs) {
    let paidOut = null, paidIn = null, balance = null
    let description = raw.rest

    let m = raw.rest.match(twoAmounts)
    if (m) {
      const amt1 = parseFloat(m[1].replace(/,/g, ''))
      const amt2 = parseFloat(m[2].replace(/,/g, ''))

      // Sanity check: if first amount is unreasonably large (ref number bled in),
      // fall through to one-amount extraction instead
      if (amt1 > 50000) {
        m = null  // Force fallback below
      } else {
        balance = amt2
        description = raw.rest.slice(0, m.index).trim()

        if (prevBalance !== null) {
          if (balance < prevBalance) paidOut = amt1
          else paidIn = amt1
        } else {
          paidOut = amt1
        }
      }
    }

    if (!m) {
      const wasAmountSanityFail = raw.rest.match(twoAmounts) !== null  // Had two amounts but first was too large
      m = raw.rest.match(oneAmount)
      if (m) {
        const amt1 = parseFloat(m[1].replace(/,/g, ''))
        description = raw.rest.slice(0, m.index).trim()

        if (wasAmountSanityFail) {
          // Two amounts found but first was a ref number — this single match is the balance
          balance = amt1
        } else {
          // Genuinely one amount (no balance shown) — this is the paid_out
          paidOut = amt1
        }
      }
    }

    // Clean up description: remove trailing digits/dots left from ref numbers bleeding into amounts
    description = description.replace(/[\d.]+$/, '').trim()

    if (!description) continue

    // Compute signed amount
    let amount
    if (balance !== null && prevBalance !== null && paidOut === null && paidIn === null) {
      // Edge case: only got balance (ref number bled into amounts)
      amount = balance - prevBalance  // Negative = outgoing, positive = incoming
    } else if (paidIn !== null) {
      amount = paidIn
    } else if (paidOut !== null) {
      amount = -paidOut
    } else {
      continue
    }

    // Update running balance
    if (balance !== null) {
      prevBalance = balance
    } else if (prevBalance !== null && amount !== null) {
      prevBalance = prevBalance + amount
    }

    const date = parseBritishShortDate(raw.dateStr)
    if (!date) continue

    const category = matchCategory(description, mappings)
    txs.push({ date, description, amount, category })
  }

  return txs
}

// ── HSBC credit card parser ───────────────────────────────────
// pdf-parse extracts: "23 Feb2621 Feb26)))SumUp  *Coffee Station Peel4.85"
// Format: ReceivedDate + TransactionDate + Description + Amount (+ optional "CR" for credits)
// Also has multi-line entries for forex transactions

function parseHSBCCCTransactions(text) {
  const txs = []
  const lines = text.split('\n')

  // Find the "Your Transaction Details" section
  let inTransactions = false

  // HSBC dates look like "23 Feb26" (DD MonYY, no space before year)
  // Line format: ReceivedDateTransactionDateDescriptionAmount[CR]
  // e.g. "23 Feb2621 Feb26)))SumUp  *Coffee Station Peel4.85"
  // e.g. "23 Feb2623 Feb26DIRECT DEBIT PAYMENT - THANK YOU43.46CR"
  const txPattern = /^(\d{1,2}\s+\w{3}\d{2})(\d{1,2}\s+\w{3}\s*\d{2})(.+?)([\d,]+\.\d{2})(CR)?$/

  const mappings = getMappings()

  for (const line of lines) {
    const trimmed = line.trim()

    if (/Your Transaction Details/i.test(trimmed)) { inTransactions = true; continue }
    if (/Summary Of Interest/i.test(trimmed)) { inTransactions = false; continue }
    if (!inTransactions) continue

    // Skip header labels and sub-lines (forex info, etc.)
    const m = trimmed.match(txPattern)
    if (!m) continue

    const txDateStr = m[2].trim()  // Transaction date (the one that matters)
    const description = m[3].trim()
    const amountStr = m[4].replace(/,/g, '')
    const isCredit = !!m[5]

    if (!description || /^Received By Us|^Transaction Date|^Details|^Amount$/i.test(description)) continue

    const amount = parseFloat(amountStr)
    if (isNaN(amount)) continue

    // Credits are positive (payments received), debits are negative (purchases)
    const signedAmount = isCredit ? amount : -amount

    // Parse date: "21 Feb26" or "23 Feb 26"
    const date = parseHSBCDate(txDateStr)
    if (!date) continue

    const category = matchCategory(description, mappings)
    txs.push({ date, description, amount: signedAmount, category })
  }

  return txs
}

// ── Date helpers ──────────────────────────────────────────────

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                 jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }

function parseBritishShortDate(str, fallbackYear) {
  // "02 Mar 26" → "2026-03-02"
  const m = str.match(/^(\d{1,2})\s+(\w{3})\s+(\d{2,4})$/)
  if (!m) return null
  const day = m[1].padStart(2, '0')
  const mon = MONTHS[m[2].toLowerCase()]
  if (!mon) return null
  let yr = m[3]
  if (yr.length === 2) yr = '20' + yr
  return `${yr}-${mon}-${day}`
}

function parseHSBCDate(str) {
  // "21 Feb26" or "23 Feb 26" → "2026-02-21"
  const m = str.match(/^(\d{1,2})\s+(\w{3})\s*(\d{2,4})$/)
  if (!m) return null
  const day = m[1].padStart(2, '0')
  const mon = MONTHS[m[2].toLowerCase()]
  if (!mon) return null
  let yr = m[3]
  if (yr.length === 2) yr = '20' + yr
  return `${yr}-${mon}-${day}`
}

function getMappings() {
  try { return stmts.getMappings.all() } catch { return [] }
}

function matchCategory(description, mappings) {
  const descLower = description.toLowerCase()
  for (const { description_pattern, category } of mappings) {
    if (descLower.includes(description_pattern.toLowerCase())) {
      return category
    }
  }
  return null
}

function importTransactions(txs, account, filename) {
  const now = new Date().toISOString()
  let imported = 0

  const importMany = db.transaction(() => {
    for (const tx of txs) {
      // Deduplication: skip if date + description + amount + account already exists
      const existing = stmts.checkDupe.get(tx.date, tx.description, tx.amount, account)
      if (existing) continue

      stmts.insertTx.run(tx.date, tx.description, tx.amount, tx.category, account, filename, now)
      imported++
    }
    stmts.insertImport.run(filename, account, now, imported)
  })

  importMany()
  return imported
}

// ── Telegram webhook ─────────────────────────────────────────

function telegramAPI(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let chunks = ''
      res.on('data', c => chunks += c)
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)) } catch { resolve(chunks) }
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

function sendTelegramMessage(chatId, text) {
  return telegramAPI('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' })
}

function downloadTelegramFile(filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
    https.get(url, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200) // Acknowledge immediately

  try {
    const msg = req.body?.message
    if (!msg) return

    // Whitelist check
    if (String(msg.from?.id) !== String(ALLOWED_USER)) return

    const chatId = msg.chat.id
    const doc = msg.document

    if (!doc || !doc.file_name?.toLowerCase().endsWith('.pdf')) {
      await sendTelegramMessage(chatId, 'Send me a PDF bank statement and I\'ll import the transactions.')
      return
    }

    // Get file info from Telegram
    const fileInfo = await telegramAPI('getFile', { file_id: doc.file_id })
    if (!fileInfo.ok) {
      await sendTelegramMessage(chatId, 'Failed to get file from Telegram.')
      return
    }

    // Download the PDF
    const pdfBuffer = await downloadTelegramFile(fileInfo.result.file_path)
    const filename = doc.file_name

    // Parse PDF
    let parsed
    try {
      parsed = await pdfParse(pdfBuffer)
    } catch (e) {
      await sendTelegramMessage(chatId, `Failed to parse PDF: ${e.message}`)
      return
    }

    const text = parsed.text
    const bank = detectBank(text)

    if (!bank) {
      await sendTelegramMessage(chatId, 'Could not detect bank from this PDF. Supported: Monzo, HSBC CC, Lloyds.')
      return
    }

    // Parse transactions based on bank
    let txs
    if (bank === 'monzo') {
      txs = parseMonzoTransactions(text)
    } else if (bank === 'hsbc') {
      txs = parseHSBCCurrentTransactions(text)
    } else if (bank === 'hsbc_cc') {
      txs = parseHSBCCCTransactions(text)
    } else {
      // lloyds and lloyds_amanda use the same parser
      txs = parseLloydsTransactions(text)
    }

    if (txs.length === 0) {
      await sendTelegramMessage(chatId,
        `Detected <b>${bank.toUpperCase()}</b> statement but couldn't extract any transactions. ` +
        `The PDF format may have changed — check the parser.`
      )
      return
    }

    // Import with deduplication
    const imported = importTransactions(txs, bank, filename)
    const uncategorised = txs.filter(t => !t.category).length

    // Build date range for summary
    const dates = txs.map(t => t.date).sort()
    const dateRange = dates.length > 0
      ? `${formatDateShort(dates[0])} – ${formatDateShort(dates[dates.length - 1])}`
      : ''

    const bankNames = {
      monzo: 'Monzo', hsbc: 'HSBC Current Account', hsbc_cc: 'HSBC Credit Card',
      lloyds: 'Lloyds (Michael)', lloyds_amanda: 'Lloyds (Amanda)',
    }
    let summary = `✅ <b>${bankNames[bank] || bank}</b> statement imported\n`
    summary += `📄 ${filename}\n`
    summary += `📊 ${imported} new transactions (${txs.length - imported} duplicates skipped)\n`
    if (dateRange) summary += `📅 ${dateRange}\n`
    if (uncategorised > 0) summary += `⚠️ ${uncategorised} uncategorised — review in the web UI`

    await sendTelegramMessage(chatId, summary)
  } catch (err) {
    console.error('Telegram webhook error:', err)
  }
})

function formatDateShort(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Register webhook on startup ──────────────────────────────

async function registerWebhook() {
  if (!BOT_TOKEN || !WEBHOOK_BASE) {
    console.log('  Telegram bot: not configured (set TELEGRAM_BOT_TOKEN and WEBHOOK_BASE_URL in .env)')
    return
  }

  const webhookUrl = `${WEBHOOK_BASE}/telegram/webhook`
  try {
    const result = await telegramAPI('setWebhook', { url: webhookUrl })
    if (result.ok) {
      console.log(`  Telegram webhook: ${webhookUrl}`)
    } else {
      console.log(`  Telegram webhook failed: ${JSON.stringify(result)}`)
    }
  } catch (err) {
    console.log(`  Telegram webhook error: ${err.message}`)
  }
}

// ── Catch-all → serve the app ────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Debt Tracker running at http://localhost:${PORT}`)
  console.log(`  Database: ${path.join(__dirname, 'debt-tracker.db')}`)
  registerWebhook()
  console.log(`  Ctrl+C to stop\n`)
})
