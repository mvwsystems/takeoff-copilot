// Bid build-up: turns a priced takeoff into a submittable bid number.
//
// materials (priced lines + waste + tax)
//   + labor & equipment (crew production rates against pipe LF by depth)
//   + earthwork (trench CY, bedding, trench safety, rock — from the depths
//     the pipeline already measured)
//   + indirects (mobilization, bond)
//   → subtotal → overhead → profit → BID TOTAL
//
// Every knob lives in settings with contractor-editable defaults; the math is
// deliberately transparent — each section reports how it got its number so
// the human check can audit line by line. This prices RISK VISIBLY: every
// warning it emits is a dollar amount someone would otherwise eat.

export const DEFAULT_BID_SETTINGS = {
  // Labor & equipment: one installed crew (labor + iron) per working day.
  crew_day_cost: 4800,
  prod_shallow_lf: 300,   // LF/day, depth < 6 ft
  prod_medium_lf: 200,    // 6–10 ft
  prod_deep_lf: 120,      // > 10 ft
  structure_days: 0.5,    // crew-days per structure set
  // Earthwork
  trench_width_ft: 3,
  excavation_per_cy: 8,   // excavate + handle spoil, $/CY (0 = spoil stays onsite free)
  bedding_per_cy: 42,     // stone supplied + placed, $/CY
  bedding_depth_ft: 0.5,
  trench_safety_per_lf: 6,
  rock_per_lf: 85,
  // Materials adders
  waste_pct: 5,
  tax_pct: 8.25,
  // Indirects & margin
  mobilization: 5000,
  bond_pct: 1.5,
  overhead_pct: 10,
  profit_pct: 12,
}

// Materials section covers purchasable lines; EXCAVATION/TESTING derived
// items (trench safety, rock) are priced in the earthwork section instead —
// including them both places would double-count.
const MATERIAL_EXCLUDE = new Set(['EXCAVATION', 'TESTING'])

const r2 = (v) => Math.round(v * 100) / 100
const r0 = (v) => Math.round(v)

/**
 * @param result     analysis result (items + depth_summary + plan_completeness)
 * @param unitCostOf (item) => number|null — the caller's price resolution
 *                   (price book, incl. market fills)
 * @param settings   DEFAULT_BID_SETTINGS overrides
 */
