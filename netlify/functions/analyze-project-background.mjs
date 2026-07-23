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
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// Background functions are publicly POST-able at /.netlify/functions/* — every
// caller (edge functions, self-chaining) must present the shared secret or an
// outsider can drive Anthropic spend and service-role DB writes.
export function fnSecretOk(headers) {
  const provided = headers?.['x-fn-secret'] || headers?.['X-Fn-Secret']
  const expected = process.env.WEBHOOK_SECRET
  if (!provided || !expected) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

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
// A 1568px tile that compresses under this is treated as empty. Kept low on
// purpose: a lone 2" service line on an otherwise-empty tile is exactly what
// Pass 4 exists to find, so err toward sending borderline tiles to the model.
const BLANK_PNG_BYTES = 8_000
const MAX_RESUBMITS = 2
const MAX_POLL_FAILS = 5          // consecutive getBatch failures before a batch ID is abandoned
const LEASE_MS = 14 * 60 * 1000   // job lock — one invocation past Netlify's 15-min kill

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

// Quantity extraction runs on utility/profile sheets. Grading & paving are
// deliberately NOT here — they go to the grades pass (Pass 6) only, so we never
// double-count utility linework that also appears on a grading plan.
const PASS1_TYPES = new Set(['utility_plan', 'storm', 'sanitary', 'water', 'plan_profile', 'demo', 'erosion_control', 'landscape', 'electrical', 'other', 'unclassified'])
// Grading/paving sheets — mined for finished-grade elevations at structures.
const GRADE_TYPES = new Set(['grading', 'paving'])
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

const PASS6_TASK = `YOUR TASK (PASS 6 — FINISHED-GRADE ELEVATIONS FROM THE GRADING PLAN):
This tile is from a grading or paving sheet. Utility structures (sanitary/storm manholes, curb & area inlets, junction boxes, cleanouts) sit on this sheet at their plan locations. For EACH utility structure you can identify by its label (e.g. SSMH-1, STMH-4, CB-2, JB-1, CO-3), read the FINISHED GRADE / RIM / TOP elevation at that structure. It may be labeled RIM, TG (top of grate), TC (top of curb), FG, FL, or shown as a spot elevation printed right at the structure. Return ONLY structures where you can actually read a grade elevation next to a labeled structure — do not guess, do not read contour line values that aren't tied to a structure.

Respond ONLY with this JSON, no markdown, no preamble:
{"grades":[{"structure_id":"e.g. SSMH-1","finished_grade_elev":number,"kind":"rim|top_grate|top_curb|finished_grade|spot","confidence":"HIGH|MEDIUM|LOW","note":"where read, max 15 words"}]}
No labeled structure with a readable grade elevation in this tile: {"grades":[]}`

const PASS7_TASK = `YOUR TASK (PASS 7 — STRUCTURE SCHEDULE):
Determine whether this tile contains a STRUCTURE SCHEDULE / DRAINAGE STRUCTURE TABLE / SANITARY MANHOLE SCHEDULE — a table that lists drainage or sewer structures with their elevations. Typical columns: Structure No./ID (SSMH-1, STMH-4, CB-2, JB-1, DI-3), Type/Description, Rim or Top or TC elevation, Invert In / FL In, Invert Out / FL Out, and sometimes a Depth column. This is the engineer's own dimensioned data — the most precise source for structure depths.

For each legible row, report: the structure id, its type, the RIM (top) elevation, the LOWEST (deepest) invert elevation shown for it (the controlling invert for depth — if inverts are labeled in/out, use the lowest), and the depth if a depth column is printed. Do NOT invent rows; skip illegible ones. Report elevations exactly as printed.

Respond ONLY with this JSON, no markdown, no preamble:
{"schedule_found":boolean,"structures":[{"structure_id":"SSMH-1","type":"string or null","rim_elev":number or null,"invert_elev":number or null,"depth_ft":number or null,"confidence":"HIGH|MEDIUM|LOW"}]}
No structure schedule in this tile: {"schedule_found":false,"structures":[]}`

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

// NOTE: do NOT set `temperature` — Opus 4.8 and Sonnet 5 have DEPRECATED the
// parameter and return 400 "temperature is deprecated for this model" if it's
// present (even 0). Haiku still accepts it, but we omit it everywhere for
// consistency. (Setting temperature:0 here silently 400'd every Opus/Sonnet
// request in pre-launch testing — extraction returned zero items.)
// withMeta:true returns { text, stop_reason } so callers can detect max_tokens
// truncation instead of trusting a clipped JSON tail.
async function callClaude({ model, system, content, maxTokens = 8192, withMeta = false }) {
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      const text = data.content?.map(b => (b.type === 'text' ? b.text : '')).join('') || ''
      return withMeta ? { text, stop_reason: data.stop_reason } : text
    }
    const errText = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      console.warn(`Claude ${res.status}, retry ${attempt}`)
      await new Promise(r => setTimeout(r, Math.min(attempt * attempt * 5000, 60_000)))
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

// A takeoff quantity can't be negative, and anything past a million of any
// unit is a misread — treat both as "no quantity" so they get flagged, not priced.
function qty(v) {
  const n = num(v)
  if (n == null || n < 0 || n > 1_000_000) return null
  return n
}

function validateItems(raw, passName) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw) {
    if (!it || typeof it.description !== 'string' || !it.description.trim()) {
      console.warn(`${passName}: dropped item without description`); continue
    }
    const category = CATEGORIES.has(it.category) ? it.category : 'OTHER'
    out.push({
      category,
      description: it.description.trim().slice(0, 500),
      quantity: qty(it.quantity),
      // A missing unit on a pipe run is LF, not EA — defaulting pipe to EA
      // silently turned footage into "each" counts.
      unit: typeof it.unit === 'string' && it.unit.trim()
        ? it.unit.trim().toUpperCase().slice(0, 8)
        : (category === 'PIPE' ? 'LF' : 'EA'),
      diameter_in: num(it.diameter_in),
      material: typeof it.material === 'string' ? it.material.slice(0, 80) : null,
      location: typeof it.location === 'string' ? it.location.slice(0, 200) : '',
      confidence: CONFIDENCES.has(it.confidence) ? it.confidence : 'LOW',
      note: typeof it.note === 'string' ? it.note.slice(0, 1000) : '',
      continues_beyond_tile: it.continues_beyond_tile === true,
      source_ids: Array.isArray(it.source_ids) ? it.source_ids.filter(n => Number.isInteger(n) && n >= 0) : [],
    })
  }
  return out
}

function validateRuns(raw, passName) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw) {
    if (!r) continue
    // A run with structures/elevations but a blank run_id is still real data —
    // synthesize an identity instead of dropping the depths on the floor.
    let runId = typeof r.run_id === 'string' && r.run_id.trim() ? r.run_id.trim() : null
    if (!runId && typeof r.from_structure === 'string' && typeof r.to_structure === 'string') {
      runId = `${r.from_structure.trim()} to ${r.to_structure.trim()}`.trim()
    }
    if (!runId) {
      console.warn(`${passName}: dropped run without run_id or structures`); continue
    }
    out.push({
      run_id: runId.slice(0, 120),
      utility: ['sanitary', 'storm', 'water'].includes(r.utility) ? r.utility : 'other',
      from_structure: typeof r.from_structure === 'string' ? r.from_structure.slice(0, 60) : null,
      to_structure: typeof r.to_structure === 'string' ? r.to_structure.slice(0, 60) : null,
      station_start: typeof r.station_start === 'string' ? r.station_start.slice(0, 30) : null,
      station_end: typeof r.station_end === 'string' ? r.station_end.slice(0, 30) : null,
      length_lf: qty(r.length_lf),
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

// Pass 5 tile validator. Rows are kept whenever the model actually produced
// them — requiring table_found === true threw away correctly-parsed tables
// whenever the model omitted the boolean.
function validateEngineerTile(parsed) {
  if (!parsed || parsed.table_found === false) return []
  return validateEngineerRows(parsed.rows)
}

// Pass 6: finished-grade elevations at structures (from the grading plan).
const GRADE_KINDS = new Set(['rim', 'top_grate', 'top_curb', 'finished_grade', 'spot'])
function validateGrades(raw) {
  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.grades) ? raw.grades : [])
  const out = []
  for (const g of rows) {
    if (!g || typeof g.structure_id !== 'string' || !g.structure_id.trim()) continue
    const elev = num(g.finished_grade_elev)
    // Plausible civil finished-grade range; rejects misreads and page coords.
    if (elev == null || elev < -500 || elev > 15000) continue
    out.push({
      structure_id: g.structure_id.trim().slice(0, 60),
      finished_grade_elev: elev,
      kind: GRADE_KINDS.has(g.kind) ? g.kind : 'spot',
      confidence: CONFIDENCES.has(g.confidence) ? g.confidence : 'LOW',
    })
  }
  return out
}

// Pass 7: structure-schedule rows (rim/invert/depth per structure).
const ELEV_OK = (v) => v != null && v > -500 && v < 15000
function validateSchedule(raw) {
  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.structures) ? raw.structures : [])
  const out = []
  for (const s of rows) {
    if (!s || typeof s.structure_id !== 'string' || !s.structure_id.trim()) continue
    const rim = num(s.rim_elev), inv = num(s.invert_elev)
    let depth = num(s.depth_ft)
    // Prefer a printed depth; else derive rim − invert when both are sane.
    if (depth == null && ELEV_OK(rim) && ELEV_OK(inv)) depth = rim - inv
    // Keep the row only if it carries at least one usable depth signal.
    if (depth == null && !ELEV_OK(rim) && !ELEV_OK(inv)) continue
    if (depth != null && (depth < 0 || depth > 100)) depth = null
    out.push({
      structure_id: s.structure_id.trim().slice(0, 60),
      type: typeof s.type === 'string' ? s.type.slice(0, 60) : null,
      rim_elev: ELEV_OK(rim) ? rim : null,
      invert_elev: ELEV_OK(inv) ? inv : null,
      depth_ft: depth,
      confidence: CONFIDENCES.has(s.confidence) ? s.confidence : 'LOW',
    })
  }
  return out
}

