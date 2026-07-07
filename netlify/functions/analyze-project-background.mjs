// Background function: tiled, multi-pass takeoff analysis. The accuracy core.
// Named with -background suffix → Netlify gives it a 15-minute timeout.
// Called by start-analysis edge function (fire-and-forget).
//
// Passes (per project):
//   1. Plan quantities  — Opus over plan-view tiles (utility/storm/sanitary/water/plan_profile)
//   2. Profiles         — Opus over plan_profile tiles (runs, elevations, slopes)
//   3. Merge + dedupe   — code reconciliation + Haiku overlap-zone dedupe
//   4. Small-dia sweep  — Opus, lines 2" and smaller only (systematically missed in calibration)
//   5. Sanity check     — Haiku parses engineer quantity tables → variance table
//
// Each pass's JSON is validated against a schema before anything touches line_items.
// System prompt for heavy passes loads from server/prompts/takeoff-brain.md.
//
// Required env vars: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// Request body: { job_id, project_id }

// ESM (.mjs): root package.json has "type":"module" and ships in the function
// bundle, so CommonJS .js files die at load with "module is not defined".
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

// NOTE: do NOT use import.meta.url here. Netlify's esbuild bundles these .mjs
// functions to CommonJS, where import.meta.url is undefined — fileURLToPath()
// then throws at module load, crashing the function before the handler runs
// (an invisible cold-start failure). The CJS bundle provides __dirname natively.

// Lazy client — module-level createClient with a missing env var dies at cold
// start before any logging, leaving jobs invisibly stuck.
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

