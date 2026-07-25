import { useState, useMemo } from 'react'
import { X, Download, FileText, AlertTriangle, Mail } from 'lucide-react'
import { buildBid, DEFAULT_BID_SETTINGS } from '../utils/bidMath'
import { bidCSV, buildBidHTML } from '../utils/bidExport'
import { printReport } from '../utils/exporters'
import { supabase } from '../utils/supabase'

/**
 * Bid build-up modal: priced takeoff → full bid number, with every
 * assumption editable and a HUMAN GATE before anything can be downloaded.
 * Settings persist per device (localStorage) so a contractor tunes their
 * crew rates once.
 */
const LS_KEY = 'tc_bid_settings'

const GROUPS = [
  { title: 'Labor & Equipment', fields: [
    ['crew_day_cost', 'Crew + equipment $/day'],
    ['prod_shallow_lf', 'Production LF/day (<6 ft)'],
    ['prod_medium_lf', 'Production LF/day (6–10 ft)'],
    ['prod_deep_lf', 'Production LF/day (>10 ft)'],
    ['structure_days', 'Crew-days per structure'],
  ]},
  { title: 'Earthwork', fields: [
    ['trench_width_ft', 'Trench width (ft)'],
    ['excavation_per_cy', 'Excavation $/CY'],
    ['bedding_per_cy', 'Bedding $/CY'],
    ['bedding_depth_ft', 'Bedding depth (ft)'],
    ['trench_safety_per_lf', 'Trench safety $/LF'],
    ['rock_per_lf', 'Rock $/LF'],
  ]},
  { title: 'Adders & Margin', fields: [
    ['waste_pct', 'Material waste %'],
    ['tax_pct', 'Sales tax %'],
    ['mobilization', 'Mobilization $'],
    ['bond_pct', 'Bond %'],
    ['overhead_pct', 'Overhead %'],
    ['profit_pct', 'Profit %'],
  ]},
]