// Fuzzy structure-id match: exact normKey first, then a shared trailing
// number + shared type token (so "MH-1" on the schedule can still match
// "SSMH-1" on the profile). Returns the matched map value or undefined.
function structIdLookup(id, map) {
  const k = normKey(id)
  if (!k) return undefined
  if (map.has(k)) return map.get(k)
  const numMatch = k.match(/(\d+)$/)
  if (!numMatch) return undefined
  const n = numMatch[1]
  const typeToks = k.replace(/\d+$/, '')  // e.g. 'ssmh'
  for (const [mk, mv] of map) {
    const mnum = mk.match(/(\d+)$/)
    if (!mnum || mnum[1] !== n) continue
    const mtype = mk.replace(/\d+$/, '')
    // Same number and one type token is a prefix/suffix of the other.
    if (mtype && typeToks && (mtype.includes(typeToks) || typeToks.includes(mtype))) return mv
  }
  return undefined
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

// Page-space bbox of every tile, keyed by row-major idx — the single source of
// truth for tile geometry, used both to render tiles and to record where each
// line item was read (click-to-verify). Returns { bboxes: [[x0,y0,x1,y1],...], page }.
function tileBBoxes(x0, y0, pageW, pageH) {
  const { cols, rows } = gridFor(pageW, pageH)
  const stepX = pageW / cols, stepY = pageH / rows
  const ovX = 0.075 * stepX, ovY = 0.075 * stepY
  const bboxes = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      bboxes.push([
        x0 + col * stepX - (col > 0 ? ovX : 0),
        y0 + row * stepY - (row > 0 ? ovY : 0),
        x0 + (col + 1) * stepX + (col < cols - 1 ? ovX : 0),
        y0 + (row + 1) * stepY + (row < rows - 1 ? ovY : 0),
      ])
    }
  }
  return { bboxes, page: [x0, y0, x0 + pageW, y0 + pageH] }
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
      // Offset by the page origin — CropBoxes don't always start at (0,0), and
      // an unoffset grid both renders the wrong region and mismatches the
      // text-layer coordinates (which are absolute page space).
      const tx0 = x0 + col * stepX - (col > 0 ? ovX : 0)
      const tx1 = x0 + (col + 1) * stepX + (col < cols - 1 ? ovX : 0)
      const ty0 = y0 + row * stepY - (row > 0 ? ovY : 0)
      const ty1 = y0 + (row + 1) * stepY + (row < rows - 1 ? ovY : 0)
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
  const scale = sheet.drawing_scale
    ? ` Drawing scale ${sheet.drawing_scale} — use it to sanity-check any length: if a run's callout length looks inconsistent with how long it's drawn, lower its confidence and note the discrepancy.`
    : ''
  return `CONTEXT: Sheet "${label}" (classification: ${sheet.classification || 'unknown'}). This image is the ${tile.position} of a ${tile.grid} tile grid; tiles overlap neighbors by ~15%.${scale}`
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

// ── Scale-aware measurement (beta) ──────────────────────────────
// Detects the drawing scale from the text layer and measures pipe-candidate
// linework straight from the PDF's vector geometry — so a run can be checked
// against the drawing even when its callout is wrong or missing (the exact
// failure mode on poorly-labeled plans). Advisory only: it never overwrites a
// quantity; it surfaces the longest measured runs + a detected scale so the
// estimator can eyeball the mains and catch a missed line.
const INCH_MK = '["”″]'
const FOOT_MK = "['’′]"
// US civil convention: 1"=N'. Prefers a HORIZ-labeled scale (profiles carry a
// separate, finer vertical scale we must not use for plan-view lengths).
const SCALE_RE = new RegExp(`(horiz[a-z.:\\s]{0,14})?1\\s*(?:${INCH_MK}|in\\.?|inch(?:es)?)\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${FOOT_MK}|ft\\b|feet\\b|foot\\b)?`, 'gi')

function detectScale(runs) {
  const text = runs.map(r => r.text).join(' ')
  const ms = [...text.matchAll(SCALE_RE)].map(m => ({ n: Number(m[2]), horiz: !!m[1] })).filter(m => isFinite(m.n) && m.n > 0)
  if (!ms.length) return null
  const h = ms.find(m => m.horiz)
  const n = h ? h.n : Math.max(...ms.map(m => m.n))
  return { label: `1"=${n}'`, ft_per_pt: n / 72, ft_per_in: n }
}

const applyCtm = (c, x, y) => [c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5]]
const NOOP = () => {}

// Captures every stroked path's polyline length (in page points). Fully
// guarded — a device error on an odd PDF returns [] rather than failing the run.
// The callbacks object MUST implement every device method or the native device
// throws when it hits an unimplemented op (text/image/clip on a real sheet).
function extractPolylines(mupdf, doc, pageIndex) {
  const out = []
  let page = null
  try {
    page = doc.loadPage(pageIndex)
    const cb = {
      strokePath(path, stroke, ctm) {
        try {
          const p = []
          path.walk({
            moveTo: (x, y) => p.push(applyCtm(ctm, x, y)),
            lineTo: (x, y) => p.push(applyCtm(ctm, x, y)),
            curveTo: (a, b, c, d, e, f) => p.push(applyCtm(ctm, e, f)),
            closePath: NOOP,
          })
          if (p.length < 2) return
          let len = 0
          for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
          out.push({ len_pt: len, segs: p.length - 1 })
        } catch { /* skip bad path */ }
      },
      fillPath: NOOP, clipPath: NOOP, clipStrokePath: NOOP, fillText: NOOP, strokeText: NOOP,
      clipText: NOOP, clipStrokeText: NOOP, ignoreText: NOOP, fillShade: NOOP, fillImage: NOOP,
      fillImageMask: NOOP, clipImageMask: NOOP, popClip: NOOP, beginMask: NOOP, endMask: NOOP,
      beginGroup: NOOP, endGroup: NOOP, beginTile: () => 0, endTile: NOOP, beginLayer: NOOP,
      endLayer: NOOP, close: NOOP,
    }
    page.run(new mupdf.Device(cb), mupdf.Matrix.identity)
  } catch (e) {
    console.error(`extractPolylines page ${pageIndex}:`, e.message)
  } finally {
    if (page) try { page.destroy() } catch { /* ignore */ }
  }
  return out
}

