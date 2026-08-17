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
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  let dropped = 0
  let rows = raw.map(r => {
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

  // Contractor worksheets rarely have labeled columns — row 1 is often the
  // project name, with section bands (WATER / SEWER / STORM), supplier price
  // rows, and JIC/production columns mixed in. When the header-keyed parse
  // finds nothing, fall back to row shape: description text followed by a
  // quantity + recognized unit pair. Requiring the unit is what keeps section
  // headers ("WATER | 650'") and supplier totals ("FORTILINE | 39980.98")
  // out of the takeoff.
  if (!rows.length) {
    dropped = 0
    rows = parseByRowShape(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }))
  }

  if (!rows.length) throw new Error('Could not read a takeoff from that file — no rows with a description, quantity, and unit (LF/EA/SF...) were found.')
  // Never report a partial parse as a full one — the QA comparison would run
  // against an incomplete takeoff without anyone knowing.
  rows.dropped = dropped
  return rows
}

const UNIT_RE = /^(?:LF|L\.?F\.?|FT|EA|E\.?A\.?|SF|S\.?F\.?|SY|CY|C\.?Y\.?|LS|L\.?S\.?|SQ\.?\s*FT|SQ\.?\s*YD|TON|TONS|GAL|RL|HR|HRS|DAY|DAYS|LB|LBS|LOAD|LOADS)$/i

function parseByRowShape(aoa) {
  const rows = []
  for (const cells of aoa) {
    // Description: first cell holding text that isn't just a number.
    const di = cells.findIndex(c => {
      const s = String(c).trim()
      return s !== '' && !isFinite(Number(s.replace(/[$,]/g, '')))
    })
    if (di === -1) continue
    const description = String(cells[di]).trim()

    // Quantity: the first number after the description that is immediately
    // followed by a unit cell — or a combined "220 FT" cell.
    let quantity = null, unit = ''
    for (let i = di + 1; i < cells.length; i++) {
      const val = String(cells[i]).replace(/[$,]/g, '').trim()
      if (val === '') continue
      const next = String(cells[i + 1] ?? '').trim()
      if (isFinite(Number(val)) && UNIT_RE.test(next)) {
        quantity = Number(val)
        unit = next.toUpperCase()
        break
      }
      const combined = val.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z.\s]{0,6})$/)
      if (combined && UNIT_RE.test(combined[2].trim())) {
        quantity = Number(combined[1])
        unit = combined[2].trim().toUpperCase()
        break
      }
    }
    if (quantity == null) continue
    rows.push({ description, quantity, unit })
  }
  return rows
}
