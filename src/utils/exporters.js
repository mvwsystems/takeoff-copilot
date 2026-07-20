// Hardened export module — CSV / XLSX / printable HTML reports.
// All CSV cells pass through csvCell (formula-injection safe); all HTML
// interpolations pass through esc(). No external resources, no window.open.

import * as XLSX from 'xlsx'

// ── shared helpers ───────────────────────────────────────────

const arr = (v) => (Array.isArray(v) ? v : [])

const pick = (obj, ...keys) => {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

const safeName = (s) => String(s || 'export').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'export'

const today = () => new Date().toISOString().split('T')[0]

const prettyDate = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

const humanize = (k) => String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const fmtBuckets = (b) => {
  if (b == null) return ''
  if (typeof b === 'string') return b
  if (Array.isArray(b)) return b.map((x) => (typeof x === 'object' && x !== null ? Object.entries(x).map(([k, v]) => `${k}: ${v}`).join(' ') : String(x))).join('; ')
  if (typeof b === 'object') return Object.entries(b).map(([k, v]) => `${k}: ${v}`).join('; ')
  return String(b)
}

const flatVal = (v) => {
  if (v == null) return ''
  if (typeof v === 'object') return fmtBuckets(v)
  return v
}

const isQAResult = (result) =>
  !!(result && (result.estimator_confidence_score || result.executive_risk_summary ||
    Array.isArray(result.quantity_items_to_recheck) || Array.isArray(result.high_risk_misses)))

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// ── CSV ──────────────────────────────────────────────────────

export const csvCell = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '""'
  if (v == null) return '""'
  let s = String(v)
  // formula-injection guard: Excel/Sheets execute cells starting with these
  if (/^[=+\-@]/.test(s.trim())) s = "'" + s
  return '"' + s.replace(/"/g, '""') + '"'
}

const downloadCSV = (rows, filename) => {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  triggerDownload(blob, filename)
}

const depthCell = (item, key) => {
  if (item?.depth_unavailable) return 'N/A'
  const v = item?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : v ?? ''
}

const LINE_ITEM_HEADER = ['Item #', 'Category', 'Description', 'Qty', 'Unit', 'Depth Avg (ft)', 'Depth Max (ft)', 'Confidence', 'Notes']
const PRICED_HEADER = ['Item #', 'Category', 'Description', 'Qty', 'Unit', 'Unit Cost', 'Extended', 'Confidence', 'Notes']

// Price-book keying — MUST match Dashboard.priceKeyOf so exports resolve the
// same unit costs the on-screen estimate shows.
const priceKeyOf = (it) =>
  it?.material_slug ? `mat:${it.material_slug}`
    : `desc:${(it?.description || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`
const unitCostOf = (it, book) => book?.[priceKeyOf(it)]?.unit_cost ?? null
const extendedOf = (it, book) => {
  const c = unitCostOf(it, book)
  return c != null && typeof it?.quantity === 'number' && Number.isFinite(it.quantity) ? c * it.quantity : null
}

const lineItemRow = (it) => [
  it?.item_no ?? '',
  it?.category ?? '',
  it?.description ?? '',
  typeof it?.quantity === 'number' && Number.isFinite(it.quantity) ? it.quantity : it?.quantity ?? '',
  it?.unit ?? '',
  depthCell(it, 'depth_avg'),
  depthCell(it, 'depth_max'),
  it?.confidence ?? '',
  it?.notes ?? '',
]

const pricedItemRow = (it, book) => {
  const c = unitCostOf(it, book)
  const ext = extendedOf(it, book)
  return [
    it?.item_no ?? '',
    it?.category ?? '',
    it?.description ?? '',
    typeof it?.quantity === 'number' && Number.isFinite(it.quantity) ? it.quantity : it?.quantity ?? '',
    it?.unit ?? '',
    c ?? '',
    ext ?? '',
    it?.confidence ?? '',
    it?.notes ?? '',
  ]
}

// Category subtotals + grand total rows for a priced export.
const pricedTotals = (items, book) => {
  const byCat = {}
  let total = 0
  for (const it of items) {
    const ext = extendedOf(it, book)
    if (ext == null) continue
    total += ext
    byCat[it?.category || 'OTHER'] = (byCat[it?.category || 'OTHER'] || 0) + ext
  }
  const rows = [[]]
  Object.entries(byCat).forEach(([cat, sub]) => rows.push(['', '', `${cat} subtotal`, '', '', '', sub, '', '']))
  rows.push(['', '', 'GRAND TOTAL', '', '', '', total, '', ''])
  return rows
}

export const exportTakeoffCSV = (result, meta = {}) => {
  const items = arr(result?.items)
  if (!items.length) return false
  const priced = meta.priced && meta.priceBook
  const rows = []
  rows.push([priced ? 'TAKEOFF COPILOT // PRICED ESTIMATE' : 'TAKEOFF COPILOT // QUANTITY TAKEOFF'])
  rows.push(['File', meta.filename || '—'])
  rows.push(['Generated', today()])
  if (meta.gradeLabel) rows.push(['Plan Grade', meta.gradeLabel, meta.gradeRationale || ''])
  rows.push([])
  rows.push(priced ? PRICED_HEADER : LINE_ITEM_HEADER)
  items.forEach((it) => rows.push(priced ? pricedItemRow(it, meta.priceBook) : lineItemRow(it)))
  if (priced) pricedTotals(items, meta.priceBook).forEach((r) => rows.push(r))
  downloadCSV(rows, `${priced ? 'estimate' : 'takeoff'}_${safeName(meta.filename)}_${today()}.csv`)
  return true
}

export const exportQACSV = (result, meta = {}) => {
  const recheck = arr(result?.quantity_items_to_recheck)
  const gaps = arr(result?.scope_gaps)
  const flags = arr(result?.risk_flags).length ? arr(result?.risk_flags) : arr(result?.high_risk_misses)
  if (!recheck.length && !gaps.length && !flags.length) return false

  const rows = []
  rows.push(['TAKEOFF COPILOT // QA BID RISK REPORT'])
  rows.push(['File', meta.filename || '—'])
  rows.push(['Generated', today()])
  if (meta.gradeLabel) rows.push(['Plan Grade', meta.gradeLabel, meta.gradeRationale || ''])
  rows.push([])
  rows.push(['Section', 'Item', 'Status', 'Risk', 'Estimator Qty', 'Plan Read Qty', 'Note'])

  recheck.forEach((q) => rows.push([
    'RECHECK', q?.item ?? '', q?.qa_status ?? '', q?.risk_level ?? '',
    q?.estimator_quantity ?? '', q?.plan_read_quantity ?? '', q?.note ?? '',
  ]))
  gaps.forEach((g) => rows.push([
    'SCOPE GAP', g?.item ?? '', g?.status ?? '', g?.risk_level ?? '', '', '', g?.note ?? '',
  ]))
  flags.forEach((f) => rows.push([
    'RISK FLAG', f?.item ?? f?.conflict ?? '', f?.status ?? '', f?.risk_level ?? '',
    f?.estimator_quantity ?? '', f?.plan_read_quantity ?? '', f?.note ?? '',
  ]))

  downloadCSV(rows, `qa_report_${safeName(meta.filename)}_${today()}.csv`)
  return true
}

// ── XLSX ─────────────────────────────────────────────────────

const addSheet = (wb, name, aoa, widths) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map(flatVal)))
  if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }))
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
}

