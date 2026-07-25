// Bid package outputs: printable bid document (→ PDF via the print dialog,
// same pattern as the other reports) and a CSV of the full build-up.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))
const usd = (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const q = (v) => {
  const s = String(v ?? '')
  return /^[=+\-@\t\r]/.test(s) || /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function bidCSV(bid, meta = {}) {
  const rows = [
    ['BID SUMMARY', meta.projectName || ''],
    ['Prepared by', meta.company || '', meta.contactName || '', meta.email || ''],
    ['Date', new Date().toLocaleDateString()],
    [],
    ['Section', 'Detail', 'Amount'],
    ['Materials', `${bid.materials.priced}/${bid.materials.lines} lines priced`, bid.materials.subtotal],
    ['', `Waste ${bid.settings.waste_pct}%`, bid.materials.waste],
    ['', `Sales tax ${bid.settings.tax_pct}%`, bid.materials.tax],
    ['Materials total', '', bid.materials.total],
    ['Labor & equipment', `${bid.labor.pipe_lf} LF pipe (${bid.labor.crew_days} crew-days) + ${bid.labor.structures} structures (${bid.labor.structure_days} days) @ ${usd(bid.settings.crew_day_cost)}/day`, bid.labor.total],
    ['Earthwork', `Trench ${bid.earthwork.trench_cy} CY`, bid.earthwork.excavation],
    ['', `Bedding ${bid.earthwork.bedding_cy} CY`, bid.earthwork.bedding],
    ['', `Trench safety ${bid.earthwork.safety_lf} LF`, bid.earthwork.safety],
    ['', `Rock excavation ${bid.earthwork.rock_lf} LF`, bid.earthwork.rock],
    ['Earthwork total', '', bid.earthwork.total],
    ['Indirects', `Mobilization + bond ${bid.settings.bond_pct}%`, bid.indirects.total],
    ['Subtotal', '', bid.subtotal],
    [`Overhead ${bid.settings.overhead_pct}%`, '', bid.overhead],
    [`Profit ${bid.settings.profit_pct}%`, '', bid.profit],
    ['BID TOTAL', '', bid.bid_total],
  ]
  if (bid.warnings.length) {
    rows.push([], ['Warnings'])
    bid.warnings.forEach((w) => rows.push([w]))
  }
  if (bid.materials.unpriced.length) {
    rows.push([], ['Unpriced lines (NOT in this bid)'])
    bid.materials.unpriced.forEach((d) => rows.push([d]))
  }
  return rows.map((r) => r.map(q).join(',')).join('\n')
}

export function buildBidHTML(bid, meta = {}) {
  const line = (label, detail, amount, opts = {}) => `
    <tr>
      <td style="padding:7px 10px;${opts.bold ? 'font-weight:700;' : ''}border-bottom:1px solid #e8ebf2;">${esc(label)}</td>
      <td style="padding:7px 10px;color:#5a6478;font-size:11.5px;border-bottom:1px solid #e8ebf2;">${esc(detail)}</td>
      <td style="padding:7px 10px;text-align:right;font-family:'JetBrains Mono',monospace;${opts.bold ? 'font-weight:700;' : ''}border-bottom:1px solid #e8ebf2;">${amount != null ? usd(amount) : ''}</td>
    </tr>`
  const s = bid.settings
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bid — ${esc(meta.projectName || 'Takeoff')}</title>
<style>@media print { .noprint { display:none } } body{margin:0;background:#fff;}</style></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#0b1220;max-width:820px;margin:0 auto;padding:36px 28px;">
  <div style="border-bottom:4px solid #0057FF;padding-bottom:14px;margin-bottom:22px;display:flex;justify-content:space-between;align-items:flex-end;">
    <div>
      <div style="font-size:24px;font-weight:800;letter-spacing:1px;">BID <span style="color:#0057FF;">PROPOSAL</span></div>
      <div style="font-size:12px;color:#5a6478;margin-top:4px;">${esc(meta.projectName || '')}</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#5a6478;line-height:1.6;">
      ${esc(meta.company || '')}<br>${esc(meta.contactName || '')}${meta.phone ? ` &middot; ${esc(meta.phone)}` : ''}<br>
      ${esc(meta.email || '')}<br>${new Date().toLocaleDateString()}
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="background:#f4f6fa;">
      <th style="text-align:left;padding:8px 10px;font-size:11px;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;">Section</th>
      <th style="text-align:left;padding:8px 10px;font-size:11px;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;">Basis</th>
      <th style="text-align:right;padding:8px 10px;font-size:11px;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
    </tr>
    ${line('Materials', `${bid.materials.priced}/${bid.materials.lines} lines priced · waste ${s.waste_pct}% · tax ${s.tax_pct}%`, bid.materials.total)}
    ${line('Labor & equipment', `${bid.labor.pipe_lf.toLocaleString()} LF pipe (${bid.labor.crew_days} crew-days) + ${bid.labor.structures} structures (${bid.labor.structure_days} days) @ ${usd(s.crew_day_cost)}/day`, bid.labor.total)}
    ${line('Earthwork', `trench ${bid.earthwork.trench_cy.toLocaleString()} CY · bedding ${bid.earthwork.bedding_cy.toLocaleString()} CY · safety ${bid.earthwork.safety_lf.toLocaleString()} LF${bid.earthwork.rock_lf ? ` · rock ${bid.earthwork.rock_lf.toLocaleString()} LF` : ''}`, bid.earthwork.total)}
    ${line('Indirects', `mobilization ${usd(s.mobilization)} · bond ${s.bond_pct}%`, bid.indirects.total)}
    ${line('Subtotal', '', bid.subtotal, { bold: true })}
    ${line(`Overhead (${s.overhead_pct}%)`, '', bid.overhead)}
    ${line(`Profit (${s.profit_pct}%)`, '', bid.profit)}
    <tr>
      <td style="padding:12px 10px;font-size:16px;font-weight:800;">BID TOTAL</td><td></td>
      <td style="padding:12px 10px;text-align:right;font-size:18px;font-weight:800;font-family:'JetBrains Mono',monospace;color:#0057FF;">${usd(bid.bid_total)}</td>
    </tr>
  </table>

  ${bid.materials.unpriced.length ? `
  <div style="margin-top:18px;padding:10px 14px;background:#fff7e6;border:1px solid #e6b800;border-radius:6px;font-size:12px;line-height:1.6;">
    <strong>Excluded — unpriced lines (${bid.materials.unpriced.length}):</strong> ${bid.materials.unpriced.map(esc).join('; ')}
  </div>` : ''}

  ${bid.warnings.length ? `
  <div style="margin-top:12px;font-size:11.5px;color:#5a6478;line-height:1.7;">
    <strong style="color:#0b1220;">Qualifications:</strong>
    <ul style="margin:4px 0 0 18px;padding:0;">${bid.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
  </div>` : ''}

  <div style="margin-top:16px;font-size:11px;color:#8a93a6;line-height:1.7;">
    <strong>Assumptions:</strong> crew ${usd(s.crew_day_cost)}/day · production ${s.prod_shallow_lf}/${s.prod_medium_lf}/${s.prod_deep_lf} LF/day (&lt;6 / 6–10 / &gt;10 ft) ·
    trench width ${s.trench_width_ft} ft · excavation ${usd(s.excavation_per_cy)}/CY · bedding ${usd(s.bedding_per_cy)}/CY ·
    trench safety ${usd(s.trench_safety_per_lf)}/LF · rock ${usd(s.rock_per_lf)}/LF.
    Quantities derived from plan takeoff — verify in the field. Pricing valid 30 days.
  </div>

  <div style="display:flex;gap:40px;margin-top:44px;">
    <div style="flex:1;border-top:1px solid #0b1220;padding-top:6px;font-size:11px;color:#5a6478;">Authorized signature</div>
    <div style="width:160px;border-top:1px solid #0b1220;padding-top:6px;font-size:11px;color:#5a6478;">Date</div>
  </div>
  <div style="margin-top:26px;font-size:10px;color:#b3bac7;text-align:center;">Prepared with Takeoff Copilot // 6 SIGNAL</div>
</body></html>`
}
