#!/usr/bin/env node
// Test the full import pipeline locally — no Telegram needed.
// Usage: node test-import.js <path-to-pdf>
// This creates/uses a test database, parses the PDF, imports transactions, and shows results.

const pdfParse = require('pdf-parse')
const fs = require('fs')
const path = require('path')

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.log('Usage: node test-import.js <path-to-pdf>')
  console.log('\nAvailable test PDFs:')
  const downloads = '/Users/michaeleaton/Downloads'
  const pdfs = fs.readdirSync(downloads).filter(f => f.endsWith('.pdf') && /statement/i.test(f))
  pdfs.forEach(f => console.log(`  node test-import.js "${downloads}/${f}"`))
  process.exit(1)
}

// In-memory mock DB for testing (better-sqlite3 won't compile on Node 25)
const txStore = []
const importStore = []

function importTransactionsTest(txs, account, filename) {
  const now = new Date().toISOString()
  let imported = 0
  for (const tx of txs) {
    const dupe = txStore.find(t => t.date === tx.date && t.description === tx.description && t.amount === tx.amount && t.account === account)
    if (dupe) continue
    txStore.push({ ...tx, account, source_file: filename, imported_at: now })
    imported++
  }
  importStore.push({ filename, bank: account, imported_at: now, tx_count: imported })
  return imported
}

// Copy parser functions from server.js
const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' }

function detectBank(text) {
  if (/monzo/i.test(text)) return 'monzo'
  if (/hsbc/i.test(text)) {
    if (/Visa Card statement/i.test(text)) return 'hsbc_cc'
    return 'hsbc'
  }
  if (/lloyds\s*bank/i.test(text)) {
    if (/30-12-80/.test(text)) return 'lloyds'
    if (/77-17-31/.test(text)) return 'lloyds_amanda'
    return 'lloyds'
  }
  return null
}

function parseMonzoTransactions(text) {
  const txs = []
  const lines = text.split('\n').map(l => l.trim())
  const singleLine = /^(\d{2}\/\d{2}\/\d{4})(.+?)(-?[\d,]+\.\d{2})([\d,]+\.\d{2})$/
  const dateOnly = /^(\d{2}\/\d{2}\/\d{4})$/
  const amountBalance = /^(-?[\d,]+\.\d{2})([\d,]+\.\d{2})$/
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const sm = line.match(singleLine)
    if (sm) {
      const [dd,mm,yyyy] = sm[1].split('/'); const desc = sm[2].trim()
      const amount = parseFloat(sm[3].replace(/,/g,''))
      if (desc && !isNaN(amount)) txs.push({ date:`${yyyy}-${mm}-${dd}`, description:desc, amount, category:null })
      i++; continue
    }
    const dm = line.match(dateOnly)
    if (dm) {
      const dateStr = dm[1]; const descParts = []; let j = i+1
      while (j < lines.length) {
        if (dateOnly.test(lines[j]) || singleLine.test(lines[j])) break
        const am = lines[j].match(amountBalance)
        if (am) {
          const [dd,mm,yyyy] = dateStr.split('/'); const desc = descParts.join(' ').trim()
          const amount = parseFloat(am[1].replace(/,/g,''))
          if (desc && !isNaN(amount)) txs.push({ date:`${yyyy}-${mm}-${dd}`, description:desc, amount, category:null })
          j++; break
        }
        if (lines[j]) descParts.push(lines[j]); j++
      }
      i = j; continue
    }
    i++
  }
  return txs
}

function parseBritishShortDate(str) {
  const m = str.match(/^(\d{1,2})\s+(\w{3})\s+(\d{2,4})$/); if (!m) return null
  const day = m[1].padStart(2,'0'); const mon = MONTHS[m[2].toLowerCase()]; if (!mon) return null
  let yr = m[3]; if (yr.length===2) yr='20'+yr; return `${yr}-${mon}-${day}`
}

