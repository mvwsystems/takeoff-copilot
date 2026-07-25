import { ArrowLeft, Download, Trophy, AlertTriangle } from 'lucide-react'
import { buildComparison, comparisonCSV } from '../utils/quoteCompare'

/**
 * Side-by-side vendor quote analysis for one job.
 *
 * - One column per vendor (newest quote per vendor email).
 * - Per line: each vendor's unit price + extended; cheapest cell highlighted.
 * - Parts-list mismatches called out: lines only one vendor priced, lines
 *   nobody priced, and quantity drift between RFQ snapshots.
 * - Vendor summary cards: total, coverage, line wins, lead time.
 * - Best-mix total = cheapest vendor per line, the theoretical floor.
 */
export default function QuoteCompare({ rfqs, projectName, onBack }) {
  const cmp = buildComparison(rfqs)

  if (!cmp.vendors.length) {
    return (
      <div>
        <button className="btn btn-ghost" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <p className="text-dim" style={{ fontSize: '0.85rem' }}>No submitted quotes yet — the comparison lights up as vendors respond.</p>
      </div>
    )
  }

  const money = (v, frac = 0) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: frac })}`
  const downloadCSV = () => {
    const blob = new Blob([comparisonCSV(cmp)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `quote-comparison-${(projectName || 'takeoff').replace(/[^a-z0-9]+/gi, '-')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const mismatches = cmp.rows.filter(r => r.only_vendor || r.qty_mismatch)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <button className="btn btn-ghost" onClick={onBack}><ArrowLeft size={14} /> Back to RFQs</button>
        <button className="btn btn-secondary" onClick={downloadCSV}><Download size={13} /> CSV</button>
      </div>

      {/* Vendor summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(cmp.vendors.length, 3)}, 1fr)`, gap: 8, marginBottom: 12 }}>
        {cmp.vendors.map(v => {
          const cheapestOverall = cmp.vendors.every(o => o.rfqId === v.rfqId || v.total <= o.total) && v.priced === v.lines
          return (
            <div key={v.rfqId} style={{ border: `1px solid ${cheapestOverall ? '#1e9e5a' : 'var(--border, #2a2f3a)'}`, borderRadius: 5, padding: '10px 12px' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                {v.label}
                {v.wins === Math.max(...cmp.vendors.map(x => x.wins)) && v.wins > 0 && <Trophy size={12} style={{ color: '#f5b301' }} />}
              </div>
              <div className="text-mono" style={{ fontSize: '1.05rem', fontWeight: 600, margin: '3px 0' }}>{money(v.total)}</div>
              <div className="text-dim" style={{ fontSize: '0.68rem', lineHeight: 1.5 }}>
                {v.priced}/{v.lines} lines priced · wins {v.wins}
                {v.priced < v.lines ? <span style={{ color: 'var(--flag-medium)' }}> · incomplete</span> : null}
                {v.lead_time ? <><br />Lead: {v.lead_time}</> : null}
              </div>
            </div>
          )
        })}
      </div>

      {/* Difference callouts */}
      {(mismatches.length > 0 || cmp.unquoted_rows > 0) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', border: '1px solid var(--flag-medium)', borderRadius: 4, padding: '9px 12px', marginBottom: 12, fontSize: '0.76rem', lineHeight: 1.55 }}>
          <AlertTriangle size={14} style={{ color: 'var(--flag-medium)', flexShrink: 0, marginTop: 2 }} />
          <div>
            {cmp.rows.filter(r => r.only_vendor).length > 0 && (
              <div><strong>Parts-list gaps:</strong> {cmp.rows.filter(r => r.only_vendor).length} line{cmp.rows.filter(r => r.only_vendor).length === 1 ? '' : 's'} priced by only one vendor — the others skipped or missed them.</div>
            )}
            {cmp.rows.filter(r => r.qty_mismatch).length > 0 && (
              <div><strong>Quantity drift:</strong> {cmp.rows.filter(r => r.qty_mismatch).length} line{cmp.rows.filter(r => r.qty_mismatch).length === 1 ? '' : 's'} where RFQs carried different quantities (sent from different takeoff versions) — extended prices use the newest quantity.</div>
            )}
            {cmp.unquoted_rows > 0 && (
              <div><strong>Unpriced:</strong> {cmp.unquoted_rows} line{cmp.unquoted_rows === 1 ? '' : 's'} no vendor priced.</div>
            )}
          </div>
        </div>
      )}

      {/* The side-by-side table */}
      <div className="table-wrap" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
        <table className="titan-table">
          <thead>
            <tr>
              <th>Material</th>
              <th style={{ whiteSpace: 'nowrap' }}>Qty</th>
              {cmp.vendors.map(v => <th key={v.rfqId} style={{ whiteSpace: 'nowrap' }}>{v.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {cmp.rows.map((row, i) => (
              <tr key={i}>
                <td style={{ fontSize: '0.78rem' }}>
                  {row.description}
                  {row.qty_mismatch && <span style={{ color: 'var(--flag-medium)', fontSize: '0.68rem' }}> · qty drift: {row.qty_variants.join(' vs ')}</span>}
                  {row.only_vendor && <span style={{ color: 'var(--flag-medium)', fontSize: '0.68rem' }}> · only 1 vendor</span>}
                </td>
                <td className="text-mono text-dim" style={{ whiteSpace: 'nowrap' }}>{row.quantity.toLocaleString()} {row.unit}</td>
                {cmp.vendors.map(v => {
                  const c = row.cells[v.rfqId]
                  const isBest = row.best === v.rfqId && Object.values(row.cells).filter(x => x.unit_price != null).length > 1
                  return (
                    <td key={v.rfqId} className="text-mono" style={{
                      whiteSpace: 'nowrap',
                      color: isBest ? '#1e9e5a' : undefined,
                      fontWeight: isBest ? 700 : undefined,
                    }}>
                      {c?.unit_price != null
                        ? <>{money(c.unit_price, 2)}<span className="text-dim" style={{ fontSize: '0.66rem' }}> /{row.unit || 'unit'} · {money(c.extended)}</span></>
                        : <span className="text-dim">—</span>}
                      {c?.note && <div className="text-dim" style={{ fontSize: '0.64rem', whiteSpace: 'normal' }}>{c.note}</div>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ fontWeight: 700 }}>Total (priced lines)</td>
              <td />
              {cmp.vendors.map(v => (
                <td key={v.rfqId} className="text-mono" style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{money(v.total)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {cmp.vendors.length > 1 && (
        <p style={{ fontSize: '0.78rem', margin: '10px 0 0', lineHeight: 1.5 }}>
          <strong>Best-mix total: <span className="text-mono" style={{ color: '#1e9e5a' }}>{money(cmp.best_mix_total)}</span></strong>
          <span className="text-dim"> — cheapest vendor per line. Verify parts-list gaps above before awarding; a low total on partial coverage isn't a low bid.</span>
        </p>
      )}
    </div>
  )
}
