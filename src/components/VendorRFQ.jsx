import { useState, useEffect, useCallback } from 'react'
import { X, Star, Plus, Send, Trash2, CheckCircle2, Clock, ChevronDown, ChevronUp, Scale } from 'lucide-react'
import { supabase } from '../utils/supabase'
import { buildRFQItems } from '../utils/exporters'
import QuoteCompare from './QuoteCompare'

/**
 * Send-RFQ modal: the contractor's vendor book + send flow + quote status.
 *
 * - Vendors are reusable contacts; `preferred` pins them (star) and
 *   pre-selects them on every future RFQ.
 * - The message rides inside the RFQ email; replies go straight to the
 *   contractor (Reply-To), and online submissions notify them by email.
 * - Below the send form: every RFQ already sent for this project, with
 *   status (sent / quoted) and an expandable view of returned pricing.
 */
export default function VendorRFQ({ open, onClose, result, materialsMap, projectId, projectName, user }) {
  const [vendors, setVendors] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [message, setMessage] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', company: '', email: '', phone: '' })
  const [rfqs, setRfqs] = useState([])
  const [expandedRfq, setExpandedRfq] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)   // { kind: 'ok'|'err', text }
  const [view, setView] = useState('send')     // 'send' | 'compare'

  const items = open ? buildRFQItems(result, materialsMap) : []

  const load = useCallback(async () => {
    const [{ data: v }, { data: r }] = await Promise.all([
      supabase.from('vendors').select('*').order('preferred', { ascending: false }).order('company'),
      projectId
        ? supabase.from('rfqs').select('id, vendor_snapshot, status, quote_json, items_json, created_at, quoted_at').eq('project_id', projectId).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
    ])
    setVendors(v || [])
    setRfqs(r || [])
    // Preferred vendors come pre-checked — that's what the pin is for.
    setSelected(new Set((v || []).filter(x => x.preferred).map(x => x.id)))
  }, [projectId])

  useEffect(() => {
    if (open) { setNotice(null); setMessage(''); setExpandedRfq(null); setView('send'); load() }
  }, [open, load])

  if (!open) return null

  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const togglePreferred = async (vendor) => {
    await supabase.from('vendors').update({ preferred: !vendor.preferred }).eq('id', vendor.id)
    setVendors(vs => vs.map(v => v.id === vendor.id ? { ...v, preferred: !v.preferred } : v))
  }

  const removeVendor = async (vendor) => {
    if (!window.confirm(`Remove ${vendor.company || vendor.name} from your vendor book?`)) return
    await supabase.from('vendors').delete().eq('id', vendor.id)
    setVendors(vs => vs.filter(v => v.id !== vendor.id))
    setSelected(prev => { const n = new Set(prev); n.delete(vendor.id); return n })
  }

  const saveVendor = async () => {
    const email = draft.email.trim()
    if (!draft.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setNotice({ kind: 'err', text: 'Vendor needs at least a contact name and a valid email.' })
      return
    }
    const { data, error } = await supabase.from('vendors').insert({
      user_id: user.id,
      name: draft.name.trim().slice(0, 120),
      company: draft.company.trim().slice(0, 160) || null,
      email: email.slice(0, 200),
      phone: draft.phone.trim().slice(0, 40) || null,
    }).select().single()
    if (error) { setNotice({ kind: 'err', text: `Could not save vendor: ${error.message}` }); return }
    setVendors(vs => [...vs, data])
    setSelected(prev => new Set([...prev, data.id]))
    setDraft({ name: '', company: '', email: '', phone: '' })
    setAdding(false)
    setNotice(null)
  }

  const sendRFQ = async () => {
    if (!selected.size) { setNotice({ kind: 'err', text: 'Select at least one vendor.' }); return }
    if (!items.length) { setNotice({ kind: 'err', text: 'No purchasable materials on this takeoff.' }); return }
    setBusy(true)
    setNotice(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/send-rfq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          project_id: projectId,
          project_name: projectName,
          vendor_ids: [...selected],
          message,
          items,
        }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Send failed (${res.status})`)
      const failNote = out.failed?.length ? ` (${out.failed.length} failed: ${out.failed.join(', ')})` : ''
      setNotice({ kind: 'ok', text: `RFQ sent to ${out.sent} vendor${out.sent === 1 ? '' : 's'}${failNote}. Replies go to ${user.email}; you'll also get an email when a vendor submits a quote online.` })
      load()
    } catch (e) {
      setNotice({ kind: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const quoteTotal = (rfq) => {
    if (!rfq.quote_json?.lines) return null
    const total = rfq.quote_json.lines.reduce((s, l) => {
      const qty = Number(rfq.items_json?.[l.i]?.quantity) || 0
      return l.unit_price != null ? s + l.unit_price * qty : s
    }, 0)
    return total > 0 ? total : null
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 680, maxHeight: '86vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Send RFQ to Vendors</h3>
          <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={onClose}><X size={16} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: '0.78rem', margin: '0 0 14px', lineHeight: 1.5 }}>
          {items.length} material line{items.length === 1 ? '' : 's'} from this takeoff will be sent for pricing.
          Vendor replies go straight to <span className="text-mono">{user?.email}</span>.
        </p>

        {view === 'compare' ? (
          <QuoteCompare rfqs={rfqs} projectName={projectName} onBack={() => setView('send')} />
        ) : (<>

        {/* ── Vendor book ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>Your Vendors</span>
          <button className="btn btn-ghost" style={{ fontSize: '0.75rem' }} onClick={() => setAdding(a => !a)}>
            <Plus size={13} /> Add vendor
          </button>
        </div>

        {adding && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px', border: '1px solid var(--border, #2a2f3a)', borderRadius: 4, marginBottom: 10 }}>
            <input className="chat-input" placeholder="Contact name *" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
            <input className="chat-input" placeholder="Company (e.g. Core & Main)" value={draft.company} onChange={e => setDraft(d => ({ ...d, company: e.target.value }))} />
            <input className="chat-input" placeholder="Email *" type="email" value={draft.email} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} />
            <input className="chat-input" placeholder="Phone" value={draft.phone} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} />
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveVendor}>Save Vendor</button>
            </div>
          </div>
        )}

        {vendors.length === 0 && !adding && (
          <p className="text-dim" style={{ fontSize: '0.8rem' }}>No vendors yet — add your suppliers once and reuse them on every RFQ.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {vendors.map(v => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border, #2a2f3a)', borderRadius: 4 }}>
              <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleSelect(v.id)} style={{ flexShrink: 0 }} />
              <button
                className="btn btn-ghost" style={{ padding: 2, flexShrink: 0 }}
                title={v.preferred ? 'Preferred — pre-selected on every RFQ' : 'Pin as preferred'}
                onClick={() => togglePreferred(v)}
              >
                <Star size={15} fill={v.preferred ? 'currentColor' : 'none'} style={{ color: v.preferred ? '#f5b301' : 'var(--titan-dim, #667)' }} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.83rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.company || v.name}{v.company ? <span className="text-dim" style={{ fontWeight: 400 }}> — {v.name}</span> : ''}
                </div>
                <div className="text-dim text-mono" style={{ fontSize: '0.7rem' }}>{v.email}{v.phone ? ` · ${v.phone}` : ''}</div>
              </div>
              <button className="btn btn-ghost" style={{ padding: 2, flexShrink: 0 }} title="Remove vendor" onClick={() => removeVendor(v)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        {/* ── Message + send ── */}
        <label style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
          Message to vendors <span className="text-dim" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
        </label>
        <textarea
          className="chat-input"
          style={{ width: '100%', minHeight: 64, resize: 'vertical', marginBottom: 12 }}
          maxLength={2000}
          placeholder={'e.g. "Bid due Friday — need pricing and lead times by Thursday noon. Quote delivered to the Baytown site."'}
          value={message}
          onChange={e => setMessage(e.target.value)}
        />

        {notice && (
          <div style={{
            padding: '9px 12px', borderRadius: 4, marginBottom: 10, fontSize: '0.8rem', lineHeight: 1.5,
            border: `1px solid ${notice.kind === 'ok' ? '#1e9e5a' : 'var(--flag-critical, #dc2626)'}`,
            color: notice.kind === 'ok' ? '#1e9e5a' : 'var(--flag-critical, #dc2626)',
          }}>{notice.text}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: rfqs.length ? 18 : 0 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={busy || !selected.size} onClick={sendRFQ}>
            <Send size={14} /> {busy ? 'Sending…' : `Send RFQ to ${selected.size || '…'} vendor${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>

        {/* ── RFQ history for this project ── */}
        {rfqs.length > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 8px' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>RFQs sent for this job</span>
              {rfqs.some(r => r.status === 'quoted') && (
                <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => setView('compare')}>
                  <Scale size={13} /> Compare Quotes ({rfqs.filter(r => r.status === 'quoted').length})
                </button>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rfqs.map(r => {
                const total = quoteTotal(r)
                const expanded = expandedRfq === r.id
                return (
                  <div key={r.id} style={{ border: '1px solid var(--border, #2a2f3a)', borderRadius: 4 }}>
                    <button
                      className="btn btn-ghost"
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', justifyContent: 'flex-start' }}
                      onClick={() => setExpandedRfq(expanded ? null : r.id)}
                    >
                      {r.status === 'quoted'
                        ? <CheckCircle2 size={15} style={{ color: '#1e9e5a', flexShrink: 0 }} />
                        : <Clock size={15} style={{ color: 'var(--titan-dim, #667)', flexShrink: 0 }} />}
                      <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                        {r.vendor_snapshot?.company || r.vendor_snapshot?.name}
                      </span>
                      <span className="text-dim" style={{ fontSize: '0.72rem' }}>
                        {r.status === 'quoted'
                          ? `QUOTED ${r.quoted_at ? new Date(r.quoted_at).toLocaleDateString() : ''}${total ? ` · ~$${Math.round(total).toLocaleString()}` : ''}`
                          : `sent ${new Date(r.created_at).toLocaleDateString()} — awaiting quote`}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                    </button>
                    {expanded && r.status === 'quoted' && r.quote_json?.lines && (
                      <div style={{ padding: '0 10px 10px' }}>
                        <div className="table-wrap">
                          <table className="titan-table">
                            <thead><tr>{['Material', 'Qty', 'Unit Price', 'Extended'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                            <tbody>
                              {r.quote_json.lines.map((l, i) => {
                                const it = r.items_json?.[l.i]
                                if (!it) return null
                                const ext = l.unit_price != null ? l.unit_price * (Number(it.quantity) || 0) : null
                                return (
                                  <tr key={i}>
                                    <td style={{ fontSize: '0.78rem' }}>{it.description}{l.note ? <span className="text-dim"> — {l.note}</span> : ''}</td>
                                    <td className="text-mono" style={{ whiteSpace: 'nowrap' }}>{Number(it.quantity).toLocaleString()} {it.unit}</td>
                                    <td className="text-mono">{l.unit_price != null ? `$${l.unit_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</td>
                                    <td className="text-mono">{ext != null ? `$${Math.round(ext).toLocaleString()}` : '—'}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        {(r.quote_json.lead_time || r.quote_json.notes) && (
                          <p className="text-dim" style={{ fontSize: '0.74rem', margin: '8px 0 0', lineHeight: 1.5 }}>
                            {r.quote_json.lead_time ? <>Lead time: {r.quote_json.lead_time}. </> : null}
                            {r.quote_json.notes}
                          </p>
                        )}
                      </div>
                    )}
                    {expanded && r.status !== 'quoted' && (
                      <p className="text-dim" style={{ fontSize: '0.76rem', padding: '0 10px 10px', margin: 0 }}>
                        No quote yet. The vendor can reply to the email (goes to {user?.email}) or submit online — you'll be notified either way.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
        </>)}
      </div>
    </div>
  )
}
