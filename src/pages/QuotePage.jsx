import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'

/**
 * Public vendor quote page — /quote/:token. No login; the token is the key.
 * Light-themed and self-contained: vendors are external visitors, not users.
 * Vendor enters unit prices (extended + total compute live), lead time, and
 * notes; submit stores the quote and notifies the contractor by email.
 */
const S = {
  page: { minHeight: '100vh', background: '#f4f6fa', fontFamily: "'Outfit', Arial, sans-serif", color: '#0b1220', padding: '32px 14px' },
  card: { maxWidth: 760, margin: '0 auto', background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 14px rgba(11,18,32,0.08)' },
  head: { background: '#0057FF', padding: '22px 28px', color: '#fff' },
  body: { padding: '26px 28px' },
  th: { textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#5a6478', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '2px solid #e8ebf2', background: '#f8fafd' },
  td: { padding: '8px 10px', fontSize: 13.5, borderBottom: '1px solid #eef1f6', verticalAlign: 'middle' },
  input: { width: 110, padding: '7px 9px', fontSize: 13.5, border: '1px solid #cdd5e1', borderRadius: 5, fontFamily: "'JetBrains Mono', monospace" },
  textin: { width: '100%', padding: '9px 11px', fontSize: 13.5, border: '1px solid #cdd5e1', borderRadius: 5, boxSizing: 'border-box' },
  btn: { background: '#0057FF', color: '#fff', border: 'none', borderRadius: 6, padding: '13px 30px', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
}

export default function QuotePage() {
  const { token } = useParams()
  const [rfq, setRfq] = useState(null)
  const [error, setError] = useState(null)
  const [prices, setPrices] = useState({})    // i -> string
  const [notes, setNotes] = useState('')
  const [leadTime, setLeadTime] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch(`/api/quote-rfq?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const out = await r.json()
        if (!r.ok) throw new Error(out.error || 'Could not load this quote request.')
        setRfq(out)
        // Prefill when revising a previously-submitted quote.
        if (out.quote?.lines) {
          const p = {}
          out.quote.lines.forEach(l => { if (l.unit_price != null) p[l.i] = String(l.unit_price) })
          setPrices(p)
          setNotes(out.quote.notes || '')
          setLeadTime(out.quote.lead_time || '')
        }
      })
      .catch((e) => setError(e.message))
  }, [token])

  const total = rfq ? rfq.items.reduce((s, it, i) => {
    const p = Number(prices[i])
    return Number.isFinite(p) && p > 0 ? s + p * (Number(it.quantity) || 0) : s
  }, 0) : 0

  const submit = async () => {
    const lines = Object.entries(prices)
      .map(([i, v]) => ({ i: Number(i), unit_price: v === '' ? null : Number(v) }))
      .filter(l => l.unit_price != null && Number.isFinite(l.unit_price) && l.unit_price >= 0)
    if (!lines.length) { setError('Enter at least one unit price.'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/quote-rfq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, lines, notes, lead_time: leadTime }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || 'Submission failed — try again.')
      setDone(true)
      window.scrollTo(0, 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !rfq) {
    return <div style={S.page}><div style={{ ...S.card, ...S.body, textAlign: 'center' }}>
      <h2 style={{ marginTop: 0 }}>Quote link problem</h2>
      <p style={{ color: '#5a6478' }}>{error}</p>
    </div></div>
  }
  if (!rfq) {
    return <div style={S.page}><div style={{ ...S.card, ...S.body, textAlign: 'center', color: '#5a6478' }}>Loading quote request…</div></div>
  }

  const contractorLabel = [rfq.contractor?.name, rfq.contractor?.company && `(${rfq.contractor.company})`].filter(Boolean).join(' ')

  return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={S.head}>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '1px' }}>REQUEST FOR QUOTE</div>
          <div style={{ fontSize: 12.5, color: '#cfe0ff', marginTop: 3 }}>
            {rfq.project_name} — requested by {contractorLabel || 'a Takeoff Copilot contractor'}
          </div>
        </div>
        <div style={S.body}>
          {done ? (
            <div style={{ textAlign: 'center', padding: '28px 0' }}>
              <div style={{ fontSize: 40 }}>✅</div>
              <h2 style={{ margin: '8px 0 6px' }}>Quote submitted</h2>
              <p style={{ color: '#5a6478', margin: 0, lineHeight: 1.6 }}>
                {contractorLabel || 'The contractor'} has been notified for <strong>{rfq.project_name}</strong>.<br />
                Need to revise? Reopen this link any time and resubmit.
              </p>
            </div>
          ) : (
            <>
              {rfq.status === 'quoted' && (
                <p style={{ background: '#f0f5ff', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#0b1220', marginTop: 0 }}>
                  You already submitted a quote — updating the prices below and resubmitting will replace it.
                </p>
              )}
              {rfq.message && (
                <p style={{ background: '#f8fafd', borderLeft: '3px solid #0057FF', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.6, color: '#33405a', marginTop: 0 }}>
                  “{rfq.message}”
                </p>
              )}
              <p style={{ fontSize: 13.5, color: '#5a6478', lineHeight: 1.6 }}>
                Enter your unit pricing below ({rfq.items.length} lines). Leave a line blank if you don't carry it.
                Quantities are estimated from plans — verify before fabrication.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={S.th}>Material</th>
                    <th style={S.th}>Spec</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Qty</th>
                    <th style={S.th}>Unit Price ($)</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Extended</th>
                  </tr></thead>
                  <tbody>
                    {rfq.items.map((it, i) => {
                      const p = Number(prices[i])
                      const ext = Number.isFinite(p) && p > 0 ? p * (Number(it.quantity) || 0) : null
                      return (
                        <tr key={i}>
                          <td style={S.td}>{it.description}</td>
                          <td style={{ ...S.td, fontSize: 12, color: '#5a6478' }}>{it.spec}</td>
                          <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
                            {Number(it.quantity).toLocaleString()} {it.unit}
                          </td>
                          <td style={S.td}>
                            <input
                              style={S.input} type="number" min="0" step="0.01" placeholder="0.00"
                              value={prices[i] ?? ''}
                              onChange={e => setPrices(prev => ({ ...prev, [i]: e.target.value }))}
                            />
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                            {ext != null ? `$${ext.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  {total > 0 && (
                    <tfoot><tr>
                      <td colSpan={4} style={{ ...S.td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }}>Quoted total</td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", borderBottom: 'none' }}>
                        ${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                    </tr></tfoot>
                  )}
                </table>
              </div>
              <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#33405a', display: 'block', marginBottom: 5 }}>Lead time</label>
                  <input style={S.textin} maxLength={200} placeholder="e.g. RCP 3 weeks, everything else in stock" value={leadTime} onChange={e => setLeadTime(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#33405a', display: 'block', marginBottom: 5 }}>Notes / substitutions</label>
                  <textarea style={{ ...S.textin, minHeight: 70, resize: 'vertical' }} maxLength={2000} placeholder="Substitutions, freight, quote validity, payment terms…" value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
              </div>
              {error && <p style={{ color: '#c62828', fontSize: 13.5 }}>{error}</p>}
              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
                  {busy ? 'Submitting…' : rfq.status === 'quoted' ? 'Update Quote' : 'Submit Quote'}
                </button>
                <p style={{ fontSize: 12, color: '#8a93a6', marginTop: 10 }}>
                  Prefer email? Just reply to the RFQ email — it goes straight to {contractorLabel || 'the contractor'}.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <p style={{ textAlign: 'center', fontSize: 11.5, color: '#8a93a6', marginTop: 14 }}>
        Powered by Takeoff Copilot // 6 SIGNAL
      </p>
    </div>
  )
}