const objectTableAOA = (rows) => {
  const keys = []
  rows.forEach((r) => {
    if (r && typeof r === 'object') {
      Object.keys(r).forEach((k) => { if (!keys.includes(k)) keys.push(k) })
    }
  })
  if (!keys.length) return null
  const aoa = [keys.map(humanize)]
  rows.forEach((r) => aoa.push(keys.map((k) => flatVal(r?.[k]))))
  return aoa
}

const depthRunRow = (r) => [
  pick(r, 'run', 'run_id', 'run_label', 'name', 'label') ?? '',
  pick(r, 'utility', 'utility_type', 'system', 'discipline') ?? '',
  pick(r, 'lf', 'LF', 'length_lf', 'total_lf', 'length') ?? '',
  pick(r, 'avg', 'avg_depth_ft', 'depth_avg', 'avg_ft', 'avg_depth') ?? '',
  pick(r, 'max', 'max_depth_ft', 'depth_max', 'max_ft', 'max_depth') ?? '',
  fmtBuckets(pick(r, 'buckets', 'depth_buckets', 'bucket_lf')),
  pick(r, 'lf_ge_5ft', 'lf_over_5ft', 'LF>=5ft', 'lf_5ft_plus', 'lf_deep', 'lf_gte_5') ?? '',
]

