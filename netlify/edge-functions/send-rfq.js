// Sends a Request-for-Quote email to selected vendors for one takeoff.
//
// Auth: Supabase JWT (the contractor). Each selected vendor gets a branded
// email FROM hello@takeoffcopilot.com with REPLY-TO set to the contractor's
// email — a vendor who just hits Reply reaches the contractor directly. The
// email also carries a unique /quote/<token> link; quotes submitted there
// flow back into the app and trigger a notification email to the contractor.
// The contractor is BCC'd on every RFQ so they have a copy of what went out.
//
// Request body: { project_id, project_name, vendor_ids: [], message, items: [] }
// Response: { sent, failed: [vendor emails] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const MAX_VENDORS_PER_SEND = 10
const MAX_ITEMS = 300

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })

  const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL')
  const anonKey = Deno.env.get('VITE_SUPABASE_ANON_KEY')
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user }, error: userErr } = await userClient.auth.getUser()
  if (userErr || !user) return new Response('Unauthorized', { status: 401 })

  let body
  try { body = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
  const { project_id, project_name, vendor_ids, message, items } = body

  if (!Array.isArray(vendor_ids) || !vendor_ids.length) {
    return json({ error: 'Select at least one vendor.' }, 400)
  }
  if (vendor_ids.length > MAX_VENDORS_PER_SEND) {
    return json({ error: `Up to ${MAX_VENDORS_PER_SEND} vendors per send.` }, 400)
  }
  // Sanitize the item snapshot — it goes into emails and the public quote page.
  const cleanItems = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS)
    .filter((it) => it && typeof it.description === 'string')
    .map((it) => ({
      category: String(it.category ?? '').slice(0, 40),
      description: String(it.description).slice(0, 300),
      spec: String(it.spec ?? '').slice(0, 300),
      quantity: Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 0,
      unit: String(it.unit ?? '').slice(0, 12),
    }))
  if (!cleanItems.length) return json({ error: 'No purchasable materials to quote.' }, 400)
  const cleanMessage = typeof message === 'string' ? message.slice(0, 2000) : ''
  const cleanProjectName = String(project_name ?? 'Takeoff').slice(0, 160)

  // RLS-scoped: only the caller's own vendors resolve.
  const { data: vendors, error: vErr } = await userClient
    .from('vendors').select('id, name, company, email').in('id', vendor_ids)
  if (vErr || !vendors?.length) return json({ error: 'Vendors not found.' }, 400)

  const { data: profile } = await userClient
    .from('profiles').select('full_name, company, phone').eq('id', user.id).single()
  const senderName = profile?.full_name || user.email
  const senderCompany = profile?.company || ''

  const svc = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'Email is not configured.' }, 500)
  const siteUrl = Deno.env.get('URL') || new URL(request.url).origin

  const itemRows = cleanItems.map((it) => `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e8ebf2;font-size:13px;color:#0b1220;">${esc(it.description)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e8ebf2;font-size:12px;color:#5a6478;">${esc(it.spec)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e8ebf2;font-size:13px;color:#0b1220;text-align:right;white-space:nowrap;">${esc(it.quantity.toLocaleString())} ${esc(it.unit)}</td>
    </tr>`).join('')

  let sent = 0
  const failed = []
  for (const vendor of vendors) {
    const token = crypto.randomUUID()
    const { error: insErr } = await svc.from('rfqs').insert({
      user_id: user.id,
      project_id: project_id || null,
      vendor_id: vendor.id,
      vendor_snapshot: { name: vendor.name, company: vendor.company, email: vendor.email },
      user_email: user.email,
      user_name: senderName,
      user_company: senderCompany,
      project_name: cleanProjectName,
      token,
      message: cleanMessage,
      items_json: cleanItems,
    })
    if (insErr) { failed.push(vendor.email); continue }

    const quoteUrl = `${siteUrl}/quote/${token}`
    // bgcolor ATTRIBUTES, not CSS background — Gmail strips the latter.
    const html = `
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f6fa"><tr><td align="center" style="padding:28px 12px;">
  <table width="620" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="border-radius:8px;overflow:hidden;">
    <tr><td bgcolor="#0057FF" style="padding:20px 28px;">
      <span style="font-family:Arial,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:1px;">REQUEST FOR QUOTE</span><br>
      <span style="font-family:Arial,sans-serif;font-size:12px;color:#cfe0ff;">Takeoff Copilot // on behalf of ${esc(senderCompany || senderName)}</span>
    </td></tr>
    <tr><td style="padding:24px 28px;font-family:Arial,sans-serif;">
      <p style="font-size:14px;color:#0b1220;margin:0 0 6px;">Hi ${esc(vendor.name)},</p>
      <p style="font-size:14px;color:#0b1220;margin:0 0 14px;line-height:1.55;">
        ${esc(senderName)}${senderCompany ? ` (${esc(senderCompany)})` : ''} is requesting material pricing for
        <strong>${esc(cleanProjectName)}</strong> — ${cleanItems.length} line${cleanItems.length === 1 ? '' : 's'} below.
      </p>
      ${cleanMessage ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="#f0f5ff" style="padding:12px 14px;border-radius:6px;"><span style="font-family:Arial,sans-serif;font-size:13px;color:#0b1220;line-height:1.55;">&ldquo;${esc(cleanMessage)}&rdquo;</span></td></tr></table><div style="height:14px;"></div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf2;border-radius:6px;">
        <tr bgcolor="#f4f6fa">
          <td style="padding:8px 10px;font-size:11px;font-weight:bold;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;">Material</td>
          <td style="padding:8px 10px;font-size:11px;font-weight:bold;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;">Spec</td>
          <td style="padding:8px 10px;font-size:11px;font-weight:bold;color:#5a6478;text-transform:uppercase;letter-spacing:0.5px;text-align:right;">Qty</td>
        </tr>
        ${itemRows}
      </table>
      <table cellpadding="0" cellspacing="0" style="margin:20px auto 6px;"><tr>
        <td bgcolor="#0057FF" style="border-radius:6px;">
          <a href="${quoteUrl}" style="display:inline-block;padding:12px 26px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Submit Your Quote Online</a>
        </td>
      </tr></table>
      <p style="font-size:12px;color:#5a6478;text-align:center;margin:10px 0 0;">
        Or simply reply to this email — your reply goes straight to ${esc(senderName)} at ${esc(user.email)}.
      </p>
      <p style="font-size:11px;color:#8a93a6;margin:18px 0 0;line-height:1.5;">
        Quantities are estimated from plans — verify before fabrication. Please include pricing and lead time.
      </p>
    </td></tr>
  </table>
</td></tr></table>`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Takeoff Copilot <hello@takeoffcopilot.com>',
        to: [vendor.email],
        bcc: [user.email],
        reply_to: user.email,
        subject: `Request for Quote — ${cleanProjectName}${senderCompany ? ` (${senderCompany})` : ''}`,
        html,
      }),
    })
    if (res.ok) {
      sent++
    } else {
      failed.push(vendor.email)
      // The email never went out — remove the dangling RFQ so status stays true.
      await svc.from('rfqs').delete().eq('token', token)
    }
  }

  return json({ sent, failed })
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