export function buildBid(result, unitCostOf, settings = {}) {
  const s = { ...DEFAULT_BID_SETTINGS, ...settings }
  const items = Array.isArray(result?.items) ? result.items : []
  const warnings = []

  // ── Materials ──
  const matItems = items.filter((it) => !MATERIAL_EXCLUDE.has(String(it.category || '').toUpperCase()))
  const unpriced = []
  let matSubtotal = 0
  let pricedCount = 0
  for (const it of matItems) {
    const c = unitCostOf(it)
    if (c != null && Number.isFinite(Number(it.quantity))) {
      matSubtotal += c * Number(it.quantity)
      pricedCount++
    } else {
      unpriced.push(it.description)
    }
  }
  const waste = matSubtotal * (s.waste_pct / 100)
  const tax = (matSubtotal + waste) * (s.tax_pct / 100)
  const materials = {
    lines: matItems.length,
    priced: pricedCount,
    subtotal: r2(matSubtotal),
    waste: r2(waste),
    tax: r2(tax),
    total: r2(matSubtotal + waste + tax),
    unpriced,
  }
  if (unpriced.length) warnings.push(`${unpriced.length} material line${unpriced.length === 1 ? '' : 's'} unpriced — the bid total is missing that cost.`)

  // ── Labor & equipment: pipe LF through crew production rates ──
  const pipes = items.filter((it) =>
    String(it.category || '').toUpperCase() === 'PIPE' &&
    String(it.unit || '').toUpperCase() === 'LF' &&
    Number.isFinite(Number(it.quantity)))
  let lf = { shallow: 0, medium: 0, deep: 0 }
  let noDepthLf = 0
  for (const p of pipes) {
    const q = Number(p.quantity)
    const d = p.depth_avg
    if (d == null) { lf.medium += q; noDepthLf += q; continue }  // unknown depth → medium, flagged
    if (d < 6) lf.shallow += q
    else if (d <= 10) lf.medium += q
    else lf.deep += q
  }
  const crewDays =
    lf.shallow / Math.max(s.prod_shallow_lf, 1) +
    lf.medium / Math.max(s.prod_medium_lf, 1) +
    lf.deep / Math.max(s.prod_deep_lf, 1)
  const structures = items.filter((it) =>
    String(it.category || '').toUpperCase() === 'STRUCTURE' &&
    Number.isFinite(Number(it.quantity)))
    .reduce((sum, it) => sum + Number(it.quantity), 0)
  const structDays = structures * s.structure_days
  const labor = {
    pipe_lf: r0(lf.shallow + lf.medium + lf.deep),
    lf_by_depth: { shallow: r0(lf.shallow), medium: r0(lf.medium), deep: r0(lf.deep) },
    crew_days: r2(crewDays),
    structures: r0(structures),
    structure_days: r2(structDays),
    total: r2((crewDays + structDays) * s.crew_day_cost),
  }
  if (noDepthLf > 0) warnings.push(`${r0(noDepthLf)} LF of pipe has no depth — assumed 6–10 ft for production rates. Verify before pricing.`)

  // ── Earthwork: derived from the measured depths ──
  let trenchCy = 0
  for (const p of pipes) {
    const q = Number(p.quantity)
    const d = p.depth_avg != null ? p.depth_avg : 5
    trenchCy += (q * s.trench_width_ft * d) / 27
  }
  const beddingCy = (labor.pipe_lf * s.trench_width_ft * s.bedding_depth_ft) / 27
  const safetyLf = Number(result?.depth_summary?.trench_safety_lf) || 0
  const rockLf = Number(result?.depth_summary?.geotech?.rock_excavation_total_lf) || 0
  const earthwork = {
    trench_cy: r0(trenchCy),
    excavation: r2(trenchCy * s.excavation_per_cy),
    bedding_cy: r0(beddingCy),
    bedding: r2(beddingCy * s.bedding_per_cy),
    safety_lf: r0(safetyLf),
    safety: r2(safetyLf * s.trench_safety_per_lf),
    rock_lf: r0(rockLf),
    rock: r2(rockLf * s.rock_per_lf),
  }
  earthwork.total = r2(earthwork.excavation + earthwork.bedding + earthwork.safety + earthwork.rock)
  if (rockLf > 0) warnings.push(`~${r0(rockLf)} LF estimated rock excavation priced at $${s.rock_per_lf}/LF — geotech-derived, verify the rock line.`)

  // ── Indirects, overhead, profit ──
  const direct = materials.total + labor.total + earthwork.total
  const bond = direct * (s.bond_pct / 100)
  const indirects = { mobilization: r2(s.mobilization), bond: r2(bond), total: r2(s.mobilization + bond) }
  const subtotal = direct + indirects.total
  const overhead = subtotal * (s.overhead_pct / 100)
  const profit = (subtotal + overhead) * (s.profit_pct / 100)
  const bid_total = subtotal + overhead + profit

  // Risk context the human gate must see.
  const pc = result?.plan_completeness
  if (pc && pc.grade && pc.grade !== 'A' && pc.grade !== 'B') {
    warnings.push(`Source plans scored ${pc.total}/100 (Grade ${pc.grade}) on completeness — carry contingency for the listed gaps.`)
  }
  const lowConf = items.filter((it) => it.confidence === 'LOW').length
  if (lowConf > 0) warnings.push(`${lowConf} takeoff line${lowConf === 1 ? '' : 's'} are LOW confidence — verify before submitting.`)

  return {
    settings: s,
    materials,
    labor,
    earthwork,
    indirects,
    subtotal: r2(subtotal),
    overhead: r2(overhead),
    profit: r2(profit),
    bid_total: r2(bid_total),
    warnings,
  }
}
