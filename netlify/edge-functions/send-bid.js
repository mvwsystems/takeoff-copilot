// Emails an approved bid proposal to the owner/GC.
//
// Auth: Supabase JWT. The client sends the bid OBJECT (bidMath output) plus
// meta — the HTML is rendered SERVER-SIDE with the same buildBidHTML the
// download uses, so this endpoint can't be used as an arbitrary-HTML relay
// from our domain. Reply-To is the contractor; they're BCC'd for their
// records.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildBidHTML } from '../../src/utils/bidExport.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_RECIPIENTS = 3

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })
  const userClient = createClient(Deno.env.get('VITE_SUPABASE_URL'), Deno.env.get('VITE_SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  let body
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const { to, bid, meta } = body

  const recipients = String(to || '').split(/[,;\s]+/).filter(Boolean).slice(0, MAX_RECIPIENTS)
  if (!recipients.length || recipients.some((r) => !EMAIL_RE.test(r))) {
    return json({ error: 'Enter a valid recipient email.' }, 400)
  }
  // Sanity-bound the payload; buildBidHTML escapes all interpolated fields.
  if (!bid || typeof bid !== 'object' || JSON.stringify(bid).length > 200_000) {
    return json({ error: 'Invalid bid payload.' }, 400)
  }
  const cleanMeta = {
    projectName: String(meta?.projectName ?? 'Takeoff').slice(0, 160),
    company: String(meta?.company ?? '').slice(0, 160),
    contactName: String(meta?.contactName ?? '').slice(0, 120),
    phone: String(meta?.phone ?? '').slice(0, 40),
    email: user.email,
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'Email is not configured.' }, 500)

  let html
  try { html = buildBidHTML(bid, cleanMeta) } catch { return json({ error: 'Invalid bid payload.' }, 400) }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Takeoff Copilot <hello@takeoffcopilot.com>',
      to: recipients,
      bcc: [user.email],
      reply_to: user.email,
      subject: `Bid Proposal — ${cleanMeta.projectName}${cleanMeta.company ? ` — ${cleanMeta.company}` : ''}`,
      html,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    console.error('bid email failed:', detail)
    return json({ error: 'The email could not be sent — try again.' }, 502)
  }
  return json({ ok: true, sent_to: recipients })
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