export default function BidBuilder({ open, onClose, result, unitCostOf, meta }) {
  const [settings, setSettings] = useState(() => {
    try { return { ...DEFAULT_BID_SETTINGS, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) } }
    catch { return { ...DEFAULT_BID_SETTINGS } }
  })
  const [approved, setApproved] = useState(false)
  const [sendTo, setSendTo] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendNotice, setSendNotice] = useState(null)   // { kind: 'ok'|'err', text }
  const [txCounty, setTxCounty] = useState(() => { try { return localStorage.getItem('tc_bid_county') || '' } catch { return '' } })
  const [txBusy, setTxBusy] = useState(false)
  const [txData, setTxData] = useState(null)           // /api/txdot-prices response
  const [txErr, setTxErr] = useState(null)

  const loadTxdot = async () => {
    setTxBusy(true); setTxErr(null)
    try {
      try { localStorage.setItem('tc_bid_county', txCounty) } catch { /* private mode */ }
      const { data: { session } } = await supabase.auth.getSession()
      const items = (result?.items || [])
        .filter(it => ['PIPE', 'STRUCTURE', 'EXCAVATION'].includes(String(it.category || '').toUpperCase()))
        .map((it, i) => ({ i, description: it.description, unit: it.unit }))
      const res = await fetch('/api/txdot-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ county: txCounty, items }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `TxDOT lookup failed (${res.status})`)
      setTxData(out)
    } catch (e) {
      setTxErr(e.message)
    } finally {
      setTxBusy(false)
    }
  }

  const bid = useMemo(
    () => (open && result ? buildBid(result, unitCostOf, settings) : null),
    [open, result, unitCostOf, settings],
  )

  if (!open || !bid) return null

  const usd = (v) => `$${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  const setField = (key, raw) => {
    const val = raw === '' ? DEFAULT_BID_SETTINGS[key] : Number(raw)
    if (!Number.isFinite(val) || val < 0) return
    const next = { ...settings, [key]: val }
    setSettings(next)
    setApproved(false)   // any assumption change re-arms the human gate
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }

  const downloadCSV = () => {
    const blob = new Blob([bidCSV(bid, meta)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `bid-${(meta.projectName || 'takeoff').replace(/[^a-z0-9]+/gi, '-')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const SECTIONS = [
    ['Materials', `${bid.materials.priced}/${bid.materials.lines} lines · waste ${settings.waste_pct}% · tax ${settings.tax_pct}%`, bid.materials.total],
    ['Labor & equipment', `${bid.labor.pipe_lf.toLocaleString()} LF (${bid.labor.crew_days} crew-days) + ${bid.labor.structures} structures`, bid.labor.total],
    ['Earthwork', `${bid.earthwork.trench_cy.toLocaleString()} CY trench · ${bid.earthwork.safety_lf.toLocaleString()} LF safety${bid.earthwork.rock_lf ? ` · ${bid.earthwork.rock_lf} LF rock` : ''}`, bid.earthwork.total],
    ['Indirects', `mobilization + bond ${settings.bond_pct}%`, bid.indirects.total],
    ['Overhead', `${settings.overhead_pct}%`, bid.overhead],
    ['Profit', `${settings.profit_pct}%`, bid.profit],
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 760, maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Build Bid — {meta.projectName || 'Takeoff'}</h3>
          <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={onClose}><X size={16} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: '0.76rem', margin: '0 0 14px', lineHeight: 1.5 }}>
          Materials from your pricing, labor from your crew rates, earthwork from the measured depths.
          Every assumption below is yours to edit — nothing downloads until you approve it.
        </p>

        {/* Bid summary */}
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table className="titan-table">
            <tbody>
              {SECTIONS.map(([label, detail, amount]) => (
                <tr key={label}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</td>
                  <td className="text-dim" style={{ fontSize: '0.72rem' }}>{detail}</td>
                  <td className="text-mono" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{usd(amount)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 800, fontSize: '0.95rem' }}>BID TOTAL</td>
                <td />
                <td className="text-mono" style={{ textAlign: 'right', fontWeight: 800, fontSize: '1.05rem', color: 'var(--titan-red)' }}>{usd(bid.bid_total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Warnings — the risk the human is signing off on */}
        {bid.warnings.length > 0 && (
          <div style={{ display: 'flex', gap: 8, border: '1px solid var(--flag-medium)', borderRadius: 4, padding: '9px 12px', marginBottom: 14, fontSize: '0.76rem', lineHeight: 1.6 }}>
            <AlertTriangle size={14} style={{ color: 'var(--flag-medium)', flexShrink: 0, marginTop: 2 }} />
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {bid.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* TxDOT installed-price benchmark */}
        <div style={{ border: '1px solid var(--border, #2a2f3a)', borderRadius: 4, padding: '10px 12px', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>TxDOT Benchmark</span>
            <span className="text-dim" style={{ fontSize: '0.68rem' }}>installed $/unit from winning Texas letting bids, last 24 months</span>
            <span style={{ flex: 1 }} />
            <input
              className="chat-input"
              style={{ width: 130, fontSize: '0.76rem' }}
              placeholder="County (optional)"
              value={txCounty}
              onChange={e => setTxCounty(e.target.value)}
            />
            <button className="btn btn-ghost" disabled={txBusy} onClick={loadTxdot} style={{ fontSize: '0.75rem' }}>
              {txBusy ? 'Loading…' : txData ? 'Reload' : 'Load'}
            </button>
          </div>
          {txErr && <div style={{ color: 'var(--flag-critical, #dc2626)', fontSize: '0.74rem', marginTop: 6 }}>{txErr}</div>}
          {txData && (
            <div style={{ marginTop: 8 }}>
              {txData.trench_safety && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.76rem', marginBottom: 6 }}>
                  <span>Trench protection: TxDOT median <span className="text-mono">${txData.trench_safety.median}</span>/LF ({txData.trench_safety.n.toLocaleString()} bids)</span>
                  <button className="btn btn-ghost" style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                    onClick={() => setField('trench_safety_per_lf', String(txData.trench_safety.median))}>
                    Apply to settings
                  </button>
                </div>
              )}
              {txData.matches?.length ? (
                <div className="table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
                  <table className="titan-table">
                    <thead><tr>{['Takeoff line', 'TxDOT installed (won bids)', 'n'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {txData.matches.map((m, i) => (
                        <tr key={i}>
                          <td style={{ fontSize: '0.76rem' }}>{m.label}</td>
                          <td className="text-mono" style={{ whiteSpace: 'nowrap' }}>
                            ~${m.median.toLocaleString()}/{m.unit}
                            <span className="text-dim" style={{ fontSize: '0.66rem' }}> (${m.low.toLocaleString()}–${m.high.toLocaleString()})</span>
                          </td>
                          <td className="text-mono text-dim">{m.n.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-dim" style={{ fontSize: '0.74rem' }}>No TxDOT items matched this takeoff's lines ({txData.county_used}).</div>
              )}
              <div className="text-dim" style={{ fontSize: '0.66rem', marginTop: 6, lineHeight: 1.5 }}>
                {txData.county_used} · {txData.note}
              </div>
            </div>
          )}
        </div>

        {/* Assumptions */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          {GROUPS.map(g => (
            <div key={g.title}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 6 }}>{g.title}</div>
              {g.fields.map(([key, label]) => (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <label className="text-dim" style={{ fontSize: '0.72rem' }}>{label}</label>
                  <input
                    className="input text-mono"
                    type="number" min="0" step="any"
                    style={{ width: 78, fontSize: '0.78rem' }}
                    value={settings[key]}
                    onChange={e => setField(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Human gate */}
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${approved ? '#1e9e5a' : 'var(--border, #2a2f3a)'}`, borderRadius: 4, marginBottom: 12, cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1.5 }}>
          <input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            I've reviewed the quantities, pricing, assumptions, and warnings above. This is an estimate built from
            an AI takeoff — I'm responsible for verifying it before submitting.
          </span>
        </label>

        {/* Submit by email — same gate as downloads */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, opacity: approved ? 1 : 0.5 }}>
          <input
            className="chat-input"
            style={{ flex: 1 }}
            type="email"
            placeholder="Submit to (owner / GC email — up to 3, comma-separated)"
            value={sendTo}
            onChange={e => setSendTo(e.target.value)}
            disabled={!approved || sendBusy}
          />
          <button
            className="btn btn-secondary"
            disabled={!approved || sendBusy || !sendTo.trim()}
            onClick={async () => {
              setSendBusy(true); setSendNotice(null)
              try {
                const { data: { session } } = await supabase.auth.getSession()
                const res = await fetch('/api/send-bid', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({ to: sendTo, bid, meta }),
                })
                const out = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(out.error || `Send failed (${res.status})`)
                setSendNotice({ kind: 'ok', text: `Bid sent to ${out.sent_to.join(', ')} — replies come to ${meta.email}, and a copy is in your inbox.` })
              } catch (e) {
                setSendNotice({ kind: 'err', text: e.message })
              } finally {
                setSendBusy(false)
              }
            }}
          >
            <Mail size={14} /> {sendBusy ? 'Sending…' : 'Submit Bid'}
          </button>
        </div>
        {sendNotice && (
          <div style={{
            padding: '8px 12px', borderRadius: 4, marginBottom: 10, fontSize: '0.78rem', lineHeight: 1.5,
            border: `1px solid ${sendNotice.kind === 'ok' ? '#1e9e5a' : 'var(--flag-critical, #dc2626)'}`,
            color: sendNotice.kind === 'ok' ? '#1e9e5a' : 'var(--flag-critical, #dc2626)',
          }}>{sendNotice.text}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-secondary" disabled={!approved} onClick={downloadCSV}>
            <Download size={14} /> Bid CSV
          </button>
          <button className="btn btn-primary" disabled={!approved} onClick={() => printReport(buildBidHTML(bid, meta))}>
            <FileText size={14} /> Bid PDF
          </button>
        </div>
      </div>
    </div>
  )
}