function parseLloydsTransactions(text) {
  const txs = []; const blocks = text.split(/\nDate\n/)
  for (let i=1; i<blocks.length; i++) {
    const lines = blocks[i].split('\n').map(l => l.trim().replace(/\.$/,''))
    const dateStr = lines[0]; if (!dateStr || !/^\d{1,2}\s+\w{3}\s+\d{2}$/.test(dateStr)) continue
    let description='', moneyIn=null, moneyOut=null
    for (let j=1; j<lines.length; j++) {
      if (lines[j]==='Description' && j+1<lines.length) description=lines[j+1]
      if (lines[j]==='Money In (£)' && j+1<lines.length) { const v=lines[j+1].replace(/,/g,''); moneyIn=v==='blank'?null:parseFloat(v) }
      if (lines[j]==='Money Out (£)' && j+1<lines.length) { const v=lines[j+1].replace(/,/g,''); moneyOut=v==='blank'?null:parseFloat(v) }
    }
    if (!description) continue
    let amount; if (moneyOut!==null&&!isNaN(moneyOut)) amount=-moneyOut; else if (moneyIn!==null&&!isNaN(moneyIn)) amount=moneyIn; else continue
    const date = parseBritishShortDate(dateStr); if (!date) continue
    txs.push({ date, description, amount, category:null })
  }
  return txs
}

function parseHSBCDate(str) {
  const m = str.match(/^(\d{1,2})\s+(\w{3})\s*(\d{2,4})$/); if (!m) return null
  const day = m[1].padStart(2,'0'); const mon = MONTHS[m[2].toLowerCase()]; if (!mon) return null
  let yr = m[3]; if (yr.length===2) yr='20'+yr; return `${yr}-${mon}-${day}`
}

function parseHSBCTransactions(text) {
  const txs = []; const lines = text.split('\n'); let inTx = false
  const pat = /^(\d{1,2}\s+\w{3}\d{2})(\d{1,2}\s+\w{3}\s*\d{2})(.+?)([\d,]+\.\d{2})(CR)?$/
  for (const line of lines) {
    const t = line.trim()
    if (/Your Transaction Details/i.test(t)) { inTx=true; continue }
    if (/Summary Of Interest/i.test(t)) { inTx=false; continue }
    if (!inTx) continue
    const m = t.match(pat); if (!m) continue
    const desc = m[3].trim(); const amt = parseFloat(m[4].replace(/,/g,'')); const cr = !!m[5]
    if (!desc || /^Received By Us|^Transaction Date|^Details|^Amount$/i.test(desc)) continue
    if (isNaN(amt)) continue
    const date = parseHSBCDate(m[2].trim()); if (!date) continue
    txs.push({ date, description:desc, amount: cr ? amt : -amt, category:null })
  }
  return txs
}

// ── Run ───────────────────────────────────────────────────────

async function main() {
  const buf = fs.readFileSync(pdfPath)
  const data = await pdfParse(buf)
  const bank = detectBank(data.text)
  const filename = path.basename(pdfPath)

  console.log(`\nFile: ${filename}`)
  console.log(`Bank: ${bank || 'UNKNOWN'}`)

  if (!bank) { console.log('Could not detect bank. Aborting.'); process.exit(1) }

  let txs
  if (bank === 'monzo') txs = parseMonzoTransactions(data.text)
  else if (bank === 'hsbc_cc') txs = parseHSBCCCTransactions(data.text)
  else if (bank === 'hsbc') txs = parseHSBCCurrentTransactions(data.text)
  else txs = parseLloydsTransactions(data.text)

  console.log(`Parsed: ${txs.length} transactions`)

  const imported = importTransactionsTest(txs, bank, filename)
  const dupes = txs.length - imported
  console.log(`Imported: ${imported} new, ${dupes} duplicates skipped`)

  const dates = txs.map(t => t.date).sort()
  if (dates.length) console.log(`Date range: ${dates[0]} to ${dates[dates.length-1]}`)
  console.log(`Uncategorised: ${txs.filter(t => !t.category).length}`)

  // Test deduplication — import again
  const imported2 = importTransactionsTest(txs, bank, filename)
  console.log(`\nDedup test (re-import): ${imported2} new (should be 0)`)
  console.log('')
}

main().catch(console.error)
