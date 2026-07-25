// TxDOT installed-price benchmark — real Texas letting data.
//
// Source: TxDOT Bid Tabulations on the Texas Open Data Portal (Socrata SODA
// API, free, refreshed daily from TxDOTCONNECT, rolling ~24 months):
//   https://data.texas.gov/resource/de7b-7dna.json
//
// POST { county?, items: [{ i, description, unit }] }
//  → { county_used, matches: [{ i, label, unit, n, low, median, high }],
//      trench_safety, rows }
//
// WINNING bids only (low_bidder_flag=true). These are INSTALLED unit prices
// (labor + equipment + material) from highway/roadway lettings — a labeled
// reference band for the bid builder, never auto-applied to a bid. Matching
// uses hard gates (utility class + diameter + unit) like the app's other
// matchers, so an 8" waterline can't benchmark against 24" RCP.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SODA = 'https://data.texas.gov/resource/de7b-7dna.json'

// Wet-utility slice of the TxDOT item vocabulary — keeps the query small.
const ITEM_KEYWORDS = [
  'RC PIPE', 'RCP', 'REINF CONC PIPE', 'CONC PIPE', 'STORM',
  'MANHOLE', 'MANH ', 'INLET', 'JUNCTION BOX',
  'TRENCH EXCAVATION PROTECTION',
  'SEWER', 'PVC PIPE', 'WATERLINE', 'WATER LINE', 'DUCTILE',
]

// Signature gates — mirrors the app's matcher philosophy.
const diaOf = (d) => {
  const m = String(d || '').toUpperCase().match(/(\d{1,3}(?:\.\d+)?)\s*-?\s*(?:IN\b|INCH|")/)
  return m ? Number(m[1]) : null
}
const classOf = (d) => {
  const s = String(d || '').toUpperCase()
  if (/TRENCH EXCAVATION PROTECTION|TRENCH SAFETY/.test(s)) return 'trench'
  if (/MANHOLE|\bMANH\b|\bMH\b|SSMH|STMH/.test(s)) return 'mh'
  if (/INLET|CATCH BASIN|JUNCTION BOX/.test(s)) return 'inlet'
  if (/SEWER|\bSAN\b|SANITARY/.test(s) && !/STORM/.test(s)) return 'san'
  if (/WATER ?LINE|\bWTR\b|\bWATER\b|DUCTILE|C900|C905/.test(s)) return 'wtr'
  if (/RC PIPE|RCP|REINF CONC PIPE|CONC PIPE|STORM|CULV/.test(s)) return 'stm'
  if (/PVC PIPE|\bPIPE\b/.test(s)) return 'pipe'
  return null
}
const unitNorm = (u) => {
  const s = String(u || '').toUpperCase().trim()
  if (['LF', 'LIN FT', 'LNFT'].includes(s)) return 'LF'
  if (['EA', 'EACH'].includes(s)) return 'EA'
  return s
}
const sigOf = (desc, unit) => {
  const cls = classOf(desc)
  if (!cls) return null
  // Structures & trench protection match class+unit; pipe requires diameter.
  if (cls === 'mh' || cls === 'inlet' || cls === 'trench') return `${cls}|-|${unitNorm(unit)}`
  const dia = diaOf(desc)
  return dia != null ? `${cls}|${dia}|${unitNorm(unit)}` : null
}
// Sanitary and generic-pipe classes can benchmark against each other; storm
// and water never cross.
const COMPAT = { san: ['san', 'pipe'], pipe: ['pipe', 'san'], stm: ['stm'], wtr: ['wtr'], mh: ['mh'], inlet: ['inlet'], trench: ['trench'] }

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })
  const userClient = createClient(Deno.env.get('VITE_SUPABASE_URL'), Deno.env.get('VITE_SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  let body
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const county = String(body.county || '').replace(/[^a-zA-Z\s'-]/g, '').trim().slice(0, 40)
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 300)
    .filter((it) => it && typeof it.description === 'string')

  // Grouped medians per exact TxDOT item description — small response, and
  // SoQL does the heavy lifting.
  const since = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10)
  const kw = ITEM_KEYWORDS.map((k) => `upper(bid_item_description) like '%${k}%'`).join(' OR ')
  const fetchBands = async (withCounty) => {
    const where = [
      `low_bidder_flag=true`,
      `bid_item_unit_price_amount > 0.01`,
      `project_actual_let_date > '${since}'`,
      `(${kw})`,
      withCounty ? `upper(county)='${county.toUpperCase().replace(/'/g, "''")}'` : null,
    ].filter(Boolean).join(' AND ')
    const url = `${SODA}?$select=bid_item_description,measurement_unit,count(*) as n,median(bid_item_unit_price_amount) as med` +
      `&$where=${encodeURIComponent(where)}` +
      `&$group=bid_item_description,measurement_unit&$limit=5000`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`SODA ${res.status}: ${(await res.text()).slice(0, 160)}`)
    return res.json()
  }

  let rows, countyUsed
  try {
    if (county) {
      rows = await fetchBands(true)
      countyUsed = `${county} County`
      if (!rows.length) { rows = await fetchBands(false); countyUsed = 'statewide (no county data)' }
    } else {
      rows = await fetchBands(false)
      countyUsed = 'statewide'
    }
  } catch (e) {
    console.error('txdot fetch failed:', e.message)
    return json({ error: 'TxDOT data is unavailable right now — try again shortly.' }, 502)
  }

  // Collapse exact-description medians into signature buckets.
  const buckets = new Map()   // sig -> { meds: [{med, n}], n }
  for (const r of rows) {
    const sig = sigOf(r.bid_item_description, r.measurement_unit)
    if (!sig) continue
    const med = Number(r.med), n = Number(r.n) || 0
    if (!Number.isFinite(med) || med <= 0) continue
    if (!buckets.has(sig)) buckets.set(sig, { meds: [], n: 0 })
    const b = buckets.get(sig)
    b.meds.push({ med, n })
    b.n += n
  }
  const bandOf = (sig) => {
    const b = buckets.get(sig)
    if (!b || b.n < 3) return null   // too thin to be a benchmark
    const sorted = b.meds.map((m) => m.med).sort((a, c) => a - c)
    const mid = sorted[Math.floor(sorted.length / 2)]
    return {
      n: b.n,
      low: Math.round(sorted[0] * 100) / 100,
      median: Math.round(mid * 100) / 100,
      high: Math.round(sorted[sorted.length - 1] * 100) / 100,
    }
  }

  // Match the takeoff's items with hard gates.
  const matches = []
  for (const it of items) {
    const cls = classOf(it.description)
    const dia = diaOf(it.description)
    const unit = unitNorm(it.unit)
    if (!cls) continue
    for (const c of COMPAT[cls] || [cls]) {
      const sig = (c === 'mh' || c === 'inlet' || c === 'trench') ? `${c}|-|${unit}` : dia != null ? `${c}|${dia}|${unit}` : null
      const band = sig ? bandOf(sig) : null
      if (band) {
        matches.push({ i: it.i, label: it.description, unit, ...band })
        break
      }
    }
  }

  return json({
    county_used: countyUsed,
    matches,
    trench_safety: bandOf('trench|-|LF'),
    rows: rows.length,
    note: 'TxDOT letting prices — INSTALLED unit costs (labor+equipment+material) from winning highway/roadway bids, last 24 months. Reference band only; private site-civil economics differ.',
  })
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
