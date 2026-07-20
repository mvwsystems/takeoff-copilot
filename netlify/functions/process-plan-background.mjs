// Background function: triage-classifies every page of an uploaded plan PDF,
// rasterizes pages at 108 DPI, and saves thumbnails to Supabase Storage.
// Named with -background suffix → Netlify gives it a 15-minute timeout.
// Called by confirm-upload edge function (fire-and-forget).
//
// Required env vars:
//   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
//
// Request body: { job_id, sheet_id, storage_path, project_id }
//
// Stages emitted: processing → triage_complete | error

// ESM (.mjs): root package.json has "type":"module" and ships in the function
// bundle, so CommonJS .js files die at load with "module is not defined".
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Background functions are publicly POST-able at /.netlify/functions/* — every
// caller must present the shared secret or an outsider can drive Anthropic
// spend and service-role DB writes against arbitrary projects.
function fnSecretOk(headers) {
  const provided = headers?.['x-fn-secret'] || headers?.['X-Fn-Secret']
  const expected = process.env.WEBHOOK_SECRET
  if (!provided || !expected) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Client is created lazily inside the handler — a module-level createClient
// with a missing env var throws at cold start BEFORE any logging or DB write,
// which makes the failure invisible (job stays stuck at 'uploaded').
let supabase = null
function getSupabase() {
  if (supabase) return supabase
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(`Missing env: ${!url ? 'VITE_SUPABASE_URL ' : ''}${!key ? 'SUPABASE_SERVICE_ROLE_KEY' : ''}`.trim())
  }
  supabase = createClient(url, key)
  return supabase
}

// Sheet types that proceed to the heavy analysis pass.
// All others default to included_in_analysis = false.
// 'unclassified' means the classification call itself failed — those default
// IN (the user can exclude them on the sheet map) rather than silently out.
const ANALYSIS_TYPES = new Set([
  'utility_plan', 'plan_profile', 'storm', 'sanitary', 'water', 'details', 'unclassified',
  // Grading is auto-included so the depth engine can pull finished-grade
  // elevations for structures whose rim isn't called out on the profile
  // ("sometimes it's not and you have to use the grading to find out").
  'grading',
])

const CLASSIFY_PROMPT = `You are classifying construction plan sheets for a utility contractor.

I will show you one or more plan sheet images. Classify each one.

Classification types (pick the single best fit):
- cover          Title/cover sheet
- sheet_index    Sheet index or drawing list
- general_notes  General notes, specifications, or legend sheet
- demo           Demolition plan
- grading        Grading or drainage plan
- paving         Paving plan
- utility_plan   Plan-view utility sheet (water, sewer, or storm in plan view)
- plan_profile   Has BOTH a plan view AND a profile (elevation) below — the most important analysis sheets
- storm          Storm sewer / drainage focused sheet
- sanitary       Sanitary sewer focused sheet
- water          Water line focused sheet
- details        Construction details or standard details sheet
- erosion_control Erosion & sediment control / SWPPP sheet
- landscape      Landscaping or irrigation sheet
- electrical     Electrical or lighting sheet
- other          Anything not listed above

Respond ONLY with a JSON array — one object per image, in order:
[
  {
    "classification": "utility_plan",
    "sheet_number": "U-1",
    "sheet_title": "Utility Plan Sta 0+00 to 12+50"
  }
]

Set sheet_number and sheet_title to null if not clearly visible.

If classification is "sheet_index", also include a "sheet_index" array extracting the full sheet list:
{
  "classification": "sheet_index",
  "sheet_number": null,
  "sheet_title": "Sheet Index",
  "sheet_index": [{"number": "C-1", "title": "Cover Sheet"}, {"number": "U-1", "title": "Utility Plan"}, ...]
}

No explanation. Return only the JSON array.`

async function updateJob(jobId, fields) {
  await supabase.from('processing_jobs').update(fields).eq('id', jobId)
}

// A whole-batch fallback marks pages "unclassified" (NOT 'other'): 'other' is
// a real model verdict that excludes a sheet from analysis, while a failed API
// call says nothing about the sheet. Unclassified pages default INTO the
// analysis set so a transient 429 can never silently drop utility sheets.
const FALLBACK = { classification: 'unclassified', sheet_number: null, sheet_title: null }

async function classifyBatch(batchImages) {
  const contentParts = []
  batchImages.forEach((b64, i) => {
    contentParts.push({ type: 'text', text: `Image ${i + 1}:` })
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 },
    })
  })
  contentParts.push({ type: 'text', text: CLASSIFY_PROMPT })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // Enough headroom for a full sheet-index table — 1024 truncated them.
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: contentParts }],
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error(`Haiku classification error (attempt ${attempt}):`, res.status, errText.slice(0, 200))
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 5000))
        continue
      }
      return batchImages.map(() => ({ ...FALLBACK }))
    }

    const data = await res.json()
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('') || '[]'

    try {
      const clean = text.replace(/```json\s?|```/g, '').trim()
      const parsed = JSON.parse(clean)
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.results) ? parsed.results : null
      // Truncate hallucinated extras — one spurious entry misaligns every
      // subsequent page's classification for the rest of the document.
      if (arr) return arr.slice(0, batchImages.length)
    } catch (e) {
      console.error('Classification parse error:', e.message, text.slice(0, 200))
    }
    return batchImages.map(() => ({ ...FALLBACK }))
  }
  return batchImages.map(() => ({ ...FALLBACK }))
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405 }
  }
  if (!fnSecretOk(event.headers)) {
    return { statusCode: 401, body: 'Unauthorized' }
  }

  try {
    getSupabase() // populates module-level `supabase` for all code below
  } catch (err) {
    console.error('FATAL — cannot start:', err.message)
    return { statusCode: 500, body: err.message }
  }

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  const { job_id, sheet_id, storage_path, project_id } = body
  if (!job_id || !sheet_id || !storage_path || !project_id) {
    return { statusCode: 400, body: 'Missing fields' }
  }

  await updateJob(job_id, { stage: 'processing', progress: 5 })

  // ── 1. Download PDF from Supabase Storage ────────────────────
  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from('plan-uploads')
    .download(storage_path)

  if (dlErr) {
    await updateJob(job_id, { stage: 'error', error: `Download failed: ${dlErr.message}` })
    return { statusCode: 200 }
  }

  const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer())
  await updateJob(job_id, { progress: 15 })

  // ── 2. Open PDF with MuPDF ───────────────────────────────────
  let mupdf, doc, pageCount
  try {
    mupdf = await import('mupdf')
    doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
    pageCount = doc.countPages()
  } catch (err) {
    await updateJob(job_id, { stage: 'error', error: `PDF open failed: ${err.message}` })
    return { statusCode: 200 }
  }

  const baseStoragePath = storage_path.replace('/original.pdf', '')

  // ── 3. Triage: classify pages in batches of 8 (72 DPI) ──────
  // Render small images just for Haiku — never saved to storage.
  const BATCH_SIZE = 8
  const allClassifications = []

  try {
    for (let batchStart = 0; batchStart < pageCount; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, pageCount)
      const batchImages = []

      for (let i = batchStart; i < batchEnd; i++) {
        const page = doc.loadPage(i)
        // scale 1.0 = 72 DPI — small enough for cheap Haiku calls
        const pixmap = page.toPixmap(mupdf.Matrix.scale(1.0, 1.0), mupdf.ColorSpace.DeviceRGB)
        batchImages.push(Buffer.from(pixmap.asPNG()).toString('base64'))
        pixmap.destroy()
        page.destroy()
      }

      const batchResults = await classifyBatch(batchImages)
      // Pad fallback if Haiku returned fewer results than images
      while (batchResults.length < batchImages.length) {
        batchResults.push({ ...FALLBACK })
      }
      allClassifications.push(...batchResults)

      const triageProgress = 15 + Math.round(((batchStart + BATCH_SIZE) / pageCount) * 20)
      await updateJob(job_id, { progress: Math.min(triageProgress, 35) })
    }
  } catch (triageErr) {
    console.error('Triage error:', triageErr.message)
    // Fill remaining as unclassified (defaults into analysis) so rasterization
    // still runs and no utility sheet is silently excluded.
    while (allClassifications.length < pageCount) {
      allClassifications.push({ ...FALLBACK })
    }
  }

  // ── 4. Refine classifications using sheet index ───────────────
  // If any page is a sheet_index, use its table to improve 'other' calls
  const indexEntry = allClassifications.find(
    c => (c.classification === 'sheet_index' || c.classification === 'cover') && c.sheet_index?.length > 0
  )
  if (indexEntry?.sheet_index?.length > 0) {
    const keywordMap = {
      utility: 'utility_plan', water: 'water', sewer: 'sanitary', storm: 'storm',
      drain: 'storm', profile: 'plan_profile', detail: 'details',
      demo: 'demo', grading: 'grading', grade: 'grading', paving: 'paving',
      erosion: 'erosion_control', landscape: 'landscape', electrical: 'electrical',
    }
    allClassifications.forEach((cls) => {
      if (cls.classification !== 'other' || !cls.sheet_number) return
      const match = indexEntry.sheet_index.find(
        e => e.number?.trim().toUpperCase() === cls.sheet_number.trim().toUpperCase()
      )
      if (!match) return
      const title = (match.title || '').toLowerCase()
      for (const [keyword, type] of Object.entries(keywordMap)) {
        if (title.includes(keyword)) { cls.classification = type; break }
      }
    })
  }

  await updateJob(job_id, { progress: 40 })

  // ── 5. Rasterize at 108 DPI, upload PNGs, update DB ─────────
  try {
    for (let i = 0; i < pageCount; i++) {
      const pageNum = i + 1
      const page = doc.loadPage(i)
      // scale 1.5 ≈ 108 DPI — keeps large-format plan sheets under Lambda memory limits
      const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB)
      const pageImage = Buffer.from(pixmap.asPNG())
      pixmap.destroy()
      page.destroy()

      const pagePath = `${baseStoragePath}/pages/page_${pageNum}.png`
      const cls = allClassifications[i] || { ...FALLBACK }

      const { error: uploadErr } = await supabase.storage
        .from('plan-uploads')
        .upload(pagePath, pageImage, { contentType: 'image/png', upsert: true })

      if (uploadErr) {
        console.error(`Page ${pageNum} upload failed:`, uploadErr.message)
      }

      if (pageNum === 1) {
        await supabase.from('sheets').update({
          storage_path: pagePath,
          dpi: 108,
          classification: cls.classification,
          included_in_analysis: ANALYSIS_TYPES.has(cls.classification),
          sheet_number: cls.sheet_number || null,
          sheet_title: cls.sheet_title || null,
        }).eq('id', sheet_id)
      } else {
        // Upsert on (project_id, page_number) — a re-run after a mid-loop
        // failure must update the existing rows, not insert duplicates that
        // double every downstream tile and quantity.
        const { error: upErr } = await supabase.from('sheets').upsert({
          project_id,
          page_number: pageNum,
          storage_path: pagePath,
          dpi: 108,
          classification: cls.classification,
          included_in_analysis: ANALYSIS_TYPES.has(cls.classification),
          sheet_number: cls.sheet_number || null,
          sheet_title: cls.sheet_title || null,
        }, { onConflict: 'project_id,page_number' })
        if (upErr) console.error(`Page ${pageNum} sheet upsert failed:`, upErr.message)
      }

      const progress = 40 + Math.round((pageNum / pageCount) * 55)
      await updateJob(job_id, { progress })
    }
  } catch (rastErr) {
    console.error('Rasterization error:', rastErr.message)
    await updateJob(job_id, { stage: 'error', error: `Rasterization failed: ${rastErr.message}` })
    return { statusCode: 200 }
  }

  // ── 6. Done ──────────────────────────────────────────────────
  await updateJob(job_id, { stage: 'triage_complete', progress: 100 })
  return { statusCode: 200 }
}