// Updates a job via the raw Supabase REST API — independent of the supabase-js
// client, so it still works if createClient() itself failed. Used for the
// handler heartbeat and the top-level error reporter so failures are never
// invisible (a silently-stuck job is the worst failure mode).
async function rawJobUpdate(jobId, fields) {
  try {
    const url = process.env.VITE_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await fetch(`${url}/rest/v1/processing_jobs?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(fields),
    })
    if (!res.ok) console.error('rawJobUpdate non-OK:', res.status, await res.text())
  } catch (e) {
    console.error('rawJobUpdate threw:', e.message)
  }
}

const OPUS = 'claude-opus-4-8'
const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5-20251001'
// Re-chain to a fresh invocation at 12 min, leaving buffer before Netlify's
// 15-min hard kill. Per-tile results are persisted, so the next invocation
// resumes exactly where this one stopped.
const CHAIN_AFTER_MS = 12 * 60 * 1000
const MAX_CHAINS = 150            // hard stop — batches max out at 24h anyway
const BATCH_POLL_MS = 15_000
const BATCH_CHUNK = 60            // tiles per batch — keeps request bodies ~50MB
const BLANK_PNG_BYTES = 15_000    // a 1568px tile that compresses under this is empty
const MAX_RESUBMITS = 2

// $/MTok at Message Batches pricing (50% of standard). Assembly Haiku calls
// (merge/dedupe/materials) run synchronously at full price but cost pennies.
// Sonnet 5 is intro-priced ($2/$10) through 2026-08-31, then $3/$15.
const SONNET_INTRO = Date.now() < Date.parse('2026-09-01T00:00:00Z')
const PRICES = {
  opus: { in: 5 * 0.5, out: 25 * 0.5 },
  sonnet: SONNET_INTRO ? { in: 2 * 0.5, out: 10 * 0.5 } : { in: 3 * 0.5, out: 15 * 0.5 },
  haiku: { in: 1 * 0.5, out: 5 * 0.5 },
}
// Calibration configs map pass → tier name; tiers resolve to model IDs here.
const MODEL_TIERS = { opus: OPUS, sonnet: SONNET, haiku: HAIKU }
const tierOf = (modelId) => (modelId === HAIKU ? 'haiku' : modelId === SONNET ? 'sonnet' : 'opus')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PASS1_TYPES = new Set(['utility_plan', 'storm', 'sanitary', 'water', 'plan_profile', 'grading', 'paving', 'demo', 'erosion_control', 'landscape', 'electrical', 'other'])
const DEPTH_BUCKETS = [['0-6', 0, 6], ['6-8', 6, 8], ['8-10', 8, 10], ['10+', 10, Infinity]]
const TRENCH_SAFETY_FT = 5  // OSHA 1926 Subpart P trigger
const DEEP_EXCAVATION_FT = 10

// ── Takeoff Brain prompt (editable without code changes) ───────
let brainCache = null
function loadBrain() {
  if (brainCache) return brainCache
  // __dirname is the CJS-bundled function dir (e.g. /var/task/netlify/functions);
  // included_files places server/prompts/** under the task root (/var/task).
  const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  const roots = [
    process.env.LAMBDA_TASK_ROOT,
    process.cwd(),
    dir,
    path.join(dir, '..', '..'),
  ].filter(Boolean)
  const candidates = roots.map(r => path.join(r, 'server/prompts/takeoff-brain.md'))
  for (const p of candidates) {
    try {
      brainCache = fs.readFileSync(p, 'utf8')
      console.log('Takeoff Brain loaded from', p)
      return brainCache
    } catch { /* try next */ }
  }
  throw new Error(`takeoff-brain.md not found. Tried: ${candidates.join(' | ')}`)
}

// ── Pass task prompts (appended to the brain) ──────────────────
const PASS1_TASK = `
YOUR TASK (PASS 1 — PLAN QUANTITIES):
Extract EVERY utility line item visible in this tile: pipe runs (diameter, material, length), structures (manholes, inlets, cleanouts, headwalls — with depth), fittings, valves, hydrants, FDCs, and service connections. Apply all hard rules.

Respond ONLY with this JSON, no markdown, no preamble:
{"items":[{"category":"PIPE|STRUCTURE|FITTING|EXCAVATION|SERVICE|TESTING|OTHER","description":"material, size, class/spec, purpose","quantity":number or null,"unit":"LF|EA|CY|SY|SF|LS|TON","diameter_in":number or null,"material":"string or null","location":"station / structure ID / street — REQUIRED for dedupe","confidence":"HIGH|MEDIUM|LOW","note":"HIGH: one clause citing the callout location, max 15 words. MEDIUM/LOW: why + what to verify, max 30 words","continues_beyond_tile":boolean}]}
Empty tile (no utility content visible): {"items":[]}`

const PASS2_TASK = `
YOUR TASK (PASS 2 — PROFILES):
This tile is from a plan-and-profile sheet. Extract ONLY profile (elevation view) data. For each pipe run visible in the profile: run identity (structure-to-structure or stationing), rim/finished-grade elevations, invert elevations at each structure, slope, and length. Compute depth at each structure (rim minus invert) when both are shown.

Respond ONLY with this JSON, no markdown, no preamble:
{"runs":[{"run_id":"e.g. 'SSMH-1 to SSMH-2' or line label","utility":"sanitary|storm|water|other","from_structure":"string or null","to_structure":"string or null","station_start":"string or null","station_end":"string or null","length_lf":number or null,"slope_pct":number or null,"diameter_in":number or null,"material":"string or null","structures":[{"id":"string","rim_elev":number or null,"invert_elev":number or null,"depth_ft":number or null}],"confidence":"HIGH|MEDIUM|LOW","note":"HIGH: cite where read, max 15 words. MEDIUM/LOW: what to verify, max 30 words","continues_beyond_tile":boolean}]}
No profile visible in this tile: {"runs":[]}`

const PASS4_TASK = `
YOUR TASK (PASS 4 — SMALL-DIAMETER SWEEP):
This is a dedicated sweep for lines 2 INCHES AND SMALLER ONLY — domestic water services, irrigation taps and laterals, small fire lines, air release lines, copper/PE service tubing. These were systematically missed in calibration testing because they are drawn thin and labeled small. Scan this tile slowly. Check building connections, meter boxes, hydrant legs, and irrigation points. Report ONLY lines with diameter ≤ 2" and their directly-associated fittings (corp stops, curb stops, meter setters, saddles).

Respond ONLY with this JSON, no markdown, no preamble:
{"items":[{"category":"PIPE|FITTING|SERVICE|OTHER","description":"material, size, purpose","quantity":number or null,"unit":"LF|EA","diameter_in":number or null,"material":"string or null","location":"station / structure ID / street — REQUIRED","confidence":"HIGH|MEDIUM|LOW","note":"HIGH: one clause, max 15 words. MEDIUM/LOW: what to verify, max 30 words","continues_beyond_tile":boolean}]}
Nothing ≤ 2" visible: {"items":[]}`

const PASS5_TASK = `You are reading a tile from a construction plan sheet. Determine whether this tile contains an ENGINEER'S QUANTITY TABLE (a tabulated summary of estimated quantities — columns like Item / Description / Qty / Unit). If yes, parse every legible row exactly as printed. Do not invent rows; skip illegible ones.

Respond ONLY with this JSON, no markdown:
{"table_found":boolean,"rows":[{"item_no":"string or null","description":"string","quantity":number,"unit":"string"}]}`

const MERGE_TASK = `You are a takeoff data merger. Below is a JSON array of line items extracted from OVERLAPPING tiles of the same construction plan set. Tiles overlap by ~15%, so the same item often appears 2+ times (same description/size/material and same or adjacent location). Also, pipe runs crossing tile boundaries may appear as a callout-quantity entry in one tile and a "continues_beyond_tile" null-quantity entry in another — these are the SAME run.

Merge rules:
1. Same description + size + material + same/overlapping location → ONE item. Keep the entry with a real quantity and the most specific note; never sum duplicate sightings of the same run or structure.
2. An entry with quantity null and continues_beyond_tile true merges into a matching entry that has a quantity. If NO matching entry has a quantity, keep one merged entry with quantity null and confidence LOW.
3. Distinct segments/structures at clearly different locations are NOT duplicates — keep them all. When in doubt, keep both and set confidence LOW with a note saying possible duplicate.
4. Never change quantities, units, or invent items. Only consolidate.

Respond ONLY with this JSON, no markdown:
{"items":[{"category":"...","description":"...","quantity":number or null,"unit":"...","diameter_in":number or null,"material":"string or null","location":"...","confidence":"HIGH|MEDIUM|LOW","note":"...","source_ids":[numbers — the input "id" values merged into this item]}]}`

const PASS4_DEDUPE_TASK = `You are a takeoff data merger. EXISTING is the consolidated takeoff. CANDIDATES are items found by a dedicated small-diameter (≤2") sweep of the same plans. Return ONLY the candidates that are genuinely NEW — not already represented in EXISTING (same description/size/location = already represented). Consolidate duplicate candidates among themselves first (same merge rules: never sum duplicate sightings).

Respond ONLY with this JSON, no markdown:
{"new_items":[{"category":"...","description":"...","quantity":number or null,"unit":"...","diameter_in":number or null,"material":"string or null","location":"...","confidence":"HIGH|MEDIUM|LOW","note":"..."}]}`

// ── Helpers ────────────────────────────────────────────────────
async function updateJob(jobId, fields) {
  await supabase.from('processing_jobs').update(fields).eq('id', jobId)
}

async function callClaude({ model, system, content, maxTokens = 8192 }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
      }),
    })
    if (res.ok) {
      const data = await res.json()
      return data.content?.map(b => (b.type === 'text' ? b.text : '')).join('') || ''
    }
    const errText = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      console.warn(`Claude ${res.status}, retry ${attempt}`)
      await new Promise(r => setTimeout(r, attempt * 5000))
      continue
    }
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`)
  }
}

function parseJson(text) {
  const clean = text.replace(/```json\s?|```/g, '').trim()
  try { return JSON.parse(clean) } catch { /* fall through */ }
  const m = clean.match(/[{[][\s\S]*[}\]]/)
  if (m) { try { return JSON.parse(m[0]) } catch { /* fall through */ } }
  return null
}

// ── Schema validation — nothing unvalidated reaches line_items ─
const CATEGORIES = new Set(['PIPE', 'STRUCTURE', 'FITTING', 'EXCAVATION', 'SERVICE', 'TESTING', 'OTHER'])
const CONFIDENCES = new Set(['HIGH', 'MEDIUM', 'LOW'])

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && isFinite(Number(v))) return Number(v)
  return null
}

function validateItems(raw, passName) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw) {
    if (!it || typeof it.description !== 'string' || !it.description.trim()) {
      console.warn(`${passName}: dropped item without description`); continue
    }
    out.push({
      category: CATEGORIES.has(it.category) ? it.category : 'OTHER',
      description: it.description.trim().slice(0, 500),
      quantity: num(it.quantity),
      unit: typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim().toUpperCase().slice(0, 8) : 'EA',
      diameter_in: num(it.diameter_in),
      material: typeof it.material === 'string' ? it.material.slice(0, 80) : null,
      location: typeof it.location === 'string' ? it.location.slice(0, 200) : '',
      confidence: CONFIDENCES.has(it.confidence) ? it.confidence : 'LOW',
      note: typeof it.note === 'string' ? it.note.slice(0, 1000) : '',
      continues_beyond_tile: it.continues_beyond_tile === true,
      source_ids: Array.isArray(it.source_ids) ? it.source_ids.filter(n => typeof n === 'number') : [],
    })
  }
  return out
}

function validateRuns(raw, passName) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw) {
    if (!r || typeof r.run_id !== 'string' || !r.run_id.trim()) {
      console.warn(`${passName}: dropped run without run_id`); continue
    }
    out.push({
      run_id: r.run_id.trim().slice(0, 120),
      utility: ['sanitary', 'storm', 'water'].includes(r.utility) ? r.utility : 'other',
      from_structure: typeof r.from_structure === 'string' ? r.from_structure.slice(0, 60) : null,
      to_structure: typeof r.to_structure === 'string' ? r.to_structure.slice(0, 60) : null,
      station_start: typeof r.station_start === 'string' ? r.station_start.slice(0, 30) : null,
      station_end: typeof r.station_end === 'string' ? r.station_end.slice(0, 30) : null,
      length_lf: num(r.length_lf),
      slope_pct: num(r.slope_pct),
      diameter_in: num(r.diameter_in),
      material: typeof r.material === 'string' ? r.material.slice(0, 80) : null,
      structures: (Array.isArray(r.structures) ? r.structures : [])
        .filter(s => s && typeof s.id === 'string')
        .map(s => ({ id: s.id.slice(0, 60), rim_elev: num(s.rim_elev), invert_elev: num(s.invert_elev), depth_ft: num(s.depth_ft) })),
      confidence: CONFIDENCES.has(r.confidence) ? r.confidence : 'LOW',
      note: typeof r.note === 'string' ? r.note.slice(0, 1000) : '',
    })
  }
  return out
}

function validateEngineerRows(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(r => r && typeof r.description === 'string' && r.description.trim() && num(r.quantity) !== null)
    .map(r => ({
      item_no: typeof r.item_no === 'string' ? r.item_no.slice(0, 20) : null,
      description: r.description.trim().slice(0, 300),
      quantity: num(r.quantity),
      unit: typeof r.unit === 'string' ? r.unit.trim().toUpperCase().slice(0, 8) : '',
    }))
}

// Pass 5 tile validator: only keep rows when the model confirmed a table.
function validateEngineerTile(parsed) {
  if (!parsed || parsed.table_found !== true) return []
  return validateEngineerRows(parsed.rows)
}

// ── Tiling ─────────────────────────────────────────────────────
// Grid decided from hypothetical 250-DPI pixel dims. Each tile renders at its
// own scale so the long edge lands at the API's 1568px max — equivalent to
// "rasterize at 250 DPI then downscale" without an image-resize dependency.
function gridFor(pageWpts, pageHpts) {
  const longEdge250 = (Math.max(pageWpts, pageHpts) / 72) * 250
  if (longEdge250 <= 1568) return { cols: 1, rows: 1 }
  if (longEdge250 <= 10500) return { cols: 2, rows: 2 }   // 24x36 Arch D → 2x2
  return { cols: 3, rows: 3 }                              // very dense / Arch E+
}

function tileName(row, col, rows, cols) {
  if (rows === 1 && cols === 1) return 'full sheet'
  const rowNames = rows === 2 ? ['top', 'bottom'] : ['top', 'middle', 'bottom']
  const colNames = cols === 2 ? ['left', 'right'] : ['left', 'center', 'right']
  return `${rowNames[row]}-${colNames[col]}${rows === 2 ? ' quadrant' : ''}`
}

function renderTiles(mupdf, doc, pageIndex) {
  const page = doc.loadPage(pageIndex)
  const [x0, y0, x1, y1] = page.getBounds()
  const pageW = x1 - x0, pageH = y1 - y0
  const { cols, rows } = gridFor(pageW, pageH)
  const stepX = pageW / cols, stepY = pageH / rows
  const ovX = 0.075 * stepX, ovY = 0.075 * stepY  // 15% total overlap between neighbors
  const maxScale = 250 / 72
  const tiles = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tx0 = col * stepX - (col > 0 ? ovX : 0)
      const tx1 = (col + 1) * stepX + (col < cols - 1 ? ovX : 0)
      const ty0 = row * stepY - (row > 0 ? ovY : 0)
      const ty1 = (row + 1) * stepY + (row < rows - 1 ? ovY : 0)
      const scale = Math.min(1568 / Math.max(tx1 - tx0, ty1 - ty0), maxScale)
      const matrix = mupdf.Matrix.scale(scale, scale)
      const bbox = [Math.floor(tx0 * scale), Math.floor(ty0 * scale), Math.ceil(tx1 * scale), Math.ceil(ty1 * scale)]
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
      pixmap.clear(255)
      const device = new mupdf.DrawDevice(matrix, pixmap)
      page.run(device, mupdf.Matrix.identity)
      device.close()
      const png = Buffer.from(pixmap.asPNG())
      tiles.push({
        idx: row * cols + col,           // stable tile identity (row-major) — used in tile_key / custom_id
        base64: png.toString('base64'),
        pngBytes: png.length,            // blank-tile heuristic: near-empty tiles compress tiny
        position: tileName(row, col, rows, cols),
        grid: `${rows}x${cols}`,
        pageBBox: [tx0, ty0, tx1, ty1],  // page-space (points) — matches text-layer coords
      })
      pixmap.destroy()
    }
  }
  page.destroy()
  return tiles
}

function tileContext(sheet, tile) {
  const label = [sheet.sheet_number, sheet.sheet_title].filter(Boolean).join(' — ') || `page ${sheet.page_number}`
  return `CONTEXT: Sheet "${label}" (classification: ${sheet.classification || 'unknown'}). This image is the ${tile.position} of a ${tile.grid} tile grid; tiles overlap neighbors by ~15%.`
}

// ── Embedded text layer (MuPDF structured text) ──────────────────
// We reuse MuPDF (already bundled for rasterization) instead of adding pdf.js
// (a dependency we removed) or pdfplumber (a separate Python runtime). MuPDF's
// structured-text coordinates share the same page space as our tile bboxes, so
// mapping text → tile is a direct rectangle intersection — no re-projection.
//
// Returns { runs: [{text, x0,y0,x1,y1}], tables: [{rows:[[cell]], bbox}] }
// in page-space points. Lines are kept individually (for tile attachment) and
// alignment-clustered blocks are reconstructed as tables (for Pass 5).
function extractPageText(mupdf, doc, pageIndex) {
  const page = doc.loadPage(pageIndex)
  const runs = []
  const tables = []
  try {
    const st = page.toStructuredText('preserve-whitespace')
    const json = JSON.parse(st.asJSON())
    for (const b of json.blocks || []) {
      const blockLines = []
      for (const ln of b.lines || []) {
        const text = (ln.text != null ? ln.text : (ln.spans || []).map(s => s.text).join('')) || ''
        const bb = ln.bbox
        if (!text.trim() || !bb) continue
        const run = { text: text.replace(/\s+$/, ''), x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h }
        runs.push(run)
        blockLines.push(run)
      }
      const table = detectTable(blockLines)
      if (table) tables.push(table)
    }
  } catch (e) {
    console.error(`text extract page ${pageIndex}:`, e.message)
  }
  page.destroy()
  return { runs, tables }
}

// Schedule/quantity tables read as alignment: a block of >=3 lines where most
// lines split (on runs of 2+ spaces) into the same number of >=2 columns.
function detectTable(lines) {
  if (lines.length < 3) return null
  const split = lines.map(l => l.text.split(/\s{2,}/).map(c => c.trim()).filter(Boolean))
  const counts = {}
  split.forEach(cells => { if (cells.length >= 2) counts[cells.length] = (counts[cells.length] || 0) + 1 })
  let modeCols = 0, modeN = 0
  for (const [c, n] of Object.entries(counts)) if (n > modeN) { modeN = n; modeCols = +c }
  if (modeCols < 2 || modeN < Math.max(3, Math.ceil(lines.length * 0.5))) return null
  const rows = split.filter(cells => cells.length === modeCols)
  const xs = lines.map(l => l.x0), ys = lines.map(l => l.y0)
  return { rows, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...lines.map(l => l.x1)), Math.max(...ys)] }
}

// Text-run rectangle vs tile bbox [x0,y0,x1,y1] — any overlap counts.
function runInTile(r, bbox) {
  return r.x0 < bbox[2] && r.x1 > bbox[0] && r.y0 < bbox[3] && r.y1 > bbox[1]
}

// Best-effort: turn a detected table into engineer quantity rows for Pass 5.
// Picks a numeric "quantity" column, an adjacent unit-ish column, and the
// longest text column as the description.
const UNIT_RE = /^(LF|EA|CY|SY|SF|LS|TON|GAL|HR|VF|AC)$/i
function tableToEngineerRows(table) {
  const out = []
  for (const cells of table.rows) {
    let qtyIdx = -1
    for (let i = 0; i < cells.length; i++) {
      const n = Number((cells[i] || '').replace(/[$,]/g, ''))
      if (isFinite(n) && /\d/.test(cells[i]) && n !== 0) { qtyIdx = i; break }
    }
    if (qtyIdx < 0) continue
    const qty = Number(cells[qtyIdx].replace(/[$,]/g, ''))
    let unit = ''
    for (const c of cells) if (UNIT_RE.test(c)) { unit = c.toUpperCase(); break }
    const desc = cells.filter((c, i) => i !== qtyIdx && !UNIT_RE.test(c)).sort((a, b) => b.length - a.length)[0] || ''
    if (desc && desc.length > 2) out.push({ item_no: null, description: desc.slice(0, 300), quantity: qty, unit })
  }
  return out
}

// ── Message Batches machinery ─────────────────────────────────────
// Tile passes run through the Batches API at 50% of standard token pricing.
// All four passes are independent, so every missing tile across all passes is
// submitted up front; we then poll, ingest results into analysis_tiles as each
// batch ends, and re-chain the function when the 12-min window closes. State
// (pending batch IDs, resubmit counts, usage) lives in processing_jobs.batch_state.
//
// tile_key / custom_id format: `${passKey}_${sheet_id}_${tileIdx}` — batches
// return results in arbitrary order keyed by custom_id (≤64 chars, [A-Za-z0-9_-]).

const BATCH_HEADERS = () => ({
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
  'Content-Type': 'application/json',
})

function buildTileContent(sheet, tile, embeddedText, task) {
  return [
    { type: 'text', text: tileContext(sheet, tile) },
    ...(embeddedText && embeddedText.length ? [{
      type: 'text',
      text: `EMBEDDED TEXT — extracted from the PDF's own text layer within this tile's bounds. Treat these as GROUND TRUTH for numbers, pipe diameters, materials, class/spec, station and elevation callouts (the PDF contains them exactly; do not re-read them from the pixels and do not contradict them). Use the IMAGE for geometry, symbols, line work, counts, and anything not present below:\n${embeddedText.map(t => `• ${t}`).join('\n')}`,
    }] : []),
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tile.base64 } },
    { type: 'text', text: task },
  ]
}

// Submits one chunk of tile requests as a Message Batch. Returns the batch ID.
async function submitBatch(requests) {
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: BATCH_HEADERS(),
    body: JSON.stringify({ requests }),
  })
  if (!res.ok) throw new Error(`batch submit ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.id
}