const clarificationRow = (c) => [
  pick(c, 'question', 'item', 'text', 'clarification') ?? '',
  pick(c, 'priority', 'risk_level') ?? '',
  c?.status ?? (c?.resolved || pick(c, 'resolution', 'answer', 'response') ? 'RESOLVED' : 'OPEN'),
  pick(c, 'resolution', 'answer', 'response', 'resolution_note') ?? '',
  pick(c, 'context', 'note') ?? '',
]

const qualityRows = (quality) => {
  if (!quality || typeof quality !== 'object') return []
  const rows = []
  const failed = arr(quality.failed_tiles)
  if (failed.length) rows.push(['Failed Tiles', failed.map((t) => (typeof t === 'object' && t !== null ? pick(t, 'tile', 'id', 'label', 'name') ?? fmtBuckets(t) : t)).join('; ')])
  Object.entries(quality).forEach(([k, v]) => {
    if (k === 'failed_tiles') return
    rows.push([humanize(k), flatVal(v)])
  })
  return rows
}

export const exportXLSX = (result, meta = {}) => {
  if (!result || typeof result !== 'object') return false
  const wb = XLSX.utils.book_new()
  let added = false

  if (isQAResult(result)) {
    const conf = result.estimator_confidence_score || {}
    const summary = [
      ['TAKEOFF COPILOT // QA BID RISK REPORT'],
      ['File', meta.filename || '—'],
      ['Generated', today()],
      ['Plan Grade', meta.gradeLabel || '', meta.gradeRationale || ''],
      [],
      ['Confidence Score', conf.score ?? ''],
      ['Grade', conf.grade ?? ''],
      ['Ready to Bid', conf.ready_to_bid === true ? 'YES' : conf.ready_to_bid === false ? 'NO' : ''],
      ['Rationale', conf.rationale ?? ''],
      ['Executive Summary', result.executive_risk_summary ?? ''],
    ]
    addSheet(wb, 'QA Summary', summary, [22, 60, 60])
    added = true

    const recheck = arr(result.quantity_items_to_recheck)
    if (recheck.length) {
      addSheet(wb, 'Recheck Items',
        [['Item', 'Estimator Qty', 'Plan Read Qty', 'QA Status', 'Note'],
          ...recheck.map((q) => [q?.item ?? '', q?.estimator_quantity ?? '', q?.plan_read_quantity ?? '', q?.qa_status ?? '', q?.note ?? ''])],
        [40, 16, 16, 16, 60])
    }
    const misses = arr(result.risk_flags).length ? arr(result.risk_flags) : arr(result.high_risk_misses)
    if (misses.length) {
      addSheet(wb, 'Risk Flags',
        [['Item', 'Risk', 'Estimator Qty', 'Plan Read Qty', 'Note'],
          ...misses.map((m) => [m?.item ?? m?.conflict ?? '', m?.risk_level ?? '', m?.estimator_quantity ?? '', m?.plan_read_quantity ?? '', m?.note ?? ''])],
        [40, 10, 16, 16, 60])
    }
    const gaps = arr(result.scope_gaps)
    if (gaps.length) {
      addSheet(wb, 'Scope Gaps',
        [['Item', 'Status', 'Risk', 'Note'],
          ...gaps.map((g) => [g?.item ?? '', g?.status ?? '', g?.risk_level ?? '', g?.note ?? ''])],
        [34, 12, 10, 60])
    }
    const questions = arr(result.clarification_questions)
    if (questions.length) {
      addSheet(wb, 'Open Items',
        [['Question', 'Priority', 'Status', 'Resolution', 'Context'],
          ...questions.map(clarificationRow)],
        [50, 10, 12, 40, 40])
    }
  } else {
    const items = arr(result.items)
    if (items.length) {
      addSheet(wb, 'Line Items',
        [LINE_ITEM_HEADER, ...items.map(lineItemRow)],
        [8, 12, 46, 10, 8, 14, 14, 12, 55])
      added = true
    }
    // Priced estimate tab — only when a price book is supplied.
    if (items.length && meta.priced && meta.priceBook) {
      addSheet(wb, 'Priced Estimate',
        [PRICED_HEADER, ...items.map((it) => pricedItemRow(it, meta.priceBook)), ...pricedTotals(items, meta.priceBook)],
        [8, 12, 46, 10, 8, 12, 14, 12, 40])
    }
    const runs = arr(result.depth_summary?.runs)
    if (runs.length) {
      addSheet(wb, 'Depth Summary',
        [['Run', 'Utility', 'LF', 'Avg Depth (ft)', 'Max Depth (ft)', 'Buckets', 'LF >= 5 ft'],
          ...runs.map(depthRunRow)],
        [18, 14, 10, 14, 14, 40, 12])
      added = true
    }
    const variance = arr(result.variance_table)
    if (variance.length) {
      const aoa = objectTableAOA(variance)
      if (aoa) {
        addSheet(wb, 'Engineer Variance', aoa, aoa[0].map(() => 22))
        added = true
      }
    }
    const clar = arr(result.clarifications)
    if (clar.length) {
      addSheet(wb, 'Open Items',
        [['Question', 'Priority', 'Status', 'Resolution', 'Context'],
          ...clar.map(clarificationRow)],
        [50, 10, 12, 40, 40])
      added = true
    }
    const qRows = qualityRows(result.quality)
    if (qRows.length) {
      addSheet(wb, 'Run Quality', [['Metric', 'Value'], ...qRows], [24, 80])
      added = true
    }
  }

  if (!added) return false
  const prefix = isQAResult(result) ? 'qa_report' : 'takeoff'
  XLSX.writeFile(wb, `${prefix}_${safeName(meta.filename)}_${today()}.xlsx`)
  return true
}

