// Parses an estimator's takeoff file into rows [{description, quantity, unit}].
// CSV/Excel parse locally; PDFs upload to storage and parse server-side
// (text layer when present, AI vision for scans).
import * as XLSX from 'xlsx'
import { supabase } from './supabase'

export async function parseTakeoffFile(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    return parsePdf(file)
  }
  return parseSpreadsheet(file)
}

async function parsePdf(file) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }

  const signRes = await fetch('/api/doc-upload', {
    method: 'POST', headers,
    body: JSON.stringify({ action: 'sign', filename: file.name }),
  })
  if (!signRes.ok) throw new Error(`Could not get upload URL (${signRes.status})`)
  const { upload_url, storage_path } = await signRes.json()

  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  })
  if (!put.ok) throw new Error(`Upload failed (${put.status})`)

  const res = await fetch('/.netlify/functions/parse-takeoff', {
    method: 'POST', headers,
    body: JSON.stringify({ storage_path }),
  })
  if (!res.ok) throw new Error((await res.text()).slice(0, 160))
  const { rows } = await res.json()
  return rows
}

async function parseSpreadsheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  let dropped = 0
  const rows = raw.map(r => {
    const keys = Object.keys(r)
    const dk = keys.find(k => /desc|item|scope|material/i.test(k))
    const qk = keys.find(k => /qty|quant|amount/i.test(k))
    const uk = keys.find(k => /unit|uom/i.test(k))
    if (!dk || !qk) return null
    // "450 LF" and "1,200" are quantities; strip units/commas before parsing
    // so those rows aren't silently discarded from the QA comparison.
    const rawQty = String(r[qk]).replace(/[$,]/g, '').trim()
    const qty = Number(rawQty !== '' && isFinite(Number(rawQty)) ? rawQty : rawQty.match(/^-?\d+(\.\d+)?/)?.[0])
    if (r[dk] && !isFinite(qty)) { dropped++; return null }
    return (r[dk] && isFinite(qty))
      ? { description: String(r[dk]), quantity: qty, unit: uk ? String(r[uk]).trim().toUpperCase() : '' }
      : null
  }).filter(Boolean)
  if (!rows.length) throw new Error('Could not find description + quantity columns in that file.')
  // Never report a partial parse as a full one — the QA comparison would run
  // against an incomplete takeoff without anyone knowing.
  rows.dropped = dropped
  return rows
}