async function getBatch(batchId) {
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers: BATCH_HEADERS(),
  })
  if (!res.ok) throw new Error(`batch get ${res.status}`)
  return res.json()
}

// Streams an ended batch's JSONL results: validates each tile result and
// upserts it into analysis_tiles. Accumulates token usage onto `usage`.
async function ingestBatchResults(batch, passes, sheetsById, jobId, usage) {
  const res = await fetch(batch.results_url, { headers: BATCH_HEADERS() })
  if (!res.ok) throw new Error(`batch results ${res.status}`)
  const text = await res.text()

  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const [passKey, sheetId, idxStr] = entry.custom_id.split('_')
    const pass = passes.find(p => p.key === passKey)
    const sheet = sheetsById.get(sheetId)
    if (!pass || !sheet) continue
    const tile_key = entry.custom_id.slice(passKey.length + 1) // `${sheet_id}_${idx}`

    let valid = []
    if (entry.result?.type === 'succeeded') {
      const msg = entry.result.message
      const u = msg.usage || {}
      const tier = tierOf(pass.model)
      usage[tier] = usage[tier] || { in: 0, out: 0 }
      usage[tier].in += u.input_tokens || 0
      usage[tier].out += u.output_tokens || 0

      const textOut = (msg.content || []).map(b => (b.type === 'text' ? b.text : '')).join('')
      const parsed = parseJson(textOut)
      const raw = Array.isArray(parsed) ? parsed : (pass.resultKey ? parsed?.[pass.resultKey] : parsed)
      valid = pass.validator(raw, pass.name).map(v => ({
        ...v,
        sheet_id: sheet.id,
        sheet_label: sheet.sheet_number || `pg ${sheet.page_number}`,
        tile: `tile ${Number(idxStr) + 1}`,
      }))
    } else {
      // errored / expired / canceled → leave as empty unless a resubmit picks it up
      console.error(`batch result ${entry.custom_id}: ${entry.result?.type}`)
      continue // do NOT write a row — the missing-tile scan will resubmit it
    }
    rows.push({ job_id: jobId, pass: passKey, tile_key, result_json: valid })
  }

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('analysis_tiles')
      .upsert(rows.slice(i, i + 100), { onConflict: 'job_id,pass,tile_key' })
    if (error) throw new Error(`tile upsert failed: ${error.message}`)
  }
  return rows.length
}

// Reads back every persisted tile result for a pass, flattened.
async function loadPassResults(jobId, passKey) {
  const { data } = await supabase
    .from('analysis_tiles').select('result_json').eq('job_id', jobId).eq('pass', passKey)
  return (data || []).flatMap(r => Array.isArray(r.result_json) ? r.result_json : [])
}