// ── HTML reports ─────────────────────────────────────────────

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const fmtQty = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : esc(n ?? '—'))

const REPORT_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #F5F5F0; color: #1A1A1A; font-size: 10pt; line-height: 1.55;
  }
  .mono { font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; }
  .page { max-width: 1060px; margin: 0 auto; padding: 0 0 40px; }
  .band {
    background: #0A0A0A; color: #F5F5F0; padding: 28px 40px 22px;
    border-bottom: 4px solid #E8372C;
    display: flex; justify-content: space-between; align-items: flex-end; gap: 24px;
  }
  .brand { font-size: 19pt; font-weight: 800; letter-spacing: 2.5px; text-transform: uppercase; line-height: 1.1; }
  .brand .accent { color: #E8372C; }
  .brand-sub {
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7pt;
    letter-spacing: 2px; text-transform: uppercase; color: #999; margin-top: 4px;
  }
  .band-meta { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; color: #AAA; }
  .band-meta strong { color: #F5F5F0; }
  .grade-badge {
    display: inline-block; margin-top: 6px; padding: 2px 10px; border: 1px solid #E8372C;
    color: #E8372C; font-size: 7.5pt; letter-spacing: 1px; text-transform: uppercase; font-weight: 700;
  }
  .body-pad { padding: 24px 40px 0; }
  .warn-banner {
    background: #FDECEA; border: 1px solid #E8372C; border-left: 5px solid #E8372C;
    padding: 10px 16px; margin-bottom: 20px; font-size: 9pt; color: #7A1C15;
  }
  .warn-banner strong { text-transform: uppercase; letter-spacing: 1px; font-size: 8pt; display: block; margin-bottom: 2px; color: #E8372C; }
  .grade-note { font-size: 8.5pt; color: #555; margin-bottom: 18px; padding: 8px 14px; background: #EDEDE6; border-left: 3px solid #0A0A0A; }
  .stats-row { display: flex; gap: 12px; margin-bottom: 22px; flex-wrap: wrap; }
  .stat {
    flex: 1; min-width: 110px; background: #FFFFFF; border: 1px solid #DDD;
    border-top: 3px solid #E8372C; padding: 10px 14px; text-align: center;
  }
  .stat-val { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16pt; font-weight: 700; color: #0A0A0A; }
  .stat-lbl { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 6.5pt; letter-spacing: 1.5px; text-transform: uppercase; color: #888; margin-top: 2px; }
  .section { margin-bottom: 26px; }
  .section-head {
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.5pt; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase; color: #E8372C;
    padding-bottom: 5px; border-bottom: 2px solid #0A0A0A; margin-bottom: 10px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; background: #FFFFFF; }
  thead th {
    background: #0A0A0A; color: #F5F5F0; padding: 6px 10px; text-align: left;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7pt;
    letter-spacing: 1px; text-transform: uppercase; white-space: nowrap;
  }
  td { padding: 6px 10px; border-bottom: 1px solid #E5E5DE; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #FAFAF6; }
  .qty { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; text-align: right; white-space: nowrap; }
  .num { font-family: ui-monospace, Menlo, Consolas, monospace; text-align: right; white-space: nowrap; }
  .muted { color: #888; }
  .small { font-size: 7.5pt; color: #666; }
  .pill {
    display: inline-block; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 6.5pt;
    font-weight: 700; letter-spacing: 0.5px; padding: 1px 7px; border: 1px solid #BBB; color: #555; white-space: nowrap;
  }
  .pill-red { border-color: #E8372C; color: #E8372C; }
  .pill-dark { border-color: #0A0A0A; color: #0A0A0A; }
  .item-row { padding: 8px 0; border-bottom: 1px solid #E5E5DE; }
  .item-row:last-child { border-bottom: none; }
  .item-title { font-size: 9pt; font-weight: 600; margin-bottom: 2px; }
  .item-note { font-size: 8pt; color: #666; line-height: 1.45; }
  .prose { font-size: 9pt; color: #333; line-height: 1.6; background: #FFFFFF; border: 1px solid #DDD; border-left: 4px solid #E8372C; padding: 12px 16px; }
  .footer {
    margin-top: 34px; padding: 12px 0 0; border-top: 2px solid #0A0A0A;
    display: flex; justify-content: space-between; gap: 16px;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.5pt; color: #888;
  }
  .disclaimer { color: #E8372C; font-weight: 700; }
  @media print {
    body { background: #FFFFFF; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { max-width: none; padding-bottom: 16px; }
    .band { padding: 20px 24px 16px; }
    .body-pad { padding: 18px 24px 0; }
    .section { break-inside: avoid-page; page-break-inside: avoid; }
    .section-long { break-inside: auto; page-break-inside: auto; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    thead { display: table-header-group; }
    @page { margin: 12mm; }
  }
`

const reportShell = (title, subtitle, meta, bodyHtml) => {
  const grade = meta.gradeLabel
    ? `<div class="grade-badge">Plan Grade // ${esc(meta.gradeLabel)}</div>`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="page">
  <div class="band">
    <div>
      <div class="brand">TAKEOFF <span class="accent">COPILOT</span></div>
      <div class="brand-sub">${esc(subtitle)}</div>
      ${grade}
    </div>
    <div class="band-meta">
      <div><strong>${esc(meta.filename || '—')}</strong></div>
      <div>${esc(prettyDate())}</div>
      <div>takeoffcopilot.com</div>
    </div>
  </div>
  <div class="body-pad">
    ${meta.gradeRationale ? `<div class="grade-note">${esc(meta.gradeRationale)}</div>` : ''}
    ${bodyHtml}
    <div class="footer">
      <span>Generated by Takeoff Copilot</span>
      <span class="disclaimer">AI-generated. Verify all quantities before pricing.</span>
      <span>${esc(prettyDate())}</span>
    </div>
  </div>
</div>
</body>
</html>`
}

const qualityBannerHTML = (result) => {
  const failed = arr(result?.quality?.failed_tiles)
  const rasterOnly = result?.text_layer?.mode === 'raster-only'
  if (!failed.length && !rasterOnly) return ''
  const parts = []
  if (failed.length) parts.push(`${failed.length} tile${failed.length === 1 ? '' : 's'} failed analysis — coverage is incomplete and quantities in those areas may be missing.`)
  if (rasterOnly) parts.push('No text layer was available (raster-only read) — callouts were read visually and are more error-prone.')
  return `<div class="warn-banner"><strong>Coverage Warning</strong>${esc(parts.join(' '))}</div>`
}

const statsRowHTML = (stats) => {
  const cells = stats
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([lbl, v]) => `<div class="stat"><div class="stat-val">${fmtQty(v)}</div><div class="stat-lbl">${esc(lbl)}</div></div>`)
    .join('')
  return cells ? `<div class="stats-row">${cells}</div>` : ''
}

const tableSection = (title, headers, rowsHtml, long = false) => {
  if (!rowsHtml) return ''
  return `<div class="section${long ? ' section-long' : ''}">
    <div class="section-head">${esc(title)}</div>
    <table>
      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`
}

const listSection = (title, itemsHtml) => (itemsHtml
  ? `<div class="section"><div class="section-head">${esc(title)}</div>${itemsHtml}</div>`
  : '')

const clarificationsHTML = (clarifications) => arr(clarifications).map((c) => {
  const row = clarificationRow(c)
  const [question, priority, status, resolution, context] = row
  return `<div class="item-row">
    <div class="item-title">
      <span class="pill ${status === 'RESOLVED' ? 'pill-dark' : 'pill-red'}">${esc(status)}</span>
      ${priority ? `<span class="pill">${esc(priority)}</span>` : ''}
      ${esc(question)}
    </div>
    ${resolution ? `<div class="item-note"><strong>Resolution:</strong> ${esc(resolution)}</div>` : ''}
    ${context ? `<div class="item-note">${esc(context)}</div>` : ''}
  </div>`
}).join('')

export const buildTakeoffReportHTML = (result, meta = {}) => {
  const items = arr(result?.items)
  const summary = result?.summary || {}
  const countBy = (level) => items.filter((it) => it?.confidence === level).length

  const stats = statsRowHTML([
    ['Line Items', summary.total_items ?? items.length],
    ['High Conf', summary.high_confidence_count ?? countBy('HIGH')],
    ['Medium Conf', summary.medium_confidence_count ?? countBy('MEDIUM')],
    ['Low Conf', summary.low_confidence_count ?? countBy('LOW')],
    ['Depth Runs', arr(result?.depth_summary?.runs).length || undefined],
  ])

  const itemRows = items.map((it) => `<tr>
    <td class="num muted">${esc(it?.item_no ?? '')}</td>
    <td><span class="pill">${esc(it?.category ?? '')}</span></td>
    <td>${esc(it?.description ?? '')}</td>
    <td class="qty">${fmtQty(it?.quantity)}</td>
    <td class="num">${esc(it?.unit ?? '')}</td>
    <td class="num">${esc(depthCell(it, 'depth_avg'))}</td>
    <td class="num">${esc(depthCell(it, 'depth_max'))}</td>
    <td><span class="pill ${it?.confidence === 'LOW' ? 'pill-red' : it?.confidence === 'HIGH' ? 'pill-dark' : ''}">${esc(it?.confidence ?? '')}</span></td>
    <td class="small">${esc(it?.notes ?? '')}</td>
  </tr>`).join('')

  const depthRows = arr(result?.depth_summary?.runs).map((r) => {
    const [run, utility, lf, avg, max, buckets, lfDeep] = depthRunRow(r)
    return `<tr>
      <td>${esc(run)}</td>
      <td>${esc(utility)}</td>
      <td class="qty">${fmtQty(lf)}</td>
      <td class="num">${esc(avg)}</td>
      <td class="num">${esc(max)}</td>
      <td class="small">${esc(buckets)}</td>
      <td class="qty">${fmtQty(lfDeep)}</td>
    </tr>`
  }).join('')

  let varianceSection = ''
  const variance = arr(result?.variance_table)
  if (variance.length) {
    const aoa = objectTableAOA(variance)
    if (aoa) {
      const [headers, ...rows] = aoa
      varianceSection = tableSection('Engineer Variance', headers,
        rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join(''))
    }
  }

  const rm = result?.risk_and_misses || {}
  const scopeGapRows = arr(rm.scope_gaps).map((g) => `<div class="item-row">
    <div class="item-title"><span class="pill ${g?.status === 'MISSING' ? 'pill-red' : ''}">${esc(g?.status ?? '')}</span> ${esc(g?.item ?? '')}</div>
    ${g?.note ? `<div class="item-note">${esc(g.note)}</div>` : ''}
  </div>`).join('')

  const riskSections = [
    rm.top_risks ? `<div class="section"><div class="section-head">Top Risks</div><div class="prose">${esc(rm.top_risks)}</div></div>` : '',
    listSection('Commonly Missed Scope', scopeGapRows),
    rm.geotech?.geotech_flags ? `<div class="section"><div class="section-head">Geotech Flags</div><div class="prose">${esc(rm.geotech.geotech_flags)}</div></div>` : '',
  ].join('')

  const body = [
    qualityBannerHTML(result),
    stats,
    summary.key_observations ? `<div class="section"><div class="section-head">Key Observations</div><div class="prose">${esc(summary.key_observations)}</div></div>` : '',
    tableSection(`Quantity Takeoff — ${items.length} Items`,
      ['#', 'Category', 'Description', 'Qty', 'Unit', 'Depth Avg (ft)', 'Depth Max (ft)', 'Conf', 'Notes'], itemRows, true),
    tableSection('Depth Summary',
      ['Run', 'Utility', 'LF', 'Avg (ft)', 'Max (ft)', 'Buckets', 'LF >= 5 ft'], depthRows),
    varianceSection,
    listSection('Open Items // Clarifications', clarificationsHTML(result?.clarifications)),
    riskSections,
  ].join('')

  return reportShell('Takeoff Copilot — Quantity Report', 'Quantity Takeoff Report', meta, body)
}

export const buildQAReportHTML = (result, meta = {}) => {
  const conf = result?.estimator_confidence_score || {}

  const stats = statsRowHTML([
    ['Confidence Score', conf.score],
    ['Grade', conf.grade],
    ['Ready to Bid', conf.ready_to_bid === true ? 'YES' : conf.ready_to_bid === false ? 'NO' : undefined],
    ['Recheck Items', arr(result?.quantity_items_to_recheck).length || undefined],
    ['Scope Gaps', arr(result?.scope_gaps).filter((g) => g?.status === 'MISSING').length || undefined],
  ])

  const misses = arr(result?.risk_flags).length ? arr(result?.risk_flags) : arr(result?.high_risk_misses)
  const missRows = misses.map((m) => `<tr>
    <td><span class="pill ${m?.risk_level === 'HIGH' ? 'pill-red' : ''}">${esc(m?.risk_level ?? '')}</span></td>
    <td>${esc(m?.item ?? m?.conflict ?? '')}</td>
    <td class="num muted">${esc(m?.estimator_quantity ?? '—')}</td>
    <td class="num">${esc(m?.plan_read_quantity ?? '—')}</td>
    <td class="small">${esc(m?.note ?? '')}</td>
  </tr>`).join('')

  const recheckRows = arr(result?.quantity_items_to_recheck).map((q) => `<tr>
    <td><span class="pill ${q?.qa_status === 'CONFIRMED' ? 'pill-dark' : 'pill-red'}">${esc(q?.qa_status ?? '')}</span></td>
    <td>${esc(q?.item ?? '')}</td>
    <td class="num muted">${esc(q?.estimator_quantity ?? '—')}</td>
    <td class="num">${esc(q?.plan_read_quantity ?? '—')}</td>
    <td class="small">${esc(q?.note ?? '')}</td>
  </tr>`).join('')

  const gapRows = arr(result?.scope_gaps).map((g) => `<div class="item-row">
    <div class="item-title">
      <span class="pill ${g?.status === 'MISSING' ? 'pill-red' : g?.status === 'PRESENT' ? 'pill-dark' : ''}">${esc(g?.status ?? '')}</span>
      ${g?.risk_level ? `<span class="pill">${esc(g.risk_level)}</span>` : ''}
      ${esc(g?.item ?? '')}
    </div>
    ${g?.note ? `<div class="item-note">${esc(g.note)}</div>` : ''}
  </div>`).join('')

  const conflictRows = arr(result?.geotech_and_plan_conflicts).map((c) => `<div class="item-row">
    <div class="item-title"><span class="pill ${c?.risk_level === 'HIGH' ? 'pill-red' : ''}">${esc(c?.risk_level ?? '')}</span> ${esc(c?.conflict ?? '')}</div>
    <div class="item-note"><strong>Geotech:</strong> ${esc(c?.geotech_finding ?? '')} &nbsp;|&nbsp; <strong>Takeoff:</strong> ${esc(c?.estimator_response ?? '')}</div>
    ${c?.note ? `<div class="item-note">${esc(c.note)}</div>` : ''}
  </div>`).join('')

  const assumptionRows = arr(result?.assumptions_needing_approval).map((a) => `<div class="item-row">
    <div class="item-title">${esc(a?.assumption ?? '')}</div>
    ${a?.risk_if_wrong ? `<div class="item-note"><strong>Risk if wrong:</strong> ${esc(a.risk_if_wrong)}</div>` : ''}
    ${a?.recommended_action ? `<div class="item-note"><strong>Action:</strong> ${esc(a.recommended_action)}</div>` : ''}
  </div>`).join('')

  const bidNotes = arr(result?.recommended_bid_notes).map((n) => `<div class="item-row"><div class="item-note">${esc(n)}</div></div>`).join('')

  const body = [
    qualityBannerHTML(result),
    stats,
    result?.executive_risk_summary ? `<div class="section"><div class="section-head">Executive Risk Summary</div><div class="prose">${esc(result.executive_risk_summary)}</div></div>` : '',
    conf.rationale ? `<div class="section"><div class="section-head">Confidence Rationale</div><div class="prose">${esc(conf.rationale)}</div></div>` : '',
    tableSection(`High Risk Misses — ${misses.length} Flagged`,
      ['Risk', 'Item', 'Estimator Had', 'Plan Shows', 'Notes'], missRows),
    tableSection(`Quantity Items to Recheck — ${arr(result?.quantity_items_to_recheck).length} Flagged`,
      ['Status', 'Item', 'Estimator Had', 'Plan Shows', 'Notes'], recheckRows, true),
    listSection('Scope Gaps', gapRows),
    listSection('Geotech & Plan Conflicts', conflictRows),
    listSection('Clarification Questions', clarificationsHTML(result?.clarification_questions || result?.clarifications)),
    listSection('Assumptions Needing Approval', assumptionRows),
    listSection('Recommended Bid Notes & Exclusions', bidNotes),
  ].join('')

  return reportShell('Takeoff Copilot — QA Bid Risk Report', 'QA // Bid Risk Analysis', meta, body)
}

// ── printing ─────────────────────────────────────────────────

export const printReport = (html) => {
  if (!html || typeof document === 'undefined') return false
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'

  let removed = false
  let timer = null
  const cleanup = () => {
    if (removed) return
    removed = true
    if (timer) clearTimeout(timer)
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
  }
  // afterprint is unreliable in some browsers; 60s fallback guarantees removal
  timer = setTimeout(cleanup, 60000)

  iframe.addEventListener('load', () => {
    const win = iframe.contentWindow
    if (!win) {
      cleanup()
      return
    }
    win.addEventListener('afterprint', () => setTimeout(cleanup, 100))
    // brief delay lets fonts/layout settle before the print snapshot
    setTimeout(() => {
      try {
        win.focus()
        win.print()
      } catch {
        cleanup()
      }
    }, 50)
  })

  iframe.srcdoc = html
  document.body.appendChild(iframe)
  return true
}
