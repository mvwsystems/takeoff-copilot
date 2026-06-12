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

const { createClient } = require('@supabase/supabase-js')

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
const ANALYSIS_TYPES = new Set([
  'utility_plan', 'plan_profile', 'storm', 'sanitary', 'water', 'details',
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: contentParts }],
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('Haiku classification error:', res.status, errText.slice(0, 200))
    return batchImages.map(() => ({ classification: 'other', sheet_number: null, sheet_title: null }))
  }

  const data = await res.json()
  const text = data.content?.[0]?.text || '[]'

  try {
    const clean = text.replace(/```json\s?|```/g, '').trim()
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed.results)) return parsed.results
  } catch (e) {
    console.error('Classification parse error:', e.message, text.slice(0, 200))
  }

  return batchImages.map(() => ({ classification: 'other', sheet_number: null, sheet_title: null }))
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405 }
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
        batchResults.push({ classification: 'other', sheet_number: null, sheet_title: null })
      }
      allClassifications.push(...batchResults)

      const triageProgress = 15 + Math.round(((batchStart + BATCH_SIZE) / pageCount) * 20)
      await updateJob(job_id, { progress: Math.min(triageProgress, 35) })
    }
  } catch (triageErr) {
    console.error('Triage error:', triageErr.message)
    // Fill remaining with 'other' fallback so rasterization still runs
    while (allClassifications.length < pageCount) {
      allClassifications.push({ classification: 'other', sheet_number: null, sheet_title: null })
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
      const cls = allClassifications[i] || { classification: 'other', sheet_number: null, sheet_title: null }

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
        await supabase.from('sheets').insert({
          project_id,
          page_number: pageNum,
          storage_path: pagePath,
          dpi: 108,
          classification: cls.classification,
          included_in_analysis: ANALYSIS_TYPES.has(cls.classification),
          sheet_number: cls.sheet_number || null,
          sheet_title: cls.sheet_title || null,
        })
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
