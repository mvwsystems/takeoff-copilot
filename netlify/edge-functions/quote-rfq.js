// Public quote endpoint for vendors — no login; the RFQ token IS the key.
//
// GET  /api/quote-rfq?token=...   → the RFQ (items, contractor, message)
// POST /api/quote-rfq             → { token, lines, notes, lead_time }
//
// On submit: quote_json is stored, status flips to 'quoted', and the
// contractor gets an email naming the job — "Ferguson submitted a quote for
// Golden Corral — Baytown". Re-submission is allowed (vendors revise quotes);
// each revision re-notifies.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const TOKEN_RE = /^[a-f0-9-]{36}$/i

export default async (request) => {
  const svc = createClient(Deno.env.get('VITE_SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))

  if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('token') || ''
    if (!TOKEN_RE.test(token)) return json({ error: 'Invalid quote link.' }, 400)
    const { data: rfq } = await svc
      .from('rfqs')
      .select('project_name, message, items_json, status, quote_json, vendor_snapshot, user_name, user_company, created_at')
      .eq('token', token).single()
    if (!rfq) return json({ error: 'This quote link is invalid or has been removed.' }, 404)
    return json({
      project_name: rfq.project_name,
      message: rfq.message,
      items: rfq.items_json,
      status: rfq.status,
      quote: rfq.quote_json,
      vendor: rfq.vendor_snapshot,
      contractor: { name: rfq.user_name, company: rfq.user_company },
      sent_at: rfq.created_at,
    })
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const { token, lines, notes, lead_time } = body
  if (!TOKEN_RE.test(String(token || ''))) return json({ error: 'Invalid quote link.' }, 400)

  const { data: rfq } = await svc
    .from('rfqs')
    .select('id, items_json, project_name, user_email, user_name, vendor_snapshot')
    .eq('token', token).single()
  if (!rfq) return json({ error: 'This quote link is invalid or has been removed.' }, 404)

  const itemCount = Array.isArray(rfq.items_json) ? rfq.items_json.length : 0
  // Lines are keyed by item index; only priced lines are kept.
  const cleanLines = (Array.isArray(lines) ? lines : [])
    .filter((l) => l && Number.isInteger(l.i) && l.i >= 0 && l.i < itemCount)
    .slice(0, itemCount)
    .map((l) => ({
      i: l.i,
      unit_price: Number.isFinite(Number(l.unit_price)) && Number(l.unit_price) >= 0 ? Number(l.unit_price) : null,
      note: typeof l.note === 'string' ? l.note.slice(0, 200) : null,
    }))
    .filter((l) => l.unit_price != null || l.note)
  if (!cleanLines.length) return json({ error: 'Enter at least one unit price.' }, 400)

  const quote = {
    lines: cleanLines,
    notes: typeof notes === 'string' ? notes.slice(0, 2000) : null,
    lead_time: typeof lead_time === 'string' ? lead_time.slice(0, 200) : null,
    submitted_at: new Date().toISOString(),
  }
  const { error: upErr } = await svc.from('rfqs')
    .update({ quote_json: quote, status: 'quoted', quoted_at: new Date().toISOString() })
    .eq('id', rfq.id)
  if (upErr) return json({ error: 'Could not save the quote — try again.' }, 500)

  // Notify the contractor, naming the job. Notification failure never blocks
  // the vendor's submission — the quote is already saved.
  try {
    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (resendKey && rfq.user_email) {
      const vendorLabel = rfq.vendor_snapshot?.company || rfq.vendor_snapshot?.name || 'A vendor'
      const priced = cleanLines.filter((l) => l.unit_price != null).length
      const total = cleanLines.reduce((s, l) => {
        const qty = Number(rfq.items_json?.[l.i]?.quantity) || 0
        return l.unit_price != null ? s + l.unit_price * qty : s
      }, 0)
      const siteUrl = Deno.env.get('URL') || new URL(request.url).origin
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Takeoff Copilot <hello@takeoffcopilot.com>',
          to: [rfq.user_email],
          subject: `Quote received: ${vendorLabel} — ${rfq.project_name || 'your takeoff'}`,
          html: `
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f6fa"><tr><td align="center" style="padding:28px 12px;">
  <table width="560" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="border-radius:8px;overflow:hidden;">
    <tr><td bgcolor="#0057FF" style="padding:18px 26px;">
      <span style="font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;letter-spacing:1px;">QUOTE RECEIVED</span>
    </td></tr>
    <tr><td style="padding:22px 26px;font-family:Arial,sans-serif;">
      <p style="font-size:14px;color:#0b1220;margin:0 0 10px;line-height:1.55;">
        <strong>${esc(vendorLabel)}</strong> submitted a quote for <strong>${esc(rfq.project_name || 'your takeoff')}</strong>.
      </p>
      <p style="font-size:13px;color:#5a6478;margin:0 0 16px;line-height:1.55;">
        ${priced} line${priced === 1 ? '' : 's'} priced${total > 0 ? ` &middot; quoted total ~$${esc(Math.round(total).toLocaleString())}` : ''}${quote.lead_time ? ` &middot; lead time: ${esc(quote.lead_time)}` : ''}
      </p>
      <table cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="#0057FF" style="border-radius:6px;">
          <a href="${siteUrl}/dashboard" style="display:inline-block;padding:11px 22px;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#ffffff;text-decoration:none;">View in Takeoff Copilot</a>
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr></table>`,
        }),
      })
    }
  } catch (e) {
    console.error('quote notification failed:', e.message)
  }

  return json({ ok: true })
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