// Per-sheet measurement: detected scale + the longest measured runs in real LF.
// Multi-segment polylines (segs >= 2) are favored — pipe runs bend through
// bends/structures, whereas a straight property line is one long segment.
function measureSheet(runs, mupdf, doc, pageIndex) {
  const scale = detectScale(runs)
  if (!scale) return { scale: null }
  const polys = extractPolylines(mupdf, doc, pageIndex)
  const measured = polys
    .map(p => ({ lf: Math.round(p.len_pt * scale.ft_per_pt), segs: p.segs }))
    .filter(r => r.lf >= 20 && r.lf <= 20000)   // drop marks and full-sheet borders
  measured.sort((a, b) => b.lf - a.lf)
  return {
    scale: scale.label,
    top_runs: measured.slice(0, 8).map(r => r.lf),
    candidate_count: measured.length,
    total_candidate_lf: measured.reduce((s, r) => s + r.lf, 0),
  }
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

      // A max_tokens-truncated or unparseable "success" is a FAILED tile, not an
      // empty one — the densest (most item-rich) tiles are exactly the ones that
      // overflow. Leave the tile missing so the resubmit machinery retries it;
      // after MAX_RESUBMITS it lands in failed-tile reporting, never silent zero.
      if (parsed == null || msg.stop_reason === 'max_tokens') {
        console.error(`batch result ${entry.custom_id}: unusable output (stop_reason=${msg.stop_reason}, parsed=${parsed != null})`)
        continue
      }

      const raw = Array.isArray(parsed) ? parsed : (pass.resultKey ? parsed?.[pass.resultKey] : parsed)
      valid = pass.validator(raw, pass.name).map(v => ({
        ...v,
        sheet_id: sheet.id,
        sheet_label: sheet.sheet_number || `pg ${sheet.page_number}`,
        tile: `tile ${Number(idxStr) + 1}`,
        tile_idx: Number(idxStr),   // row-major tile index → region lookup (click-to-verify)
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

// Paginated read of analysis_tiles. Supabase caps un-ranged selects at 1000
// rows; a 40-sheet set produces more tiles than that, and a silent cap here
// meant "missing" tiles that were endlessly re-billed and re-run.
async function loadAllTiles(jobId, columns, passKey = null) {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('analysis_tiles').select(columns).eq('job_id', jobId)
    if (passKey) q = q.eq('pass', passKey)
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) throw new Error(`analysis_tiles read failed: ${error.message}`)
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return all
}

// Reads back every persisted tile result for a pass, flattened. Throws on
// read failure — an empty array here must mean "no items", never "the query
// failed", because assembly deletes and rewrites line_items from it.
async function loadPassResults(jobId, passKey) {
  const data = await loadAllTiles(jobId, 'result_json', passKey)
  return data.flatMap(r => Array.isArray(r.result_json) ? r.result_json : [])
}

// Re-invokes this background function to continue a paused job (fire-and-forget;
// background functions ack 202 immediately). Returns false on failure so the
// caller can mark the job errored instead of stranding it mid-"Batched analysis".
async function reinvokeSelf(jobId, projectId) {
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL
  if (!site) { console.error('reinvokeSelf: no site URL env'); return false }
  try {
    const res = await fetch(`${site}/.netlify/functions/analyze-project-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fn-secret': process.env.WEBHOOK_SECRET || '',
      },
      body: JSON.stringify({ job_id: jobId, project_id: projectId }),
    })
    return res.ok || res.status === 202
  } catch (e) {
    console.error('reinvokeSelf failed:', e.message)
    return false
  }
}

// ── Pass 3 code-side: profile run dedupe, depth math, reconciliation ──
function normKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }

function dedupeRuns(runs) {
  // Every alias a run answers to: the direction-normalized structure pair
  // (so "SSMH-1 to SSMH-2" and "SSMH-2 to SSMH-1" collide) plus the raw
  // run_id (so a tile that only produced run_id still matches one that
  // produced the structure pair).
  const aliasesOf = (r) => {
    const keys = new Set()
    if (r.from_structure && r.to_structure) {
      keys.add([normKey(r.from_structure), normKey(r.to_structure)].sort().join('>'))
    }
    if (r.run_id) {
      keys.add(normKey(r.run_id))
      const m = r.run_id.match(/^(.+?)\s+to\s+(.+)$/i)
      if (m) keys.add([normKey(m[1]), normKey(m[2])].sort().join('>'))
    }
    keys.delete('')
    return keys
  }
  const score = x => [x.length_lf, x.slope_pct, x.diameter_in, x.material].filter(v => v != null).length + x.structures.length

  const out = []            // [{ run, aliases }]
  for (const r of runs) {
    const aliases = aliasesOf(r)
    const hit = out.find(o => [...aliases].some(k => o.aliases.has(k)))
    if (!hit) { out.push({ run: r, aliases }); continue }
    aliases.forEach(k => hit.aliases.add(k))
    if (score(r) > score(hit.run)) hit.run = { ...r, note: hit.run.note || r.note }
  }
  return out.map(o => o.run)
}

// Depth resolution order, most→least precise:
//   1. explicit depth on the profile structure
//   2. STRUCTURE SCHEDULE — the engineer's dimensioned table (depth, or rim−invert)
//   3. rim − invert from the profile
//   4. grading-plan finished grade − profile invert ("use the grading to find out")
// scheduleMap/gradeMap key on normKey(structure_id); lookups are fuzzy so
// "MH-1" ↔ "SSMH-1" still match.
function structureDepth(s, gradeMap, scheduleMap) {
  if (s.depth_ft != null) return s.depth_ft

  const sched = scheduleMap ? structIdLookup(s.id, scheduleMap) : undefined
  if (sched) {
    if (sched.depth_ft != null && sched.depth_ft >= 0 && sched.depth_ft < 100) { s._scheduleDerived = true; return sched.depth_ft }
    if (sched.rim_elev != null && sched.invert_elev != null) {
      const d = sched.rim_elev - sched.invert_elev
      if (d >= 0 && d < 100) { s._scheduleDerived = true; return d }
    }
  }

  if (s.rim_elev != null && s.invert_elev != null) return s.rim_elev - s.invert_elev

  // Grading fallback needs an invert to subtract from — profile's, or the schedule's.
  const invForGrade = s.invert_elev != null ? s.invert_elev : (sched?.invert_elev ?? null)
  if (invForGrade != null && gradeMap) {
    const g = structIdLookup(s.id, gradeMap)
    if (g != null) {
      const d = g - invForGrade
      if (d >= 0 && d < 100) { s._gradeDerived = true; return d }
    }
  }
  return null
}

function depthStats(run, gradeMap, scheduleMap) {
  const rawDepths = run.structures.map(s => structureDepth(s, gradeMap, scheduleMap)).filter(d => d != null)
  const depths = rawDepths.filter(d => d >= 0 && d < 100)
  // Track how many elevations were unusable (e.g. rim < invert misreads) —
  // interpolation over the survivors assumes even spacing between the wrong
  // structures, so the result must carry a "verify this" marker.
  const dropped = rawDepths.length - depths.length
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
      // OSHA 1926.652 requires protection at 5 ft OR MORE — inclusive.
      if (depth >= TRENCH_SAFETY_FT) lfOver5 += lf
    }
    for (const k of Object.keys(buckets)) buckets[k] = Math.round(buckets[k])
    lfOver5 = Math.round(lfOver5)
  }
  return { avg: Math.round(avg * 10) / 10, max: Math.round(max * 10) / 10, buckets, lf_over_5: lfOver5, samples, dropped }
}

// LF of a run at or below a threshold depth (e.g. rock line), from the samples.
function lfOverThreshold(stats, threshold) {
  if (!stats?.samples) return null
  let lf = 0
  for (const { depth, lf: segLf } of stats.samples) if (depth >= threshold) lf += segLf
  return Math.round(lf)
}

// ── Depth engine: derived flags + biddable items from profile depths ──
// Consumes runs (each carrying ._stats from depthStats and ._itemIdx = the
// matched merged line item, if any). Mutates merged to flag deep/unavailable
// runs; returns derived line items + a depth_summary for the report UI.
function buildDepthEngine(runs, merged, geotech, gradeMap, scheduleMap) {
  const rockDepth = geotech?.rock_depth_ft ?? null
  const gwDepth = geotech?.groundwater_depth_ft ?? null

  let trenchSafetyLf = 0
  let gradeDerivedRuns = 0
  let scheduleDerivedRuns = 0
  const runSummaries = [], deepRuns = [], rockHits = [], groundwaterRuns = [], unavailableRuns = []

  for (const run of runs) {
    const st = run._stats
    if (!st) {
      // Gravity run with no usable elevation data — never guess. (The grading
      // fallback already ran inside structureDepth; still nothing → ask.)
      unavailableRuns.push({ run_id: run.run_id, utility: run.utility })
      if (run._itemIdx != null && merged[run._itemIdx]) {
        const it = merged[run._itemIdx]
        it.note = `DEPTH UNAVAILABLE — not in the structure schedule, no rim on the profile, and no finished grade on the grading plan for this run. Verify in the field. ${it.note || ''}`.trim().slice(0, 1000)
      }
      continue
    }

    trenchSafetyLf += st.lf_over_5 || 0
    const scheduleDerived = run.structures.some(s => s._scheduleDerived)
    const gradeDerived = run.structures.some(s => s._gradeDerived)
    if (scheduleDerived) scheduleDerivedRuns++
    if (gradeDerived) gradeDerivedRuns++
    runSummaries.push({
      run_id: run.run_id, utility: run.utility, length_lf: run.length_lf ?? null,
      depth_avg: st.avg, depth_max: st.max, buckets: st.buckets, lf_over_5: st.lf_over_5 ?? null,
      grade_derived: gradeDerived || undefined,
      schedule_derived: scheduleDerived || undefined,
    })

    if (scheduleDerived && run._itemIdx != null && merged[run._itemIdx]) {
      const it = merged[run._itemIdx]
      it.note = `Depth from the structure schedule (engineer-dimensioned). ${it.note || ''}`.trim().slice(0, 1000)
    } else if (gradeDerived && run._itemIdx != null && merged[run._itemIdx]) {
      const it = merged[run._itemIdx]
      it.note = `Depth derived from the grading plan's finished grade (rim not called out on the profile) — verify before pricing. ${it.note || ''}`.trim().slice(0, 1000)
    }

    if (st.dropped > 0 && run._itemIdx != null && merged[run._itemIdx]) {
      const it = merged[run._itemIdx]
      it.note = `Some profile elevations for this run were unreadable — depth figures are partial, verify from profiles. ${it.note || ''}`.trim().slice(0, 1000)
    }

    if (st.max >= DEEP_EXCAVATION_FT) {
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
      const d = structureDepth(s, gradeMap, scheduleMap)
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
    grade_derived_runs: gradeDerivedRuns,
    schedule_derived_runs: scheduleDerivedRuns,
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

// Match a profile run to a merged plan item. The threshold requires real
// evidence: a structure-ID hit in the item's location, or diameter AND utility
// together. Diameter alone (the old bar) bound 8" storm profiles to 8"
// sanitary plan items and then overwrote the wrong quantity.
function matchRunToItem(run, items, used) {
  let best = null, bestScore = 0
  for (let i = 0; i < items.length; i++) {
    if (used.has(i) || items[i].category !== 'PIPE') continue
    const it = items[i]
    if (run.diameter_in != null && it.diameter_in != null && run.diameter_in !== it.diameter_in) continue
    const desc = it.description.toLowerCase()
    // A plan item that names a DIFFERENT utility can never be this run.
    if (run.utility !== 'other') {
      const others = ['sanitary', 'storm', 'water'].filter(u => u !== run.utility)
      if (others.some(u => desc.includes(u.slice(0, 5)))) continue
    }
    let score = run.diameter_in != null && it.diameter_in === run.diameter_in ? 2 : 0
    if (run.utility !== 'other' && desc.includes(run.utility.slice(0, 5))) score += 2
    if (run.material && desc.includes(run.material.toLowerCase())) score += 1
    const loc = (it.location || '').toLowerCase()
    if (run.from_structure && loc.includes(run.from_structure.toLowerCase())) score += 4
    if (run.to_structure && loc.includes(run.to_structure.toLowerCase())) score += 4
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore >= 4 ? best : null
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

// Structured signals for accuracy matching. Diameter, utility, and item
// category are HARD GATES — a mismatch disqualifies the pair — so an 8" sanitary
// can never match a 12" storm just because the word "pipe" overlaps. This is
// what makes the accuracy numbers (engineer variance + ground-truth score)
// trustworthy rather than an artifact of a loose token matcher.
function extractSig(desc) {
  const d = (desc || '').toLowerCase()
  const diaM = d.match(/(\d+(?:\.\d+)?)\s*(?:"|in\b|inch|-in\b|in\.)/)
  const dia = diaM ? Number(diaM[1]) : null
  let utility = null
  if (/storm|\bstm\b|\bsd\b|catch ?basin|\bdrain/.test(d)) utility = 'stm'
  else if (/sanit|\bss\b|\bsan\b|sewer/.test(d)) utility = 'san'
  else if (/potable|\bwater\b|\bwl\b|\bwtr\b|water ?main|water ?line/.test(d)) utility = 'wtr'
  else if (/\bfire\b|\bfl\b|fdc/.test(d)) utility = 'fire'
  else if (/irrig/.test(d)) utility = 'irr'
  else if (/force ?main|\bfm\b/.test(d)) utility = 'fm'
  let cat = null
  if (/manhole|\bmh\b|ssmh|stmh|sanmh/.test(d)) cat = 'mh'
  else if (/\binlet\b|catch ?basin|\bcb\b|grate|\bdi\b|junction ?box|\bjb\b|\bvault\b/.test(d)) cat = 'inlet'
  else if (/hydrant|\bfh\b/.test(d)) cat = 'hyd'
  else if (/cleanout|\bco\b/.test(d)) cat = 'co'
  else if (/\bvalve\b|\bgv\b|\bbv\b|tapping ?sleeve/.test(d)) cat = 'valve'
  else if (/\bbend\b|\btee\b|\bwye\b|elbow|reducer|coupling|\bcross\b|\bcap\b|\bplug\b/.test(d)) cat = 'fitting'
  else if (/trench|excav|\bbore\b|casing|bedding|backfill|shoring|pavement|sawcut/.test(d)) cat = 'excav'
  else if (dia != null || /\bpipe\b|\bpvc\b|\brcp\b|\bdip\b|hdpe|c900|c905|sdr|\bdr-|\bmain\b|lateral|service|conduit/.test(d)) cat = 'pipe'
  return { dia, utility, cat }
}

// Best item index matching a target row, or -1. Hard gates on unit/diameter/
// utility/category; then a symmetric Dice token score with bonuses for exact
// diameter/utility. Threshold is modest because the gates do the discriminating.
function matchRow(desc, unit, items, used) {
  const tt = tokenize(desc), sig = extractSig(desc)
  let best = -1, bestScore = 0
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue
    const it = items[i]
    if (unit && it.unit && String(unit).toUpperCase() !== String(it.unit).toUpperCase()) continue
    const isig = extractSig(it.description)
    if (sig.dia != null && isig.dia != null && Math.abs(sig.dia - isig.dia) > 0.01) continue
    if (sig.utility && isig.utility && sig.utility !== isig.utility) continue
    if (sig.cat && isig.cat && sig.cat !== isig.cat) continue
    const iTok = tokenize(it.description)
    let overlap = 0
    tt.forEach(t => { if (iTok.has(t)) overlap++ })
    let score = (2 * overlap) / ((tt.size + iTok.size) || 1)
    if (sig.dia != null && isig.dia === sig.dia) score += 0.15
    if (sig.utility && isig.utility === sig.utility) score += 0.1
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore >= 0.34 ? best : -1
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
    const best = matchRow(eng.description, eng.unit, items, usedItems)
    if (best !== -1) {
      usedItems.add(best)
      const ours = items[best]
      // Only compute a % when we actually have a quantity — treating a null
      // takeoff quantity as 0 painted every unquantified match as −100%.
      const pct = eng.quantity && ours.quantity != null
        ? Math.round((ours.quantity - eng.quantity) / eng.quantity * 1000) / 10
        : null
      variance.push({
        engineer_description: eng.description, engineer_quantity: eng.quantity, unit: eng.unit,
        our_description: ours.description, our_quantity: ours.quantity,
        pct_difference: pct,
        status: pct == null ? 'UNQUANTIFIED' : Math.abs(pct) > 5 ? 'VARIANCE' : 'MATCHED',
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
    const best = matchRow(gt.description, gt.unit, items, usedItems)
    if (best !== -1) {
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
  // Only count material line items as "extra" — derived/labor items (trench
  // safety, rock excavation) legitimately aren't in a materials-only ground truth.
  const materialItems = items.filter(it => !it.isDerived && it.category !== 'EXCAVATION' && it.category !== 'TESTING').length
  return {
    truth_rows: total,
    matched,
    within_5: w5,
    within_15: w15,
    mean_abs_pct: pctN ? Math.round(pctSum / pctN * 10) / 10 : null,
    missing_from_ours: missing,                       // in the actual takeoff, not ours
    extra_in_ours: Math.max(0, materialItems - matched), // in ours, not the actual takeoff
    recall_pct: Math.round((matched / total) * 100),  // share of the real takeoff we caught
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

// ── Conservative code-level merge fallbacks ─────────────────────
// Used when a Haiku merge/dedupe reply is truncated or unparseable. Exact-key
// consolidation only: identical description+unit+diameter with the same
// quantity (or one null quantity folding into a quantified sighting) merge;
// anything else is kept. Never sums, never invents.
function codeMerge(items) {
  const groups = new Map()
  for (const it of items) {
    const key = `${normKey(it.description)}|${it.unit}|${it.diameter_in ?? ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(it)
  }
  const out = []
  for (const group of groups.values()) {
    const quantified = group.filter(g => g.quantity != null)
    const nulls = group.filter(g => g.quantity == null)
    if (quantified.length === 0) {
      out.push({ ...group[0], source_ids: [] })
      continue
    }
    // Same quantity sighted in overlap zones → one item. Distinct quantities
    // are distinct runs/segments — keep them all.
    const byQty = new Map()
    for (const g of quantified) {
      const qKey = String(g.quantity)
      if (!byQty.has(qKey)) byQty.set(qKey, { ...g, source_ids: [] })
    }
    out.push(...byQty.values())
    // Null-quantity continuation sightings fold into the group's first
    // quantified entry (they're the same run crossing a tile boundary).
    if (nulls.length && !quantified.length) out.push({ ...nulls[0], source_ids: [] })
  }
  return out
}

// ── Handler ────────────────────────────────────────────────────
// Scoring primitives exported for offline rescoring / diagnostics.
export { buildVariance, varianceMetrics, scoreAgainstTruth, tokenize }

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }
  if (!fnSecretOk(event.headers)) return { statusCode: 401, body: 'Unauthorized' }

  let body
  try { body = JSON.parse(event.body) } catch { return { statusCode: 400, body: 'Invalid JSON' } }
  const { job_id, project_id } = body
  if (!job_id || !project_id) return { statusCode: 400, body: 'Missing fields' }

  // ── Job lock ──────────────────────────────────────────────
  // Two concurrent invocations on one job double-submit every tile (2× spend)
  // and interleave the final delete+insert (doubled line items). The lease is
  // an atomic conditional update: whoever wins the row runs; the loser exits.
  try {
    getSupabase()
    const nowIso = new Date().toISOString()
    const { data: leased, error: leaseErr } = await supabase
      .from('processing_jobs')
      .update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq('id', job_id)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .select('id')
    if (leaseErr) throw new Error(`lease acquire failed: ${leaseErr.message}`)
    if (!leased?.length) {
      console.log(`Job ${job_id}: lease held by another invocation — exiting`)
      return { statusCode: 200 }
    }
  } catch (err) {
    console.error('Lease error:', err)
    await rawJobUpdate(job_id, { stage: 'error', error: `Could not start analysis: ${err.message}` })
    return { statusCode: 200 }
  }

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
    const p6Sheets = sheets.filter(s => GRADE_TYPES.has(s.classification))

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
      const pageText = getPageText(s.page_number - 1)
      const n = pageText.runs.length
      totalRuns += n
      if (n >= 5) sheetsWithText++
      // Detected drawing scale rides in tileContext so the model can sanity-
      // check callout lengths against how long each run is actually drawn.
      s.drawing_scale = detectScale(pageText.runs)?.label || null
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
    const tiers = { pass1: 'opus', pass2: 'opus', pass4: 'opus', pass5: 'haiku', pass6: 'sonnet', pass7: 'haiku', ...(cfg.models || {}) }
    const M = (k) => MODEL_TIERS[tiers[k]] || OPUS

    const TILE_PASSES = [
      { key: 'pass1', name: 'Pass 1 plan quantities', stage: 'analysis_pass_1', sheets: p1Sheets, task: PASS1_TASK, system: brain, model: M('pass1'), validator: validateItems, resultKey: 'items', maxTokens: 8192 },
      { key: 'pass2', name: 'Pass 2 profiles', stage: 'analysis_pass_2', sheets: p2Sheets, task: PASS2_TASK, system: brain, model: M('pass2'), validator: validateRuns, resultKey: 'runs', maxTokens: 8192 },
      { key: 'pass4', name: 'Pass 4 small-dia sweep', stage: 'analysis_pass_4', sheets: p1Sheets, task: PASS4_TASK, system: brain, model: M('pass4'), validator: validateItems, resultKey: 'items', maxTokens: 8192 },
      { key: 'pass5', name: 'Pass 5 engineer tables', stage: 'analysis_pass_5', sheets, task: PASS5_TASK, system: null, model: M('pass5'), validator: validateEngineerTile, resultKey: null, maxTokens: 4096 },
      { key: 'pass6', name: 'Pass 6 grading grades', stage: 'analysis_pass_2', sheets: p6Sheets, task: PASS6_TASK, system: brain, model: M('pass6'), validator: validateGrades, resultKey: 'grades', maxTokens: 4096 },
      { key: 'pass7', name: 'Pass 7 structure schedule', stage: 'analysis_pass_5', sheets, task: PASS7_TASK, system: null, model: M('pass7'), validator: validateSchedule, resultKey: 'structures', maxTokens: 4096 },
    ]
    const sheetsById = new Map(sheets.map(s => [s.id, s]))

    // Batch state persists across chained invocations.
    const state = jobRow?.batch_state || {}
    state.batches = state.batches || {}
    state.resubmits = state.resubmits || {}
    state.usage = state.usage || {}
    for (const tier of ['opus', 'sonnet', 'haiku']) state.usage[tier] = state.usage[tier] || { in: 0, out: 0 }
    state.pollFails = state.pollFails || {}
    state.failedTiles = state.failedTiles || {}
    state.blankSkipped = state.blankSkipped || 0
    state.chains = (state.chains || 0) + 1
    if (state.chains > MAX_CHAINS) throw new Error('Batch processing exceeded the maximum invocation chain — contact support.')
    // batch_state is the resume ledger — a silent write failure here means the
    // next chain forgets submitted batches and re-bills every tile. Fail loudly.
    const persistState = async (extra = {}) => {
      const { error } = await supabase.from('processing_jobs')
        .update({ batch_state: state, lease_until: new Date(Date.now() + LEASE_MS).toISOString(), ...extra })
        .eq('id', job_id)
      if (error) throw new Error(`batch_state persist failed: ${error.message}`)
    }
    await persistState()

    // Chain hand-off: persist state, release the lease, re-invoke. If the
    // re-invocation cannot be confirmed, the job is marked errored (resumable
    // by re-running analysis) instead of silently freezing mid-run.
    const chainToFreshInvocation = async () => {
      await persistState({ lease_until: null })
      const ok = await reinvokeSelf(job_id, project_id)
      if (!ok) {
        await rawJobUpdate(job_id, {
          stage: 'error',
          error: 'Analysis paused and could not resume itself — run the analysis again to continue from where it stopped.',
        })
      }
      return { statusCode: 200 }
    }

    // Page geometry (grid dims + tile bboxes) without rendering — cheap.
    const geomCache = new Map()
    const pageGeomFull = (pageIndex) => {
      if (!geomCache.has(pageIndex)) {
        const page = doc.loadPage(pageIndex)
        const [x0, y0, x1, y1] = page.getBounds()
        page.destroy()
        const pageW = x1 - x0, pageH = y1 - y0
        geomCache.set(pageIndex, { ...gridFor(pageW, pageH), ...tileBBoxes(x0, y0, pageW, pageH) })
      }
      return geomCache.get(pageIndex)
    }
    const pageGeom = (pageIndex) => pageGeomFull(pageIndex)

    // sheet_id → { bboxes:[[x0,y0,x1,y1]...], page:[x0,y0,x1,y1] } for click-to-verify.
    const tileRegionMap = new Map()
    for (const s of p1Sheets) {
      const g = pageGeomFull(s.page_number - 1)
      tileRegionMap.set(s.id, { bboxes: g.bboxes, page: g.page })
    }

    // Rendered tiles, lazily, once per sheet — shared by all passes.
    const tileCache = new Map()
    const sheetTiles = (sheet) => {
      const pageIndex = sheet.page_number - 1
      if (!tileCache.has(pageIndex)) tileCache.set(pageIndex, renderTiles(mupdf, doc, pageIndex))
      return tileCache.get(pageIndex)
    }

    // Done tile keys per pass (from prior invocations / ingested batches).
    // Paginated — the default 1000-row cap made large jobs' tiles look
    // permanently missing, looping resubmits until MAX_CHAINS.
    const loadDone = async () => {
      const done = Object.fromEntries(TILE_PASSES.map(p => [p.key, new Set()]))
      const data = await loadAllTiles(job_id, 'pass, tile_key')
      data.forEach(r => done[r.pass]?.add(r.tile_key))
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

    let done = await loadDone()

    // ── Poll / submit loop ────────────────────────────────────
    while (true) {
      // 1. Poll pending batches; ingest any that ended.
      let processing = 0
      let ingestedAny = false
      for (const passKey of Object.keys(state.batches)) {
        const stillPending = []
        for (const batchId of state.batches[passKey]) {
          let batch
          try { batch = await getBatch(batchId) } catch (e) {
            // A batch ID that permanently 404s (revoked/expired) would block
            // this pass's resubmission forever — abandon it after repeated
            // failures and let the missing-tile scan resubmit the work.
            const fails = (state.pollFails[batchId] || 0) + 1
            state.pollFails[batchId] = fails
            console.error(`poll ${batchId} (fail ${fails}):`, e.message)
            if (fails < MAX_POLL_FAILS) stillPending.push(batchId)
            else console.error(`poll ${batchId}: abandoned after ${fails} failures`)
            continue
          }
          delete state.pollFails[batchId]
          if (batch.processing_status === 'ended') {
            await ingestBatchResults(batch, TILE_PASSES, sheetsById, job_id, state.usage)
            ingestedAny = true
          } else {
            processing += batch.request_counts?.processing ?? 0
            stillPending.push(batchId)
          }
        }
        state.batches[passKey] = stillPending
        if (!stillPending.length) delete state.batches[passKey]
      }
      // Persist immediately after ingesting — a crash between ingest and the
      // next persist re-ingests the batch on resume and double-counts usage.
      if (ingestedAny) await persistState()

      done = await loadDone()
      const { missing, totalTiles, doneTiles } = computeMissing(done)
      const allDone = TILE_PASSES.every(p => missing[p.key].length === 0)
      if (allDone) { await persistState(); break }

      // 2. Submit batches for passes with missing tiles and no pending batch.
      for (const pass of TILE_PASSES) {
        if (missing[pass.key].length === 0 || state.batches[pass.key]?.length) continue
        const resubmits = state.resubmits[pass.key] || 0
        if (resubmits > MAX_RESUBMITS) {
          // Give up on the stragglers — but NEVER silently. The tile identities
          // go into state.failedTiles so the final report can tell the user
          // exactly which sheet areas have no coverage.
          const rows = missing[pass.key].map(w => ({
            job_id, pass: pass.key, tile_key: `${w.sheet.id}_${w.idx}`, result_json: [],
          }))
          state.failedTiles[pass.key] = [
            ...new Set([...(state.failedTiles[pass.key] || []),
              ...missing[pass.key].map(w => `${w.sheet.sheet_number || `pg ${w.sheet.page_number}`}: tile ${w.idx + 1}`)]),
          ]
          for (let i = 0; i < rows.length; i += 100) {
            const { error } = await supabase.from('analysis_tiles')
              .upsert(rows.slice(i, i + 100), { onConflict: 'job_id,pass,tile_key' })
            if (error) throw new Error(`straggler upsert failed: ${error.message}`)
          }
          await persistState()
          continue
        }

        // The render/submit burst can be long on big sets — don't start it if
        // the window is nearly closed; a hard kill mid-burst orphans paid
        // batches whose IDs were never persisted.
        if (Date.now() > chainDeadline) return await chainToFreshInvocation()

        const requests = []
        for (const w of missing[pass.key]) {
          const tiles = sheetTiles(w.sheet)
          const tile = tiles[w.idx]
          if (!tile) continue
          const tile_key = `${w.sheet.id}_${w.idx}`
          // Blank-tile skip: an essentially-empty tile compresses to almost
          // nothing — record an empty result instead of paying for an API call.
          if (tile.pngBytes < BLANK_PNG_BYTES) {
            const { error } = await supabase.from('analysis_tiles')
              .upsert({ job_id, pass: pass.key, tile_key, result_json: [] }, { onConflict: 'job_id,pass,tile_key' })
            if (error) throw new Error(`blank-tile upsert failed: ${error.message}`)
            state.blankSkipped++
            continue
          }
          const embeddedText = getPageText(w.sheet.page_number - 1).runs
            .filter(r => runInTile(r, tile.pageBBox)).map(r => r.text)
          requests.push({
            custom_id: `${pass.key}_${tile_key}`,
            params: {
              model: pass.model,
              max_tokens: pass.maxTokens,
              // No `temperature` — Opus 4.8 / Sonnet 5 deprecated it and 400 if present.
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
          // Persist after EVERY chunk — a crash between submit and persist is
          // an orphaned paid batch the resume ledger knows nothing about.
          await persistState()
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
        stage_detail: `Batched analysis — ${doneTiles}/${totalTiles} tiles done${processing ? `, ${processing} in flight` : ''}${state.blankSkipped ? `, ${state.blankSkipped} blank skipped` : ''}`,
        batch_state: state,
        lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
      })

      // 4. Chain or sleep.
      if (Date.now() > chainDeadline) return await chainToFreshInvocation()
      await sleep(BATCH_POLL_MS)
    }

    // Assembly (merge passes, depth engine, writes) needs its own clean window —
    // starting it with the 15-min kill looming risks dying between the
    // line_items delete and insert, leaving the project with zero items.
    if (Date.now() > chainDeadline - 3 * 60 * 1000) return await chainToFreshInvocation()

    // All tiles done — assemble from persisted scratch.
    const p1Items = await loadPassResults(job_id, 'pass1')
    const p2Raw = await loadPassResults(job_id, 'pass2')
    const p4Items = await loadPassResults(job_id, 'pass4')
    const visionEngineerRows = await loadPassResults(job_id, 'pass5')
    const p6Grades = await loadPassResults(job_id, 'pass6')
    const p7Schedule = await loadPassResults(job_id, 'pass7')
    const runs = dedupeRuns(p2Raw)

    // Finished-grade elevations from the grading plan, keyed by structure id.
    // Prefer an explicit RIM read, then higher confidence, so the best grade
    // wins when the same structure is read on multiple tiles.
    const gradeRank = (g) => (g.kind === 'rim' ? 3 : 0) + (g.confidence === 'HIGH' ? 2 : g.confidence === 'MEDIUM' ? 1 : 0)
    const gradeMap = new Map()
    const gradeBest = new Map()
    for (const g of p6Grades) {
      const k = normKey(g.structure_id)
      if (!k) continue
      const r = gradeRank(g)
      if (!gradeBest.has(k) || r > gradeBest.get(k)) {
        gradeBest.set(k, r)
        gradeMap.set(k, g.finished_grade_elev)
      }
    }

    // Structure schedule (Pass 7): normKey(id) → {rim, invert, depth, type}.
    // The most precise depth source — prefer a row that carries a real depth,
    // then higher confidence, when the same structure is read on multiple tiles.
    const schedRank = (s) => (s.depth_ft != null ? 2 : 0) + (s.confidence === 'HIGH' ? 2 : s.confidence === 'MEDIUM' ? 1 : 0)
    const scheduleMap = new Map()
    const schedBest = new Map()
    for (const s of p7Schedule) {
      const k = normKey(s.structure_id)
      if (!k) continue
      const r = schedRank(s)
      if (!schedBest.has(k) || r > schedBest.get(k)) {
        schedBest.set(k, r)
        scheduleMap.set(k, { rim_elev: s.rim_elev, invert_elev: s.invert_elev, depth_ft: s.depth_ft, type: s.type })
      }
    }

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
    let mergeDegraded = false
    if (p1Items.length > 0) {
      // One giant merge call over hundreds of items overflows even a 16K output
      // budget. So we chunk — but tiles load in arbitrary order, so a naive
      // slice would scatter a run's overlap-zone duplicates across different
      // chunks where the merge can't see them together (silent double-count).
      // Fix: order items so same-(sheet, location) sightings are adjacent, and
      // NEVER split a (sheet, location) group across a chunk boundary.
      const MERGE_CHUNK = 120
      const groupKey = (it) => `${it.sheet_id || ''}|${(it.location || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 50)}`
      const order = p1Items.map((_, i) => i).sort((a, b) => {
        const ka = groupKey(p1Items[a]), kb = groupKey(p1Items[b])
        return ka < kb ? -1 : ka > kb ? 1 : a - b
      })
      const chunks = []
      let cur = []
      for (let k = 0; k < order.length; k++) {
        // Break only when we're past the target size AND at a group change.
        if (cur.length >= MERGE_CHUNK && groupKey(p1Items[order[k]]) !== groupKey(p1Items[order[k - 1]])) {
          chunks.push(cur); cur = []
        }
        cur.push(order[k])
      }
      if (cur.length) chunks.push(cur)

      for (const idxs of chunks) {
        // id = ORIGINAL p1Items index, so merged source_ids still resolve correctly.
        const numbered = idxs.map((idx) => ({ id: idx, sheet: p1Items[idx].sheet_label, tile: p1Items[idx].tile, ...p1Items[idx], sheet_id: undefined }))
        const { text, stop_reason } = await callClaude({
          model: HAIKU, maxTokens: 16384, withMeta: true,
          content: [{ type: 'text', text: `${MERGE_TASK}\n\nITEMS:\n${JSON.stringify(numbered)}` }],
        })
        const chunkMerged = stop_reason === 'max_tokens' ? [] : validateItems(parseJson(text)?.items, 'Pass 3/5 merge')
        if (chunkMerged.length === 0 && idxs.length > 0) {
          // Model merge failed for this chunk → conservative code merge, and
          // the degradation is surfaced in the report instead of hidden.
          console.warn(`Merge chunk (${idxs.length} items): degraded to code merge (stop_reason=${stop_reason})`)
          mergeDegraded = true
          merged.push(...codeMerge(idxs.map((i) => p1Items[i])))
        } else {
          merged.push(...chunkMerged)
        }
      }
      // Re-attach sheet_id from merged source_ids. Only in-range ids count —
      // a hallucinated id must not pin the item to an arbitrary sheet. Also
      // record the tile region the item came from (click-to-verify).
      merged.forEach(m => {
        const src = (m.source_ids || []).map(i => p1Items[i]).find(Boolean)
        m.sheet_id = src?.sheet_id || m.sheet_id || null
        const info = m.sheet_id ? tileRegionMap.get(m.sheet_id) : null
        if (info && src && src.tile_idx != null && info.bboxes[src.tile_idx]) {
          m.region = info.bboxes[src.tile_idx]
          m.region_page = info.page
        }
      })
    }

    // Reconcile plan lengths vs profile lengths. Mismatch >5% becomes a flagged
    // item with both values shown — never silently averaged.
    // Depth stats per run, computed once and reused by the depth engine below.
    runs.forEach(r => { r._stats = depthStats(r, gradeMap, scheduleMap); r._itemIdx = null })

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
      // length_lf must be a real positive length — a model-emitted 0 used to
      // divide by zero and then overwrite a genuine plan quantity with 0 LF.
      if (run.length_lf > 0 && item.quantity != null) {
        const planLf = item.quantity
        const pct = Math.abs(planLf - run.length_lf) / run.length_lf * 100
        if (pct > 5) {
          item.status = 'flagged'
          item.confidence = 'LOW'
          item.quantity = run.length_lf // profile is engineer-dimensioned → primary
          item.note = `LENGTH MISMATCH: plan view shows ${Math.round(planLf)} LF, profile shows ${run.length_lf} LF (${Math.round(pct)}% apart). Profile value used — verify before pricing. ${item.note}`.slice(0, 1000)
          reconciliations.push({ run: run.run_id, plan_lf: planLf, profile_lf: run.length_lf, pct_diff: Math.round(pct) })
        }
      } else if (run.length_lf > 0 && item.quantity == null) {
        item.quantity = run.length_lf
        item.note = `Length taken from profile (${run.run_id}). ${item.note}`.slice(0, 1000)
      }
    }

    // ── PASS 4 dedupe: fold small-diameter sweep into merged set (Haiku) ──
    // p4Items came from the resumable pass4 tiles loaded above.
    await updateJob(job_id, { progress: 92, stage_detail: 'Folding in small-diameter findings' })
    let p4Degraded = false
    if (p4Items.length > 0) {
      const existingBrief = merged.map(m => ({ description: m.description, quantity: m.quantity, unit: m.unit, location: m.location }))
      const candidates = p4Items.map((it, i) => ({ id: i, sheet: it.sheet_label, tile: it.tile, ...it, sheet_id: undefined }))
      const { text, stop_reason } = await callClaude({
        model: HAIKU, maxTokens: 8192, withMeta: true,
        content: [{ type: 'text', text: `${PASS4_DEDUPE_TASK}\n\nEXISTING:\n${JSON.stringify(existingBrief)}\n\nCANDIDATES:\n${JSON.stringify(candidates)}` }],
      })
      const parsed = stop_reason === 'max_tokens' ? null : parseJson(text)
      let fresh
      if (parsed && Array.isArray(parsed.new_items)) {
        fresh = validateItems(parsed.new_items, 'Pass 4/5 dedupe')
      } else {
        // Dedupe reply truncated/unparseable. The old behavior dropped the
        // ENTIRE small-diameter sweep — the pass built specifically because
        // these items were systematically missed. Fall back to code dedupe:
        // consolidate candidates, then drop any whose description already
        // appears in the merged takeoff.
        console.warn(`Pass 4 dedupe degraded to code path (stop_reason=${stop_reason})`)
        p4Degraded = true
        const existingKeys = new Set(merged.map(m => normKey(m.description)))
        fresh = codeMerge(p4Items).filter(f => !existingKeys.has(normKey(f.description)))
          .map(f => ({ ...f, confidence: 'LOW', note: `Possible duplicate — automated dedupe was degraded on this run, verify against main takeoff. ${f.note}`.slice(0, 1000) }))
      }
      fresh.forEach(f => {
        const sid = f.sheet_id || p4Items[0]?.sheet_id || null
        const info = sid ? tileRegionMap.get(sid) : null
        const region = info && f.tile_idx != null && info.bboxes[f.tile_idx] ? info.bboxes[f.tile_idx] : null
        merged.push({
          ...f,
          note: `Found in dedicated small-diameter sweep. ${f.note}`.slice(0, 1000),
          sheet_id: sid, status: 'active',
          ...(region ? { region, region_page: info.page } : {}),
        })
      })
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
    const { depthSummary, derivedItems } = buildDepthEngine(runs, merged, geotech, gradeMap, scheduleMap)

    // Item-level depth from the schedule: STRUCTURE line items that never got a
    // depth via a profile run can still be filled straight from the schedule by
    // matching a structure id in the item's description or location.
    let schedItemDepths = 0
    if (scheduleMap.size) {
      for (const m of merged) {
        if (m.category !== 'STRUCTURE' || m.depth) continue
        const hay = `${m.description || ''} ${m.location || ''}`
        const idMatch = hay.match(/\b([A-Za-z]{1,5}[-\s]?\d{1,4})\b/)
        if (!idMatch) continue
        const sched = structIdLookup(idMatch[1], scheduleMap)
        let d = sched?.depth_ft
        if (d == null && sched && sched.rim_elev != null && sched.invert_elev != null) d = sched.rim_elev - sched.invert_elev
        if (d != null && d >= 0 && d < 100) {
          m.depth = { avg: Math.round(d * 10) / 10, max: Math.round(d * 10) / 10, buckets: null, lf_over_5: null, samples: null, dropped: 0 }
          m.note = `Depth ${m.depth.avg} ft from the structure schedule. ${m.note || ''}`.trim().slice(0, 1000)
          schedItemDepths++
        }
      }
    }
    derivedItems.forEach(d => merged.push(d))

    // ── Material matching: every line item → a catalog material slug ──
    await updateJob(job_id, { progress: 95, stage_detail: 'Matching materials' })
    const { data: materials } = await supabase.from('materials').select('slug, name, aliases_json')
    const matchedSlugs = await matchMaterials(merged, materials || [])
    merged.forEach((m, i) => { m.material_slug = matchedSlugs[i] || null })

    // ── Write results ────────────────────────────────────────
    await updateJob(job_id, { progress: 96, stage_detail: 'Writing line items' })

    // A takeoff with zero items from a non-empty analysis set is a failure,
    // not a result — completing here used to wipe the project's existing
    // line_items and report "0 items" as success.
    if (merged.length === 0 && (p1Sheets.length > 0 || p2Sheets.length > 0)) {
      throw new Error('Analysis produced no line items from a non-empty sheet set — the previous takeoff was left untouched. Re-run the analysis; if this repeats, the sheets may be unreadable at this resolution.')
    }

    // Calibration runs are experiments: they never touch the project's shared
    // line_items or the user's job history — their output lives only in
    // analysis_results, where the Admin calibration table reads it.
    if (!cfg.calibration) {
      const { error: delErr } = await supabase.from('line_items').delete().eq('project_id', project_id)
      if (delErr) throw new Error(`line_items clear failed: ${delErr.message}`)
    }
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
      // Click-to-verify: which sheet + page-space region this item was read from.
      source_sheet_id: m.sheet_id || null,
      region: m.region || null,           // [x0,y0,x1,y1] page points
      region_page: m.region_page || null, // [x0,y0,x1,y1] full page bounds
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

    // ── Scale-aware measurement (beta): vector geometry cross-check ──
    // Per plan sheet, detect scale and measure the longest drawn runs. Compare
    // the total measured pipe-candidate LF to the total extracted pipe LF — a
    // large shortfall hints at runs the model missed on a poorly-labeled sheet.
    let measurement = null
    try {
      const measuredSheets = []
      let measuredLf = 0, sheetsWithScale = 0
      for (const s of p1Sheets) {
        const ms = measureSheet(getPageText(s.page_number - 1).runs, mupdf, doc, s.page_number - 1)
        if (!ms.scale) continue
        sheetsWithScale++
        measuredLf += ms.total_candidate_lf || 0
        measuredSheets.push({
          sheet: s.sheet_number || `pg ${s.page_number}`,
          scale: ms.scale,
          longest_runs_lf: ms.top_runs,
          candidate_runs: ms.candidate_count,
        })
      }
      if (sheetsWithScale > 0) {
        const extractedPipeLf = merged
          .filter(m => m.category === 'PIPE' && (m.unit === 'LF') && m.quantity != null)
          .reduce((sum, m) => sum + m.quantity, 0)
        // Candidate linework includes non-pipe strokes, so measured >> extracted
        // is normal; only a MASSIVE shortfall (extracted < 25% of measured) is a
        // usable signal, and even then it's advisory.
        const shortfall = measuredLf > 0 && extractedPipeLf > 0 && extractedPipeLf < measuredLf * 0.25
        measurement = {
          beta: true,
          sheets: measuredSheets,
          sheets_with_scale: sheetsWithScale,
          extracted_pipe_lf: Math.round(extractedPipeLf),
          measured_candidate_lf: Math.round(measuredLf),
          possible_missed_runs: shortfall,
          note: 'Measured from the PDF vector geometry using the detected drawing scale. Candidate linework includes some non-pipe strokes — treat the longest measured runs as a reference to cross-check your mains, not exact quantities.',
        }
      }
    } catch (e) {
      console.error('measurement failed:', e.message)   // never breaks the run
    }

    // Coverage gaps: tiles that failed all retries. These are the report's
    // loudest caveat — quantities in those sheet areas may simply be missing.
    const failedTiles = [...new Set(Object.values(state.failedTiles || {}).flat())]

    // ── Open clarifications: what the AI caught but couldn't pin down ──
    // Coverage gaps first (whole sheet areas unanalyzed), then depth gaps
    // (they price excavation), then plan/profile mismatches, then
    // low-confidence big-quantity items. Capped so the resolve flow stays
    // approachable — one question at a time in the UI.
    const clarifications = []
    const asked = new Set()
    let cid = 1
    if (failedTiles.length > 0) {
      clarifications.push({
        id: cid++, type: 'coverage', item_no: null,
        question: `${failedTiles.length} sheet area${failedTiles.length === 1 ? '' : 's'} could not be analyzed after multiple retries (${failedTiles.slice(0, 6).join('; ')}${failedTiles.length > 6 ? '; …' : ''}). Quantities there may be missing — re-run the analysis or verify those areas manually. Acknowledge to continue.`,
        context: 'Every failed area is listed in the report quality section. A re-run only re-processes the failed areas, not the whole set.',
      })
    }
    for (const it of items) {
      if (clarifications.length >= 12) break
      if (it.depth_unavailable && !asked.has(it.item_no)) {
        asked.add(it.item_no)
        clarifications.push({
          id: cid++, type: 'depth', item_no: it.item_no,
          question: `Depth for "${it.description}" isn't readable on the plans. What depth (in feet) should we use?`,
          context: 'Not in the structure schedule, no rim on the profile, and no finished grade on the grading plan. Verify in the field — excavation, bedding, and trench safety all price off this number.',
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
          context: 'We checked the structure schedule, the profile (rim − invert), and the grading plan and still couldn\'t pin it down. Grab it from the field.',
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
        key_observations: `Tiled multi-pass analysis of ${sheets.length} sheets (${p1Sheets.length} plan, ${p2Sheets.length} plan-profile). ${failedTiles.length > 0 ? `⚠ COVERAGE GAP: ${failedTiles.length} sheet area(s) could not be analyzed after retries — quantities there may be missing. ` : ''}${textMode === 'raster-only' ? 'RASTER-ONLY (scanned) — no PDF text layer; all quantities are vision reads, treat extractability as lower. ' : `Hybrid extraction: PDF text layer used as ground truth (${totalRuns} text runs). `}${reconciliations.length} plan-vs-profile length mismatch${reconciliations.length === 1 ? '' : 'es'} flagged. ${depthSummary.trench_safety_lf > 0 ? `${depthSummary.trench_safety_lf} LF requires OSHA trench protection (≥${TRENCH_SAFETY_FT} ft).` : ''}${p7Schedule.length > 0 ? ` Structure schedule found (${p7Schedule.length} structures) — used for depths.` : ''}${depthSummary.grade_derived_runs > 0 ? ` ${depthSummary.grade_derived_runs} run${depthSummary.grade_derived_runs === 1 ? '' : 's'} had depth derived from the grading plan (rim not on the profile) — verify.` : ''}${depthSummary.geotech?.rock_excavation_total_lf > 0 ? ` ~${depthSummary.geotech.rock_excavation_total_lf} LF est. rock excavation.` : ''} ${engineerRows.length > 0 ? `Engineer quantity table found — ${variance.length} items compared.` : 'No engineer quantity table found on the analyzed sheets.'}`,
      },
      text_layer: {
        mode: textMode,
        total_runs: totalRuns,
        sheets_with_text: sheetsWithText,
        sheets_total: sheets.length,
        tables_detected: textTables.length,
        table_rows_to_pass5: tableEngineerRows.length,
      },
      // Run-quality caveats — anything that degraded coverage or dedupe on
      // this run. The UI must surface these; silence here reads as "covered
      // everything" when it didn't.
      quality: {
        failed_tiles: failedTiles,
        blank_tiles_skipped: state.blankSkipped || 0,
        merge_degraded: mergeDegraded,
        small_diameter_dedupe_degraded: p4Degraded,
      },
      measurement,
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
        grading_grades: p6Grades.length,
        grade_derived_depths: depthSummary.grade_derived_runs || 0,
        schedule_rows: p7Schedule.length,
        schedule_derived_depths: (depthSummary.schedule_derived_runs || 0) + schedItemDepths,
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

    const { error: resErr } = await supabase.from('analysis_results').insert({ project_id, job_id, result_json: resultJson })
    if (resErr) throw new Error(`analysis_results insert failed: ${resErr.message}`)

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

    // Usage ledger — quota enforcement in the edge functions reads this.
    if (proj?.user_id) {
      await supabase.from('usage_events').insert({
        user_id: proj.user_id,
        kind: 'analysis_job',
        project_id,
        est_usd: resultJson.run_cost.est_usd,
      })
    }

    // Scratch tiles no longer needed once the result is persisted.
    await supabase.from('analysis_tiles').delete().eq('job_id', job_id)
    await updateJob(job_id, {
      stage: 'complete', progress: 100,
      stage_detail: `${items.length} line items — $${resultJson.run_cost.est_usd} API cost${failedTiles.length ? ` — ⚠ ${failedTiles.length} area(s) not analyzed` : ''}`,
      batch_state: { usage: state.usage, chains: state.chains, done: true },
      lease_until: null,
    })
    return { statusCode: 200 }
  } catch (err) {
    console.error('Analysis pipeline error:', err)
    // Raw REST — works even if the supabase-js client is what failed.
    await rawJobUpdate(job_id, { stage: 'error', error: `Analysis failed: ${err.message}`, stage_detail: null, lease_until: null })
    return { statusCode: 200 }
  }
}
