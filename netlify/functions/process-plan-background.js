// Background function: rasterizes uploaded plan PDF and uploads to Anthropic Files API.
// Named with -background suffix → Netlify gives it a 15-minute timeout.
// Called by confirm-upload edge function (fire-and-forget).
//
// Required env vars:
//   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
//
// Request body: { job_id, sheet_id, storage_path, project_id }

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

async function updateJob(jobId, fields) {
  await supabase.from('processing_jobs').update(fields).eq('id', jobId)
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405 }
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

  await updateJob(job_id, { stage: 'processing', progress: 15 })

  // ── 1. Download PDF from Supabase Storage ───────────────────
  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from('plan-uploads')
    .download(storage_path)

  if (dlErr) {
    await updateJob(job_id, { stage: 'error', error: `Download failed: ${dlErr.message}` })
    return { statusCode: 200 }
  }

  const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer())
  await updateJob(job_id, { progress: 25 })

  // ── 2. Upload to Anthropic Files API ────────────────────────
  let file_id = null
  try {
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
    const formData = new FormData()
    formData.append('file', blob, 'document.pdf')

    const anthropicRes = await fetch('https://api.anthropic.com/v1/files', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: formData,
    })

    if (anthropicRes.ok) {
      const anthropicData = await anthropicRes.json()
      file_id = anthropicData.id
      await supabase.from('sheets').update({ file_id }).eq('id', sheet_id)
    } else {
      const errText = await anthropicRes.text()
      console.error('Anthropic Files API error:', anthropicRes.status, errText)
    }
  } catch (anthropicErr) {
    console.error('Anthropic upload failed:', anthropicErr.message)
    // Non-fatal — rasterization can still produce thumbnails
  }

  await updateJob(job_id, { progress: 40 })

  // ── 3. Rasterize pages with MuPDF (WASM — no native deps) ───
  // Chosen over pdf-to-img, whose `canvas` native module is unreliable on Lambda.
  const baseStoragePath = storage_path.replace('/original.pdf', '')

  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
    const pageCount = doc.countPages()

    for (let i = 0; i < pageCount; i++) {
      const pageNum = i + 1
      const page = doc.loadPage(i)
      // scale 1.5 ≈ 108 DPI — keeps large-format plan sheets under Lambda memory limits
      const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB)
      const pageImage = Buffer.from(pixmap.asPNG())
      pixmap.destroy()
      page.destroy()

      const pagePath = `${baseStoragePath}/pages/page_${pageNum}.png`

      const { error: uploadErr } = await supabase.storage
        .from('plan-uploads')
        .upload(pagePath, pageImage, {
          contentType: 'image/png',
          upsert: true,
        })

      if (uploadErr) {
        console.error(`Page ${pageNum} upload failed:`, uploadErr.message)
        continue
      }

      if (pageNum === 1) {
        // Update the original sheet record with first-page thumbnail path
        await supabase.from('sheets')
          .update({ storage_path: pagePath, dpi: 108, page_number: 1 })
          .eq('id', sheet_id)
      } else {
        // Create additional sheet records for pages 2+
        await supabase.from('sheets').insert({
          project_id,
          page_number: pageNum,
          storage_path: pagePath,
          dpi: 108,
          file_id, // same PDF file_id for all pages
        })
      }

      const progress = 40 + Math.round((pageNum / pageCount) * 55)
      await updateJob(job_id, { progress })
    }
  } catch (rastErr) {
    console.error('Rasterization error:', rastErr.message)
    // Still mark ready if Anthropic upload worked — user can still analyze
    if (file_id) {
      await updateJob(job_id, { stage: 'ready', progress: 100 })
    } else {
      await updateJob(job_id, {
        stage: 'error',
        error: `Rasterization failed: ${rastErr.message}`,
      })
    }
    return { statusCode: 200 }
  }

  // ── 4. Done ──────────────────────────────────────────────────
  await updateJob(job_id, { stage: 'ready', progress: 100 })
  return { statusCode: 200 }
}
