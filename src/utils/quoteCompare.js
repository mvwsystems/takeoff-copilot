// Side-by-side vendor quote comparison.
//
// Aligns returned quotes across vendors onto one set of base rows so the
// estimator can see, per material line: who quoted it, at what unit price,
// who's cheapest, and where the parts lists DISAGREE (a vendor skipped a
// line, or quoted against a different quantity snapshot).
//
// Alignment key is normalized description+unit — RFQs sent from the same
// takeoff run share identical item snapshots, so alignment is exact in the
// common case; RFQs sent after a re-run still align wherever the line reads
// the same.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const keyOf = (it) => `${norm(it?.description)}|${norm(it?.unit)}`

/**
 * @param rfqs rows from the rfqs table (any status — non-quoted are ignored)
 * @returns {
 *   vendors: [{ rfqId, label, email, total, priced, lines, wins, lead_time, notes, quoted_at }],
 *   rows:    [{ description, spec, unit, quantity, qty_mismatch, qty_variants,
 *               cells: { [rfqId]: { unit_price, extended, note } }, best, only_vendor }],
 *   best_mix_total,   // cheapest vendor per line, summed
 *   unquoted_rows,    // lines no vendor priced
 * }
 */
export function buildComparison(rfqs) {
  // Newest first; one column per vendor (a re-sent RFQ to the same vendor
  // email keeps only the newest quoted copy).
  const quoted = (rfqs || [])
    .filter((r) => r.status === 'quoted' && Array.isArray(r.quote_json?.lines) && r.quote_json.lines.length)
    .sort((a, b) => new Date(b.quoted_at || b.created_at) - new Date(a.quoted_at || a.created_at))
  const seenVendor = new Set()
  const cols = []
  for (const r of quoted) {
    const email = (r.vendor_snapshot?.email || r.id).toLowerCase()
    if (seenVendor.has(email)) continue
    seenVendor.add(email)
    cols.push(r)
  }
  if (!cols.length) return { vendors: [], rows: [], best_mix_total: 0, unquoted_rows: 0 }

  // Base rows: union of every column's item snapshot, first-seen order.
  const rowByKey = new Map()
  const order = []
  for (const r of cols) {
    for (const it of r.items_json || []) {
      const k = keyOf(it)
      const qty = Number(it.quantity) || 0
      if (!rowByKey.has(k)) {
        rowByKey.set(k, {
          key: k,
          description: it.description,
          spec: it.spec || '',
          unit: it.unit || '',
          quantity: qty,             // canonical qty = newest snapshot's
          qtys: new Set([qty]),
          cells: {},
        })
        order.push(k)
      } else {
        rowByKey.get(k).qtys.add(qty)
      }
    }
  }

  // Drop each vendor's quoted lines onto the aligned rows.
  for (const r of cols) {
    const items = r.items_json || []
    for (const l of r.quote_json.lines) {
      const it = items[l.i]
      if (!it) continue
      const row = rowByKey.get(keyOf(it))
      if (!row) continue
      if (l.unit_price == null && !l.note) continue
      row.cells[r.id] = {
        unit_price: l.unit_price ?? null,
        extended: l.unit_price != null ? l.unit_price * row.quantity : null,
        note: l.note || null,
      }
    }
  }

  const rows = order.map((k) => {
    const row = rowByKey.get(k)
    let best = null
    for (const [rid, c] of Object.entries(row.cells)) {
      if (c.unit_price != null && (best == null || c.unit_price < row.cells[best].unit_price)) best = rid
    }
    const pricedBy = Object.keys(row.cells).filter((rid) => row.cells[rid].unit_price != null)
    return {
      description: row.description,
      spec: row.spec,
      unit: row.unit,
      quantity: row.quantity,
      qty_variants: [...row.qtys],
      qty_mismatch: row.qtys.size > 1,   // RFQ snapshots disagreed on quantity
      cells: row.cells,
      best,
      // Parts-list mismatch: exactly one vendor priced it while others exist.
      only_vendor: cols.length > 1 && pricedBy.length === 1 ? pricedBy[0] : null,
    }
  })

  const vendors = cols.map((r) => {
    const pricedRows = rows.filter((row) => row.cells[r.id]?.unit_price != null)
    return {
      rfqId: r.id,
      label: r.vendor_snapshot?.company || r.vendor_snapshot?.name || 'Vendor',
      email: r.vendor_snapshot?.email || '',
      total: pricedRows.reduce((s, row) => s + row.cells[r.id].unit_price * row.quantity, 0),
      priced: pricedRows.length,
      lines: rows.length,
      wins: rows.filter((row) => row.best === r.id).length,
      lead_time: r.quote_json.lead_time || null,
      notes: r.quote_json.notes || null,
      quoted_at: r.quoted_at || null,
    }
  })

  const best_mix_total = rows.reduce(
    (s, row) => (row.best != null ? s + row.cells[row.best].unit_price * row.quantity : s), 0)

  return {
    vendors,
    rows,
    best_mix_total,
    unquoted_rows: rows.filter((row) => !Object.values(row.cells).some((c) => c.unit_price != null)).length,
  }
}

// CSV of the comparison — one row per material, one price+extended pair per
// vendor, best-mix total at the bottom. Caller handles the download.
export function comparisonCSV(cmp) {
  const q = (v) => {
    const s = String(v ?? '')
    return /^[=+\-@\t\r]/.test(s) || /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ['Material', 'Spec', 'Qty', 'Unit',
    ...cmp.vendors.flatMap((v) => [`${v.label} $/unit`, `${v.label} extended`]), 'Best vendor']
  const lines = [head.map(q).join(',')]
  for (const row of cmp.rows) {
    const cells = cmp.vendors.flatMap((v) => {
      const c = row.cells[v.rfqId]
      return c?.unit_price != null ? [c.unit_price, Math.round(c.extended)] : ['', '']
    })
    const bestLabel = row.best ? (cmp.vendors.find((v) => v.rfqId === row.best)?.label || '') : ''
    lines.push([row.description, row.spec, row.quantity, row.unit, ...cells, bestLabel].map(q).join(','))
  }
  lines.push('')
  for (const v of cmp.vendors) {
    lines.push([`${v.label} total (${v.priced}/${v.lines} lines)`, '', '', '', Math.round(v.total)].map(q).join(','))
  }
  lines.push([`Best-mix total (cheapest vendor per line)`, '', '', '', Math.round(cmp.best_mix_total)].map(q).join(','))
  return lines.join('\n')
}
