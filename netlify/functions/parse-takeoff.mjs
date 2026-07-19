// Parses an estimator's takeoff PDF into structured line items.
// Text-layer PDFs (Excel print-outs) parse via MuPDF text + Haiku; scanned
// PDFs fall back to Haiku vision on page images. Synchronous function —
// single fast Haiku call either way.
//
// POST { storage_path }  (client uploads to storage first via /api/doc-upload sign)
// →    { rows: [{description, quantity, unit}], source: 'text'|'vision', pages }

import { createClient } from '@supabase/supabase-js'

const HAIKU = 'claude-haiku-4-5-20251001'
const MAX_VISION_PAGES = 6

const EXTRACT_INSTRUCTION = `This is an estimator's quantity takeoff for underground utility construction. Extract EVERY line item.

Respond ONLY with JSON, no markdown:
{"rows":[{"description":"item description including size/material","quantity":number,"unit":"LF|EA|CY|SY|SF|LS|TON|VF|etc"}]}

Rules:
- quantity is the takeoff QUANTITY column — never unit price, extended price, or totals.
- Skip headers, section titles, subtotal/total rows, and blank lines.
- Keep descriptions as written (sizes, materials, specs).`

function validRows(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(r => r && typeof r.description === 'string' && r.description.trim() && isFinite(Number(r.quantity)))
    .map(r => ({
      description: r.description.trim().slice(0, 300),
      quantity: Number(r.quantity),
      unit: typeof r.unit === 'string' ? r.unit.trim().toUpperCase().slice(0, 8) : '',
    }))
}

async function callHaiku(content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: HAIKU, max_tokens: 8192, messages: [{ role: 'user', content }] }),
  })
  if (!res.ok) throw new Error(`AI parse failed (${res.status})`)
  const data = await res.json()
  const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('')
  const m = text.replace(/```json\s?|```/g, '').match(/\{[\s\S]*\}/)
  return m ? JSON.parse(m[0]) : null
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }

  // Verify the caller's Supabase JWT.
  const auth = event.headers.authorization || event.headers.Authorization || ''
  if (!auth.startsWith('Bearer ')) return { statusCode: 401, body: 'Unauthorized' }
  const verify = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: process.env.VITE_SUPABASE_ANON_KEY },
  })
  if (!verify.ok) return { statusCode: 401, body: 'Unauthorized' }
  const user = await verify.json()

  let body
  try { body = JSON.parse(event.body) } catch { return { statusCode: 400, body: 'Invalid JSON' } }
  const { storage_path } = body
  // Users may only parse files in their own storage folder. Path segments are
  // matched strictly — a bare prefix check lets "../<other-user>/…" through.
  const SAFE_PATH = new RegExp(`^${user.id}/(docs/)?[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
  if (typeof storage_path !== 'string' || storage_path.includes('..') || !SAFE_PATH.test(storage_path)) {
    return { statusCode: 400, body: 'Invalid storage_path' }
  }

  try {
    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    const { data: blob, error } = await supabase.storage.from('plan-uploads').download(storage_path)
    if (error) throw new Error(`Download failed: ${error.message}`)
    const buf = Buffer.from(await blob.arrayBuffer())

    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(buf, 'application/pdf')
    const pageCount = doc.countPages()

    // 1. Text-layer path — printed spreadsheets parse as plain text.
    let allText = ''
    for (let i = 0; i < Math.min(pageCount, 20); i++) {
      const page = doc.loadPage(i)
      try {
        const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
        for (const b of json.blocks || []) {
          for (const ln of b.lines || []) {
            const t = (ln.text != null ? ln.text : (ln.spans || []).map(s => s.text).join(''))
            if (t?.trim()) allText += t + '\n'
          }
        }
      } catch { /* page-level text failure → vision fallback below */ }
      page.destroy()
    }

    let parsed, source
    if (allText.trim().length > 200) {
      source = 'text'
      parsed = await callHaiku([{ type: 'text', text: `${EXTRACT_INSTRUCTION}\n\nTAKEOFF TEXT:\n${allText.slice(0, 40000)}` }])
    } else {
      // 2. Scanned takeoff — render pages and read with vision.
      source = 'vision'
      const content = []
      const pages = Math.min(pageCount, MAX_VISION_PAGES)
      for (let i = 0; i < pages; i++) {
        const page = doc.loadPage(i)
        const pixmap = page.toPixmap(mupdf.Matrix.scale(1.4, 1.4), mupdf.ColorSpace.DeviceRGB)
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pixmap.asPNG()).toString('base64') },
        })
        pixmap.destroy()
        page.destroy()
      }
      content.push({ type: 'text', text: EXTRACT_INSTRUCTION })
      parsed = await callHaiku(content)
    }

    const rows = validRows(parsed?.rows)
    if (!rows.length) {
      return { statusCode: 422, body: 'No line items found in that PDF — check it contains a quantity takeoff.' }
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, source, pages: pageCount }),
    }
  } catch (err) {
    console.error('parse-takeoff:', err)
    return { statusCode: 500, body: `Parse failed: ${err.message}` }
  }
}