// Re-invokes this background function to continue a paused job (fire-and-forget;
// background functions ack 202 immediately).
async function reinvokeSelf(jobId, projectId) {
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL
  if (!site) { console.error('reinvokeSelf: no site URL env'); return }
  try {
    await fetch(`${site}/.netlify/functions/analyze-project-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, project_id: projectId }),
    })
  } catch (e) {
    console.error('reinvokeSelf failed:', e.message)
  }
}

// ── Pass 3 code-side: profile run dedupe, depth math, reconciliation ──
function normKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }

function dedupeRuns(runs) {
  const byKey = new Map()
  for (const r of runs) {
    const key = normKey(r.from_structure && r.to_structure ? `${r.from_structure}>${r.to_structure}` : r.run_id)
    const prev = byKey.get(key)
    if (!prev) { byKey.set(key, r); continue }
    // keep the record with more populated fields
    const score = x => [x.length_lf, x.slope_pct, x.diameter_in, x.material].filter(v => v != null).length + x.structures.length
    if (score(r) > score(prev)) byKey.set(key, { ...r, note: prev.note || r.note })
  }
  return [...byKey.values()]
}

function structureDepth(s) {
  if (s.depth_ft != null) return s.depth_ft
  if (s.rim_elev != null && s.invert_elev != null) return s.rim_elev - s.invert_elev
  return null
}

function depthStats(run) {
  const depths = run.structures.map(structureDepth).filter(d => d != null && d >= 0 && d < 100)
  if (depths.length === 0) return null
  const avg = depths.reduce((a, b) => a + b, 0) / depths.length
  const max = Math.max(...depths)

  // Distribute the run's length across depth samples by linear interpolation
  // between consecutive structures. Enables LF-by-depth math (buckets, trench
  // safety LF, rock-excavation LF) for any threshold. A single-structure run
  // is treated as uniform depth over its full length.
  let samples = null
  if (run.length_lf) {
    samples = []
    if (depths.length === 1) {
      samples.push({ depth: depths[0], lf: run.length_lf })
    } else {
      const segLen = run.length_lf / (depths.length - 1)
      for (let i = 0; i < depths.length - 1; i++) {
        const d0 = depths[i], d1 = depths[i + 1]
        for (let s = 0; s < 10; s++) {
          samples.push({ depth: d0 + (d1 - d0) * (s + 0.5) / 10, lf: segLen / 10 })
        }
      }
    }
  }

  let buckets = null, lfOver5 = null
  if (samples) {
    buckets = Object.fromEntries(DEPTH_BUCKETS.map(([k]) => [k, 0]))
    lfOver5 = 0
    for (const { depth, lf } of samples) {
      const b = DEPTH_BUCKETS.find(([, lo, hi]) => depth >= lo && depth < hi)
      if (b) buckets[b[0]] += lf
      if (depth > TRENCH_SAFETY_FT) lfOver5 += lf
    }
    for (const k of Object.keys(buckets)) buckets[k] = Math.round(buckets[k])
    lfOver5 = Math.round(lfOver5)
  }
  return { avg: Math.round(avg * 10) / 10, max: Math.round(max * 10) / 10, buckets, lf_over_5: lfOver5, samples }
}

// LF of a run deeper than a threshold (e.g. rock line), from the depth samples.
function lfOverThreshold(stats, threshold) {
  if (!stats?.samples) return null
  let lf = 0
  for (const { depth, lf: segLf } of stats.samples) if (depth > threshold) lf += segLf
  return Math.round(lf)
}

// ── Depth engine: derived flags + biddable items from profile depths ──
// Consumes runs (each carrying ._stats from depthStats and ._itemIdx = the
// matched merged line item, if any). Mutates merged to flag deep/unavailable
// runs; returns derived line items + a depth_summary for the report UI.
function buildDepthEngine(runs, merged, geotech) {
  const rockDepth = geotech?.rock_depth_ft ?? null
  const gwDepth = geotech?.groundwater_depth_ft ?? null

  let trenchSafetyLf = 0
  const runSummaries = [], deepRuns = [], rockHits = [], groundwaterRuns = [], unavailableRuns = []

  for (const run of runs) {
    const st = run._stats
    if (!st) {
      // Gravity run with no usable elevation data — never guess.
      unavailableRuns.push({ run_id: run.run_id, utility: run.utility })
      if (run._itemIdx != null && merged[run._itemIdx]) {
        const it = merged[run._itemIdx]
        it.note = `DEPTH UNAVAILABLE — verify from profiles. ${it.note || ''}`.trim().slice(0, 1000)
      }
      continue
    }

    trenchSafetyLf += st.lf_over_5 || 0
    runSummaries.push({
      run_id: run.run_id, utility: run.utility, length_lf: run.length_lf ?? null,
      depth_avg: st.avg, depth_max: st.max, buckets: st.buckets, lf_over_5: st.lf_over_5 ?? null,
    })

    if (st.max > DEEP_EXCAVATION_FT) {
      deepRuns.push({ run_id: run.run_id, utility: run.utility, depth_max: st.max, length_lf: run.length_lf ?? null })
      if (run._itemIdx != null && merged[run._itemIdx]) {
        const it = merged[run._itemIdx]
        it.status = 'flagged'
        it.note = `DEEP EXCAVATION (HIGH RISK): ${st.max} ft max depth (>${DEEP_EXCAVATION_FT} ft) — shoring/benching and confined-space considerations. ${it.note || ''}`.trim().slice(0, 1000)
      }
    }

    if (rockDepth != null && st.max >= rockDepth) {
      const rockLf = lfOverThreshold(st, rockDepth)
      if (rockLf > 0) rockHits.push({ run_id: run.run_id, utility: run.utility, depth_max: st.max, rock_lf: rockLf })
    }
    if (gwDepth != null && st.max >= gwDepth) {
      groundwaterRuns.push({ run_id: run.run_id, utility: run.utility, depth_max: st.max })
    }
  }

  // Crossings: structures shared by runs of two or more different utilities.
  const structMap = new Map()
  for (const run of runs) {
    if (!run._stats) continue
    for (const s of run.structures) {
      const d = structureDepth(s)
      const key = normKey(s.id)
      if (d == null || !key) continue
      if (!structMap.has(key)) structMap.set(key, [])
      structMap.get(key).push({ utility: run.utility, depth: Math.round(d * 10) / 10, run_id: run.run_id, struct: s.id })
    }
  }
  const crossings = []
  for (const arr of structMap.values()) {
    if (new Set(arr.map(a => a.utility)).size >= 2) {
      const controlling = arr.reduce((a, b) => (b.depth > a.depth ? b : a))
      crossings.push({ structure: arr[0].struct, utilities: [...new Set(arr.map(a => a.utility))], controlling_depth: controlling.depth, legs: arr })
    }
  }

  // Derived biddable line items
  const derivedItems = []
  if (trenchSafetyLf > 0) {
    derivedItems.push({
      category: 'EXCAVATION',
      description: `Trench safety / OSHA protective system (depth > ${TRENCH_SAFETY_FT} ft)`,
      quantity: Math.round(trenchSafetyLf), unit: 'LF', diameter_in: null, material: null,
      location: 'Project-wide (from profiles)', confidence: 'MEDIUM',
      note: `Total trenching deeper than ${TRENCH_SAFETY_FT} ft — OSHA 1926 Subpart P requires shoring, sloping, or a trench shield. Summed from profile-derived depths across all gravity runs; verify against final profiles.`,
      status: 'active', sheet_id: null, isDerived: true,
    })
  }
  let rockTotal = 0
  for (const r of rockHits) {
    rockTotal += r.rock_lf
    derivedItems.push({
      category: 'EXCAVATION',
      description: `Rock excavation (est.) — ${r.run_id}`,
      quantity: r.rock_lf, unit: 'LF', diameter_in: null, material: null,
      location: r.run_id, confidence: 'LOW',
      note: `${r.run_id}: ${r.depth_max} ft max depth vs rock at ${rockDepth} ft — est. ${r.rock_lf} LF below the rock line. Rough estimate from profile interpolation; confirm against geotech borings and rock-excavation unit pricing.`,
      status: 'flagged', sheet_id: null, isDerived: true,
    })
  }

  const depthSummary = {
    bucket_order: DEPTH_BUCKETS.map(b => b[0]),
    runs: runSummaries,
    trench_safety_lf: Math.round(trenchSafetyLf),
    deep_runs: deepRuns,
    crossings,
    unavailable_runs: unavailableRuns,
    geotech: (rockDepth != null || gwDepth != null) ? {
      rock_depth_ft: rockDepth,
      groundwater_depth_ft: gwDepth,
      rock_excavation_total_lf: Math.round(rockTotal),
      groundwater_runs: groundwaterRuns,
    } : null,
  }
  return { depthSummary, derivedItems }
}

// Match a profile run to a merged plan item (same diameter + utility/material token overlap)
function matchRunToItem(run, items, used) {
  let best = null, bestScore = 0
  for (let i = 0; i < items.length; i++) {
    if (used.has(i) || items[i].category !== 'PIPE') continue
    const it = items[i]
    if (run.diameter_in != null && it.diameter_in != null && run.diameter_in !== it.diameter_in) continue
    let score = run.diameter_in != null && it.diameter_in === run.diameter_in ? 2 : 0
    const desc = it.description.toLowerCase()
    if (run.utility !== 'other' && desc.includes(run.utility.slice(0, 5))) score += 2
    if (run.material && desc.includes(run.material.toLowerCase())) score += 1
    const loc = (it.location || '').toLowerCase()
    if (run.from_structure && loc.includes(run.from_structure.toLowerCase())) score += 3
    if (run.to_structure && loc.includes(run.to_structure.toLowerCase())) score += 3
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore >= 2 ? best : null
}

// ── Pass 5 code-side: variance matching ────────────────────────
// Engineer tables and takeoffs abbreviate differently ("8-INCH SANITARY SEWER"
// vs '8" SAN SWR'). Normalize to canonical short tokens and drop filler words
// so description matching connects across notation styles.
const TOKEN_STOP = new Set(['prop', 'proposed', 'ex', 'existing', 'new', 'the', 'of', 'and', 'with', 'for', 'per'])
const TOKEN_SYN = {
  inch: 'in', inches: 'in', dia: 'in', diameter: 'in',
  sanitary: 'san', ss: 'san',
  sewer: 'swr', sswr: 'swr',
  storm: 'stm',
  water: 'wtr', waterline: 'wtr', wl: 'wtr',
  manhole: 'mh', manholes: 'mh', ssmh: 'mh', stmh: 'mh', sanmh: 'mh',
  hydrant: 'hyd', hydrants: 'hyd',
  cleanout: 'co', cleanouts: 'co',
  linear: 'lf', ft: 'lf', feet: 'lf', foot: 'lf',
}
function tokenize(s) {
  const raw = (s || '').toLowerCase().replace(/["']/g, ' in ').split(/[^a-z0-9.]+/)
  const out = new Set()
  for (let t of raw) {
    if (t.length < 2 && !/^\d$/.test(t)) continue
    t = TOKEN_SYN[t] || t
    if (TOKEN_STOP.has(t)) continue
    out.add(t)
  }
  return out
}

function buildVariance(engineerRows, items) {
  // consolidate engineer rows seen in multiple tiles (same desc+unit → keep once)
  const seen = new Map()
  for (const row of engineerRows) {
    const key = normKey(row.description) + '|' + row.unit
    if (!seen.has(key)) seen.set(key, row)
  }
  const usedItems = new Set()
  const variance = []
  for (const eng of seen.values()) {
    const engTokens = tokenize(eng.description)
    let best = null, bestScore = 0
    items.forEach((it, i) => {
      if (usedItems.has(i)) return
      if (eng.unit && it.unit && eng.unit !== it.unit) return
      const itTokens = tokenize(it.description)
      let overlap = 0
      engTokens.forEach(t => { if (itTokens.has(t)) overlap++ })
      const score = overlap / Math.max(engTokens.size, 1)
      if (score > bestScore) { bestScore = score; best = i }
    })
    if (best != null && bestScore >= 0.4) {
      usedItems.add(best)
      const ours = items[best]
      const pct = eng.quantity ? Math.round(((ours.quantity ?? 0) - eng.quantity) / eng.quantity * 1000) / 10 : null
      variance.push({
        engineer_description: eng.description, engineer_quantity: eng.quantity, unit: eng.unit,
        our_description: ours.description, our_quantity: ours.quantity,
        pct_difference: pct,
        status: pct != null && Math.abs(pct) > 5 ? 'VARIANCE' : 'MATCHED',
      })
    } else {
      variance.push({
        engineer_description: eng.description, engineer_quantity: eng.quantity, unit: eng.unit,
        our_description: null, our_quantity: null, pct_difference: null,
        status: 'MISSING_FROM_OURS',
      })
    }
  }
  return variance
}

// ── Calibration scoring ──────────────────────────────────────────
// Two accuracy signals per run: agreement with the engineer's printed quantity
// table (automatic, from Pass 5), and agreement with an uploaded ground-truth
// takeoff (projects.calibration_truth). Same fuzzy matcher as buildVariance.
function varianceMetrics(variance) {
  if (!variance?.length) return null
  const matched = variance.filter(v => v.pct_difference != null)
  return {
    rows: variance.length,
    matched: matched.length,
    within_5: matched.filter(v => Math.abs(v.pct_difference) <= 5).length,
    within_15: matched.filter(v => Math.abs(v.pct_difference) <= 15).length,
    mean_abs_pct: matched.length
      ? Math.round(matched.reduce((s, v) => s + Math.abs(v.pct_difference), 0) / matched.length * 10) / 10
      : null,
    missing_from_ours: variance.filter(v => v.status === 'MISSING_FROM_OURS').length,
  }
}

function scoreAgainstTruth(gtRows, items) {
  const usedItems = new Set()
  let matched = 0, w5 = 0, w15 = 0, pctSum = 0, pctN = 0, missing = 0
  for (const gt of gtRows) {
    const gtQty = Number(gt.quantity)
    if (!gt.description || !isFinite(gtQty)) continue
    const gtTokens = tokenize(gt.description)
    let best = null, bestScore = 0
    items.forEach((it, i) => {
      if (usedItems.has(i)) return
      if (gt.unit && it.unit && String(gt.unit).toUpperCase() !== it.unit) return
      const itTokens = tokenize(it.description)
      let overlap = 0
      gtTokens.forEach(t => { if (itTokens.has(t)) overlap++ })
      const score = overlap / Math.max(gtTokens.size, 1)
      if (score > bestScore) { bestScore = score; best = i }
    })
    if (best != null && bestScore >= 0.4) {
      usedItems.add(best)
      matched++
      if (gtQty) {
        const pct = Math.abs((items[best].quantity ?? 0) - gtQty) / gtQty * 100
        pctSum += pct; pctN++
        if (pct <= 5) w5++
        if (pct <= 15) w15++
      }
    } else {
      missing++
    }
  }
  const total = matched + missing
  if (!total) return null
  return {
    truth_rows: total,
    matched,
    within_5: w5,
    within_15: w15,
    mean_abs_pct: pctN ? Math.round(pctSum / pctN * 10) / 10 : null,
    missing_from_ours: missing,
  }
}

// ── Material matching ────────────────────────────────────────────
// Maps each line item to a material slug: alias/regex first (cheap, exact),
// then one Haiku call for whatever's left ambiguous.
function buildMaterialTerms(materials) {
  const terms = []
  for (const m of materials) {
    const aliases = Array.isArray(m.aliases_json) ? m.aliases_json : []
    const all = new Set([...aliases, m.name].map(s => String(s).toLowerCase().trim()).filter(s => s.length >= 3))
    for (const term of all) terms.push({ term, slug: m.slug, len: term.length })
  }
  terms.sort((a, b) => b.len - a.len) // longest (most specific) wins
  return terms
}

function regexMatchSlug(desc, terms) {
  const d = (desc || '').toLowerCase()
  // Prefer the material term that appears EARLIEST in the description (the head
  // noun is the real material — "concrete collar at sanitary manhole" is a
  // collar, not a manhole); break ties by longer (more specific) term.
  let best = null, bestPos = Infinity, bestLen = 0
  for (const { term, slug } of terms) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = d.match(new RegExp(`(^|[^a-z0-9])(${esc})([^a-z0-9]|$)`, 'i'))
    if (!m) continue
    const pos = m.index
    if (pos < bestPos || (pos === bestPos && term.length > bestLen)) {
      best = slug; bestPos = pos; bestLen = term.length
    }
  }
  return best
}

async function matchMaterials(items, materials) {
  if (!materials.length) return items.map(() => null)
  const terms = buildMaterialTerms(materials)
  const slugs = items.map(it => regexMatchSlug(it.description, terms))

  // Haiku pass for the leftovers — one batched call.
  const unresolved = []
  slugs.forEach((s, i) => { if (!s) unresolved.push(i) })
  if (unresolved.length) {
    const catalog = materials.map(m => `${m.slug}: ${m.name}`).join('\n')
    const batch = unresolved.map(i => ({ i, description: items[i].description, category: items[i].category })).slice(0, 200)
    try {
      const text = await callClaude({
        model: HAIKU, maxTokens: 4096,
        content: [{ type: 'text', text: `You map construction takeoff line items to a material catalog. For each item, return the single best material slug, or null if no catalog material fits (labor/excavation/testing items usually have no material).

CATALOG (slug: name):
${catalog}

ITEMS:
${JSON.stringify(batch)}

Respond ONLY with JSON: {"matches":[{"i":<index>,"slug":"<slug-or-null>"}]}` }],
      })
      const parsed = parseJson(text)
      const valid = new Set(materials.map(m => m.slug))
      for (const m of parsed?.matches || []) {
        if (typeof m.i === 'number' && valid.has(m.slug)) slugs[m.i] = m.slug
      }
    } catch (err) {
      console.error('material Haiku match failed:', err.message)
    }
  }
  return slugs
}

// ── Handler ────────────────────────────────────────────────────
// Scoring primitives exported for offline rescoring / diagnostics.
export { buildVariance, varianceMetrics, scoreAgainstTruth, tokenize }

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }

  let body
  try { body = JSON.parse(event.body) } catch { return { statusCode: 400, body: 'Invalid JSON' } }
  const { job_id, project_id } = body
  if (!job_id || !project_id) return { statusCode: 400, body: 'Missing fields' }

  // Heartbeat via raw REST — proves the handler actually started. If the job
  // never leaves this state, the crash is at module load / cold start.
  // Clears stale errors; deliberately does NOT touch stage/progress so chained
  // invocations don't flicker the progress bar back to zero.
  await rawJobUpdate(job_id, { error: null, stage_detail: 'Analysis worker started' })

  try {
    getSupabase() // populates module-level `supabase` for all code below
    loadBrain() // fail fast and loudly if the prompt file didn't ship

    // ── Load analysis set ────────────────────────────────────
    const { data: sheets, error: shErr } = await supabase
      .from('sheets')
      .select('id, page_number, classification, storage_path, sheet_number, sheet_title')
      .eq('project_id', project_id)
      .eq('included_in_analysis', true)
      .order('page_number')
    if (shErr || !sheets?.length) throw new Error(`No analysis sheets: ${shErr?.message || 'empty set'}`)

    // Original PDF path derives from any page PNG path: {uid}/{pid}/pages/page_N.png
    const pdfPath = sheets[0].storage_path.replace(/\/pages\/page_\d+\.png$/, '/original.pdf')
    const { data: pdfBlob, error: dlErr } = await supabase.storage.from('plan-uploads').download(pdfPath)
    if (dlErr) throw new Error(`PDF download failed: ${dlErr.message}`)
    const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer())

    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')

    const p1Sheets = sheets.filter(s => PASS1_TYPES.has(s.classification))
    const p2Sheets = sheets.filter(s => s.classification === 'plan_profile')

    const chainDeadline = Date.now() + CHAIN_AFTER_MS
    const brain = loadBrain()

    // ── Embedded text layer ──────────────────────────────────
    // Extract each analyzed page's text layer once per invocation, keyed by page
    // index (safe: a single invocation only touches one project). getPageText is
    // handed to the tile passes so each tile can attach the text within its bounds.
    const textByPage = new Map()
    const getPageText = (pageIndex) => {
      if (!textByPage.has(pageIndex)) textByPage.set(pageIndex, extractPageText(mupdf, doc, pageIndex))
      return textByPage.get(pageIndex)
    }
    // Raster-only detection: if the analyzed sheets carry essentially no text
    // layer, the set is scanned/vector-flattened and quantities must come from
    // vision. Surface that so confidence is read accordingly.
    let totalRuns = 0, sheetsWithText = 0
    for (const s of sheets) {
      const n = getPageText(s.page_number - 1).runs.length
      totalRuns += n
      if (n >= 5) sheetsWithText++
    }
    const textMode = sheetsWithText >= Math.max(1, Math.ceil(sheets.length * 0.25)) ? 'hybrid' : 'raster-only'
    await updateJob(job_id, { stage_detail: `Text layer: ${textMode} (${totalRuns} runs across ${sheetsWithText}/${sheets.length} sheets)` })

    // ── Tile-extraction passes (1, 2, 4, 5) via Message Batches ──
    // All four passes are independent, so every missing tile is submitted up
    // front (50% batch pricing), then we poll/ingest until complete, re-chaining
    // the function whenever the 12-min window closes. Pass 3 (merge/reconcile)
    // is code+Haiku assembly that runs only once all tile passes are complete.
    // Job config: calibration runs override the model tier per pass.
    const { data: jobRow } = await supabase
      .from('processing_jobs').select('batch_state, config').eq('id', job_id).single()
    const cfg = jobRow?.config || {}
    const tiers = { pass1: 'opus', pass2: 'opus', pass4: 'opus', pass5: 'haiku', ...(cfg.models || {}) }
    const M = (k) => MODEL_TIERS[tiers[k]] || OPUS

    const TILE_PASSES = [
      { key: 'pass1', name: 'Pass 1/5 plan quantities', stage: 'analysis_pass_1', sheets: p1Sheets, task: PASS1_TASK, system: brain, model: M('pass1'), validator: validateItems, resultKey: 'items', maxTokens: 8192 },
      { key: 'pass2', name: 'Pass 2/5 profiles', stage: 'analysis_pass_2', sheets: p2Sheets, task: PASS2_TASK, system: brain, model: M('pass2'), validator: validateRuns, resultKey: 'runs', maxTokens: 8192 },
      { key: 'pass4', name: 'Pass 4/5 small-dia sweep', stage: 'analysis_pass_4', sheets: p1Sheets, task: PASS4_TASK, system: brain, model: M('pass4'), validator: validateItems, resultKey: 'items', maxTokens: 8192 },
      { key: 'pass5', name: 'Pass 5/5 engineer tables', stage: 'analysis_pass_5', sheets, task: PASS5_TASK, system: null, model: M('pass5'), validator: validateEngineerTile, resultKey: null, maxTokens: 4096 },
    ]
    const sheetsById = new Map(sheets.map(s => [s.id, s]))

    // Batch state persists across chained invocations.
    const state = jobRow?.batch_state || {}
    state.batches = state.batches || {}
    state.resubmits = state.resubmits || {}
    state.usage = state.usage || {}
    for (const tier of ['opus', 'sonnet', 'haiku']) state.usage[tier] = state.usage[tier] || { in: 0, out: 0 }
    state.chains = (state.chains || 0) + 1
    if (state.chains > MAX_CHAINS) throw new Error('Batch processing exceeded the maximum invocation chain — contact support.')
    const persistState = () => updateJob(job_id, { batch_state: state })
    await persistState()

    // Page geometry (grid dims) without rendering — cheap, needed for totals.
    const geomCache = new Map()
    const pageGeom = (pageIndex) => {
      if (!geomCache.has(pageIndex)) {
        const page = doc.loadPage(pageIndex)
        const [x0, y0, x1, y1] = page.getBounds()
        page.destroy()
        geomCache.set(pageIndex, gridFor(x1 - x0, y1 - y0))
      }
      return geomCache.get(pageIndex)
    }

    // Rendered tiles, lazily, once per sheet — shared by all passes.
    const tileCache = new Map()
    const sheetTiles = (sheet) => {
      const pageIndex = sheet.page_number - 1
      if (!tileCache.has(pageIndex)) tileCache.set(pageIndex, renderTiles(mupdf, doc, pageIndex))
      return tileCache.get(pageIndex)
    }

    // Done tile keys per pass (from prior invocations / ingested batches).
    const loadDone = async () => {
      const done = Object.fromEntries(TILE_PASSES.map(p => [p.key, new Set()]))
      const { data } = await supabase
        .from('analysis_tiles').select('pass, tile_key').eq('job_id', job_id)
      ;(data || []).forEach(r => done[r.pass]?.add(r.tile_key))
      return done
    }

    // Missing work per pass: [{pass, sheet, idx}] — identity only, no rendering.
    const computeMissing = (done) => {
      const missing = {}
      let totalTiles = 0, doneTiles = 0
      for (const pass of TILE_PASSES) {
        missing[pass.key] = []
        for (const sheet of pass.sheets) {
          const { cols, rows } = pageGeom(sheet.page_number - 1)
          for (let idx = 0; idx < cols * rows; idx++) {
            totalTiles++
            const tile_key = `${sheet.id}_${idx}`
            if (done[pass.key].has(tile_key)) doneTiles++
            else missing[pass.key].push({ pass, sheet, idx })
          }
        }
      }
      return { missing, totalTiles, doneTiles }
    }

    let blankSkipped = 0
    let done = await loadDone()

    // ── Poll / submit loop ────────────────────────────────────
    while (true) {
      // 1. Poll pending batches; ingest any that ended.
      let processing = 0
      for (const passKey of Object.keys(state.batches)) {
        const stillPending = []
        for (const batchId of state.batches[passKey]) {
          let batch
          try { batch = await getBatch(batchId) } catch (e) {
            console.error(`poll ${batchId}:`, e.message); stillPending.push(batchId); continue
          }
          if (batch.processing_status === 'ended') {
            await ingestBatchResults(batch, TILE_PASSES, sheetsById, job_id, state.usage)
          } else {
            processing += batch.request_counts?.processing ?? 0
            stillPending.push(batchId)
          }
        }
        state.batches[passKey] = stillPending
        if (!stillPending.length) delete state.batches[passKey]
      }

      done = await loadDone()
      const { missing, totalTiles, doneTiles } = computeMissing(done)
      const allDone = TILE_PASSES.every(p => missing[p.key].length === 0)
      if (allDone) { await persistState(); break }

      // 2. Submit batches for passes with missing tiles and no pending batch.
      for (const pass of TILE_PASSES) {
        if (missing[pass.key].length === 0 || state.batches[pass.key]?.length) continue
        const resubmits = state.resubmits[pass.key] || 0
        if (resubmits > MAX_RESUBMITS) {
          // Give up on the stragglers: record empty results so assembly proceeds.
          const rows = missing[pass.key].map(w => ({
            job_id, pass: pass.key, tile_key: `${w.sheet.id}_${w.idx}`, result_json: [],
          }))
          for (let i = 0; i < rows.length; i += 100) {
            await supabase.from('analysis_tiles').upsert(rows.slice(i, i + 100), { onConflict: 'job_id,pass,tile_key' })
          }
          continue
        }

        const requests = []
        for (const w of missing[pass.key]) {
          const tiles = sheetTiles(w.sheet)
          const tile = tiles[w.idx]
          if (!tile) continue
          const tile_key = `${w.sheet.id}_${w.idx}`
          // Blank-tile skip: an essentially-empty tile compresses to almost
          // nothing — record an empty result instead of paying for an API call.
          if (tile.pngBytes < BLANK_PNG_BYTES) {
            await supabase.from('analysis_tiles')
              .upsert({ job_id, pass: pass.key, tile_key, result_json: [] }, { onConflict: 'job_id,pass,tile_key' })
            blankSkipped++
            continue
          }
          const embeddedText = getPageText(w.sheet.page_number - 1).runs
            .filter(r => runInTile(r, tile.pageBBox)).map(r => r.text)
          requests.push({
            custom_id: `${pass.key}_${tile_key}`,
            params: {
              model: pass.model,
              max_tokens: pass.maxTokens,
              ...(pass.system ? { system: pass.system } : {}),
              messages: [{ role: 'user', content: buildTileContent(w.sheet, tile, embeddedText, pass.task) }],
            },
          })
        }
        if (!requests.length) continue

        state.batches[pass.key] = state.batches[pass.key] || []
        for (let i = 0; i < requests.length; i += BATCH_CHUNK) {
          const id = await submitBatch(requests.slice(i, i + BATCH_CHUNK))
          state.batches[pass.key].push(id)
        }
        state.resubmits[pass.key] = resubmits + 1
        await persistState()
      }
      // Rendered tiles are only needed while building requests — free the memory.
      tileCache.clear()

      // 3. Progress + stage: earliest incomplete pass drives the stage label.
      const currentPass = TILE_PASSES.find(p => missing[p.key].length > 0)
      const progress = 2 + Math.round((doneTiles / Math.max(totalTiles, 1)) * 86)
      await updateJob(job_id, {
        stage: currentPass?.stage || 'analysis_pass_5',
        progress,
        stage_detail: `Batched analysis — ${doneTiles}/${totalTiles} tiles done${processing ? `, ${processing} in flight` : ''}${blankSkipped ? `, ${blankSkipped} blank skipped` : ''}`,
        batch_state: state,
      })

      // 4. Chain or sleep.
      if (Date.now() > chainDeadline) {
        await persistState()
        await reinvokeSelf(job_id, project_id)
        return { statusCode: 200 }
      }
      await sleep(BATCH_POLL_MS)
    }

    // All tiles done — assemble from persisted scratch.
    const p1Items = await loadPassResults(job_id, 'pass1')
    const p2Raw = await loadPassResults(job_id, 'pass2')
    const p4Items = await loadPassResults(job_id, 'pass4')
    const visionEngineerRows = await loadPassResults(job_id, 'pass5')
    const runs = dedupeRuns(p2Raw)

    // Pass 5 structured-data path: schedule/quantity tables reconstructed from the
    // text layer feed the variance check directly (more reliable than vision).
    // Merge with the vision reads, de-duping by description.
    const textTables = sheets.flatMap(s => getPageText(s.page_number - 1).tables)
    const tableEngineerRows = textTables.flatMap(tableToEngineerRows)
    const engineerSeen = new Set()
    const engineerRows = [...tableEngineerRows, ...visionEngineerRows].filter(r => {
      const k = normKey(r.description) + '|' + (r.unit || '')
      if (engineerSeen.has(k)) return false
      engineerSeen.add(k); return true
    })

    // ── PASS 3: merge + dedupe (Haiku) + code reconciliation ─
    await updateJob(job_id, { stage: 'analysis_pass_3', progress: 90, stage_detail: 'Pass 3/5 — merging tiles, reconciling plan vs profile' })
    let merged = []
    if (p1Items.length > 0) {
      const numbered = p1Items.map((it, i) => ({ id: i, sheet: it.sheet_label, tile: it.tile, ...it, sheet_id: undefined }))
      const text = await callClaude({
        model: HAIKU, maxTokens: 16384,
        content: [{ type: 'text', text: `${MERGE_TASK}\n\nITEMS:\n${JSON.stringify(numbered)}` }],
      })
      merged = validateItems(parseJson(text)?.items, 'Pass 3/5 merge')
      if (merged.length === 0 && p1Items.length > 0) {
        console.warn('Merge returned nothing — falling back to unmerged items')
        merged = p1Items.map(it => ({ ...it, source_ids: [] }))
      }
      // Re-attach sheet_id from merged source_ids (first source wins)
      merged.forEach(m => {
        const src = m.source_ids.length ? p1Items[m.source_ids[0]] : null
        m.sheet_id = src?.sheet_id || p1Items[0]?.sheet_id || null
      })
    }

    // Reconcile plan lengths vs profile lengths. Mismatch >5% becomes a flagged
    // item with both values shown — never silently averaged.
    // Depth stats per run, computed once and reused by the depth engine below.
    runs.forEach(r => { r._stats = depthStats(r); r._itemIdx = null })

    const usedItemIdx = new Set()
    const reconciliations = []
    for (const run of runs) {
      const idx = matchRunToItem(run, merged, usedItemIdx)
      const stats = run._stats
      if (idx == null) {
        // Profile run with no plan-view match → add it as its own line item
        if (run.length_lf) {
          merged.push({
            category: 'PIPE',
            description: `${run.diameter_in ? `${run.diameter_in}" ` : ''}${run.material || ''} ${run.utility !== 'other' ? run.utility : ''} (${run.run_id})`.replace(/\s+/g, ' ').trim(),
            quantity: run.length_lf, unit: 'LF', diameter_in: run.diameter_in, material: run.material,
            location: run.run_id, confidence: run.confidence,
            note: `From profile only — not matched to a plan-view item. ${run.note}`.trim(),
            sheet_id: p2Sheets[0]?.id || null, source_ids: [],
            depth: stats, status: 'active',
          })
          run._itemIdx = merged.length - 1
        }
        continue
      }
      usedItemIdx.add(idx)
      run._itemIdx = idx
      const item = merged[idx]
      if (stats) item.depth = stats
      if (run.length_lf != null && item.quantity != null) {
        const planLf = item.quantity
        const pct = Math.abs(planLf - run.length_lf) / run.length_lf * 100
        if (pct > 5) {
          item.status = 'flagged'
          item.confidence = 'LOW'
          item.quantity = run.length_lf // profile is engineer-dimensioned → primary
          item.note = `LENGTH MISMATCH: plan view shows ${Math.round(planLf)} LF, profile shows ${run.length_lf} LF (${Math.round(pct)}% apart). Profile value used — verify before pricing. ${item.note}`.slice(0, 1000)
          reconciliations.push({ run: run.run_id, plan_lf: planLf, profile_lf: run.length_lf, pct_diff: Math.round(pct) })
        }
      } else if (run.length_lf != null && item.quantity == null) {
        item.quantity = run.length_lf
        item.note = `Length taken from profile (${run.run_id}). ${item.note}`.slice(0, 1000)
      }
    }

    // ── PASS 4 dedupe: fold small-diameter sweep into merged set (Haiku) ──
    // p4Items came from the resumable pass4 tiles loaded above.
    await updateJob(job_id, { progress: 92, stage_detail: 'Folding in small-diameter findings' })
    if (p4Items.length > 0) {
      const existingBrief = merged.map(m => ({ description: m.description, quantity: m.quantity, unit: m.unit, location: m.location }))
      const candidates = p4Items.map((it, i) => ({ id: i, sheet: it.sheet_label, tile: it.tile, ...it, sheet_id: undefined }))
      const text = await callClaude({
        model: HAIKU, maxTokens: 8192,
        content: [{ type: 'text', text: `${PASS4_DEDUPE_TASK}\n\nEXISTING:\n${JSON.stringify(existingBrief)}\n\nCANDIDATES:\n${JSON.stringify(candidates)}` }],
      })
      const fresh = validateItems(parseJson(text)?.new_items, 'Pass 4/5 dedupe')
      fresh.forEach(f => merged.push({
        ...f,
        note: `Found in dedicated small-diameter sweep. ${f.note}`.slice(0, 1000),
        sheet_id: p4Items[0]?.sheet_id || null, status: 'active',
      }))
    }

    // ── PASS 5 variance: engineerRows came from resumable pass5 tiles above ──
    const variance = engineerRows.length > 0 ? buildVariance(engineerRows, merged) : []

    // ── DEPTH ENGINE: trench safety, deep excavation, crossings, geotech ──
    await updateJob(job_id, { progress: 94, stage_detail: 'Computing depth engine (trench safety, geotech)' })
    const { data: projGeo } = await supabase
      .from('projects')
      .select('geotech_rock_depth_ft, geotech_groundwater_depth_ft, calibration_truth')
      .eq('id', project_id).single()
    const geotech = (projGeo && (projGeo.geotech_rock_depth_ft != null || projGeo.geotech_groundwater_depth_ft != null))
      ? { rock_depth_ft: projGeo.geotech_rock_depth_ft, groundwater_depth_ft: projGeo.geotech_groundwater_depth_ft }
      : null
    const { depthSummary, derivedItems } = buildDepthEngine(runs, merged, geotech)
    derivedItems.forEach(d => merged.push(d))

    // ── Material matching: every line item → a catalog material slug ──
    await updateJob(job_id, { progress: 95, stage_detail: 'Matching materials' })
    const { data: materials } = await supabase.from('materials').select('slug, name, aliases_json')
    const matchedSlugs = await matchMaterials(merged, materials || [])
    merged.forEach((m, i) => { m.material_slug = matchedSlugs[i] || null })

    // ── Write results ────────────────────────────────────────
    await updateJob(job_id, { progress: 96, stage_detail: 'Writing line items' })

    // Calibration runs are experiments: they never touch the project's shared
    // line_items or the user's job history — their output lives only in
    // analysis_results, where the Admin calibration table reads it.
    if (!cfg.calibration) await supabase.from('line_items').delete().eq('project_id', project_id)
    if (!cfg.calibration && merged.length > 0) {
      const rows = merged.map(m => ({
        project_id,
        category: m.category,
        description: m.description,
        quantity: m.quantity,
        unit: m.unit,
        confidence: m.confidence,
        confidence_note: m.note || null,
        depth_avg: m.depth?.avg ?? null,
        depth_max: m.depth?.max ?? null,
        depth_bucket_json: m.depth?.buckets ?? null,
        source_sheet: m.sheet_id || null,
        status: m.status === 'flagged' ? 'flagged' : 'active',
        material_slug: m.material_slug || null,
      }))
      const { error: insErr } = await supabase.from('line_items').insert(rows)
      if (insErr) throw new Error(`line_items insert failed: ${insErr.message}`)
    }

    // Consolidated result for the dashboard (shaped like the existing takeoff JSON)
    const GRAVITY = new Set(['sanitary', 'storm'])
    const items = merged.map((m, i) => ({
      item_no: i + 1,
      category: m.category,
      description: m.description,
      unit: m.unit,
      quantity: m.quantity ?? 0,
      confidence: m.confidence,
      material_slug: m.material_slug || null,
      depth_avg: m.depth?.avg ?? null,
      depth_max: m.depth?.max ?? null,
      // Gravity pipe with no profile depth → explicit "unavailable" rather than blank.
      depth_unavailable: m.category === 'PIPE' && !m.depth &&
        GRAVITY.has((m.description || '').toLowerCase().includes('sanitary') ? 'sanitary'
          : (m.description || '').toLowerCase().includes('storm') ? 'storm' : ''),
      notes: [
        m.status === 'flagged' ? '⚠ FLAGGED.' : null,
        m.depth ? `Depth avg ${m.depth.avg} ft / max ${m.depth.max} ft.` : null,
        m.note,
      ].filter(Boolean).join(' '),
    }))
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 }
    merged.forEach(m => { counts[m.confidence] = (counts[m.confidence] || 0) + 1 })

    // ── Open clarifications: what the AI caught but couldn't pin down ──
    // Depth gaps first (they price excavation), then plan/profile mismatches,
    // then low-confidence big-quantity items. Capped so the resolve flow stays
    // approachable — one question at a time in the UI.
    const clarifications = []
    const asked = new Set()
    let cid = 1
    for (const it of items) {
      if (clarifications.length >= 12) break
      if (it.depth_unavailable && !asked.has(it.item_no)) {
        asked.add(it.item_no)
        clarifications.push({
          id: cid++, type: 'depth', item_no: it.item_no,
          question: `Depth for "${it.description}" isn't readable on the plans. What depth (in feet) should we use?`,
          context: 'No rim/invert elevations were legible for this run. Check the profile sheet or verify in the field — excavation, bedding, and trench safety all price off this number.',
        })
      }
    }
    for (const it of items) {
      if (clarifications.length >= 12) break
      if (it.category === 'STRUCTURE' && it.depth_avg == null && !asked.has(it.item_no) &&
          /manhole|mh\b|inlet|junction|box|vault/i.test(it.description)) {
        asked.add(it.item_no)
        clarifications.push({
          id: cid++, type: 'depth', item_no: it.item_no,
          question: `No depth found for "${it.description}". What's the depth (in feet)?`,
          context: 'Structure depth drives excavation and shoring cost. If the plans don\'t show it, rim minus invert from the profile is the usual source.',
        })
      }
    }
    for (const r of reconciliations) {
      if (clarifications.length >= 12) break
      clarifications.push({
        id: cid++, type: 'mismatch', item_no: null,
        question: `${r.run}: the plan view shows ${Math.round(r.plan_lf)} LF but the profile shows ${r.profile_lf} LF (${r.pct_diff}% apart). Which length is correct?`,
        context: 'Profile lengths are engineer-dimensioned and usually govern, but confirm before pricing. The profile value is currently used.',
      })
    }
    for (const it of items) {
      if (clarifications.length >= 12) break
      if (it.confidence === 'LOW' && ['PIPE', 'STRUCTURE'].includes(it.category) &&
          (it.quantity ?? 0) >= 100 && !asked.has(it.item_no)) {
        asked.add(it.item_no)
        clarifications.push({
          id: cid++, type: 'verify', item_no: it.item_no,
          question: `Low confidence on "${it.description}" — we read ${it.quantity} ${it.unit}. Can you confirm or correct that quantity?`,
          context: (it.notes || '').slice(0, 200),
        })
      }
    }

    const resultJson = {
      items,
      summary: {
        total_items: items.length,
        high_confidence_count: counts.HIGH,
        medium_confidence_count: counts.MEDIUM,
        low_confidence_count: counts.LOW,
        key_observations: `Tiled multi-pass analysis of ${sheets.length} sheets (${p1Sheets.length} plan, ${p2Sheets.length} plan-profile). ${textMode === 'raster-only' ? 'RASTER-ONLY (scanned) — no PDF text layer; all quantities are vision reads, treat extractability as lower. ' : `Hybrid extraction: PDF text layer used as ground truth (${totalRuns} text runs). `}${reconciliations.length} plan-vs-profile length mismatch${reconciliations.length === 1 ? '' : 'es'} flagged. ${depthSummary.trench_safety_lf > 0 ? `${depthSummary.trench_safety_lf} LF requires OSHA trench protection (>5 ft).` : ''}${depthSummary.geotech?.rock_excavation_total_lf > 0 ? ` ~${depthSummary.geotech.rock_excavation_total_lf} LF est. rock excavation.` : ''} ${engineerRows.length > 0 ? `Engineer quantity table found — ${variance.length} items compared.` : 'No engineer quantity table found on the analyzed sheets.'}`,
      },
      text_layer: {
        mode: textMode,
        total_runs: totalRuns,
        sheets_with_text: sheetsWithText,
        sheets_total: sheets.length,
        tables_detected: textTables.length,
        table_rows_to_pass5: tableEngineerRows.length,
      },
      clarifications,
      depth_summary: depthSummary,
      variance_table: variance,
      reconciliations,
      profile_runs: runs.map(({ _stats, _itemIdx, ...r }) => r),
      pass_stats: {
        sheets_analyzed: sheets.length,
        pass1_raw_items: p1Items.length,
        pass2_runs: runs.length,
        merged_items: merged.length,
        pass4_raw_items: p4Items.length,
        engineer_rows: engineerRows.length,
        trench_safety_lf: depthSummary.trench_safety_lf,
      },
      // Real spend for this run (Message Batches pricing). Excludes the few
      // synchronous assembly Haiku calls (~cents).
      run_cost: {
        usage: state.usage,
        est_usd: Math.round(
          ['opus', 'sonnet', 'haiku'].reduce((sum, tier) =>
            sum +
            ((state.usage[tier]?.in || 0) / 1e6) * PRICES[tier].in +
            ((state.usage[tier]?.out || 0) / 1e6) * PRICES[tier].out, 0) * 100) / 100,
      },
      // Which model tier ran each pass, and how this run scored.
      config: { label: cfg.label || 'Standard (Opus)', models: tiers, calibration: !!cfg.calibration },
      calibration_score: {
        vs_engineer: varianceMetrics(variance),
        vs_truth: Array.isArray(projGeo?.calibration_truth) && projGeo.calibration_truth.length
          ? scoreAgainstTruth(projGeo.calibration_truth, items)
          : null,
      },
    }

    await supabase.from('analysis_results').insert({ project_id, job_id, result_json: resultJson })

    // Write a job-history row server-side so the result is always reachable from
    // "Recent Jobs" — even if the user's browser wasn't open at completion (the
    // Realtime event only fires for open sessions).
    const { data: proj } = await supabase.from('projects').select('user_id, name').eq('id', project_id).single()
    if (proj?.user_id && !cfg.calibration) {
      await supabase.from('jobs').insert({
        user_id: proj.user_id,
        project_id,
        plan_filename: proj.name || 'Plan Set',
        line_item_count: items.length,
        risk_flag_count: reconciliations.length,
        result_json: resultJson,
      })
    }

    // Scratch tiles no longer needed once the result is persisted.
    await supabase.from('analysis_tiles').delete().eq('job_id', job_id)
    await updateJob(job_id, {
      stage: 'complete', progress: 100,
      stage_detail: `${items.length} line items — $${resultJson.run_cost.est_usd} API cost`,
      batch_state: { usage: state.usage, chains: state.chains, done: true },
    })
    return { statusCode: 200 }
  } catch (err) {
    console.error('Analysis pipeline error:', err)
    // Raw REST — works even if the supabase-js client is what failed.
    await rawJobUpdate(job_id, { stage: 'error', error: `Analysis failed: ${err.message}`, stage_detail: null })
    return { statusCode: 200 }
  }
}
