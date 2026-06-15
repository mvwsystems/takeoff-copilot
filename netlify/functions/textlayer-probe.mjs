// Temporary diagnostic: downloads a project's PDF server-side and reports the
// text-layer extraction stats (zero AI cost). Confirms hybrid vs raster-only on
// real plans. Remove after verifying.  GET /.netlify/functions/textlayer-probe?project=<id>

import { createClient } from '@supabase/supabase-js'

export const handler = async (event) => {
  const project_id = event.queryStringParameters?.project
  if (!project_id) return { statusCode: 400, body: 'pass ?project=<id>' }

  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data: sheets } = await supabase
    .from('sheets').select('page_number, storage_path, classification, sheet_number')
    .eq('project_id', project_id).eq('included_in_analysis', true).order('page_number')
  if (!sheets?.length) return { statusCode: 404, body: 'no analyzed sheets' }

  const pdfPath = sheets[0].storage_path.replace(/\/pages\/page_\d+\.png$/, '/original.pdf')
  const { data: blob, error } = await supabase.storage.from('plan-uploads').download(pdfPath)
  if (error) return { statusCode: 500, body: `download: ${error.message}` }
  const buf = Buffer.from(await blob.arrayBuffer())

  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(buf, 'application/pdf')

  let totalRuns = 0, sheetsWithText = 0, totalTables = 0
  const perSheet = []
  for (const s of sheets) {
    const page = doc.loadPage(s.page_number - 1)
    let runs = 0, tables = 0, sampleText = []
    try {
      const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
      for (const b of json.blocks || []) {
        const lines = (b.lines || []).map(l => (l.text != null ? l.text : (l.spans || []).map(s => s.text).join('')).trim()).filter(Boolean)
        runs += lines.length
        if (sampleText.length < 4) sampleText.push(...lines.slice(0, 4 - sampleText.length))
        // crude table check: >=3 lines splitting into same >=2 cols
        const split = lines.map(t => t.split(/\s{2,}/).filter(Boolean))
        const cnt = {}; split.forEach(c => { if (c.length >= 2) cnt[c.length] = (cnt[c.length] || 0) + 1 })
        if (Object.values(cnt).some(n => n >= 3)) tables++
      }
    } catch (e) { /* ignore */ }
    page.destroy()
    totalRuns += runs
    totalTables += tables
    if (runs >= 5) sheetsWithText++
    if (perSheet.length < 12) perSheet.push({ sheet: s.sheet_number || `pg${s.page_number}`, cls: s.classification, runs, tables, sample: sampleText })
  }
  const mode = sheetsWithText >= Math.max(1, Math.ceil(sheets.length * 0.25)) ? 'hybrid' : 'raster-only'

  return {
    statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheets: sheets.length, totalRuns, sheetsWithText, totalTables, mode, perSheet }, null, 2),
  }
}
