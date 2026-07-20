// Stripe webhook: on a completed Checkout Session, grants the purchased
// takeoff credit(s) to the buyer. Verifies the Stripe signature (HMAC-SHA256
// over "timestamp.payload") so only Stripe can grant credits. Grants are
// idempotent by session id, so Stripe's retries never double-credit.
//
// Configure in Stripe → Developers → Webhooks:
//   URL:   https://<site>/.netlify/functions/stripe-webhook
//   Event: checkout.session.completed
// Required env: STRIPE_WEBHOOK_SECRET, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Netlify passes the raw body as event.body — we must verify the signature
// against the exact bytes Stripe sent, so do NOT JSON.parse before verifying.
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')))
  const t = parts.t
  const v1 = parts.v1
  if (!t || !v1) return false
  // Reject signatures older than 5 minutes (replay protection).
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t))
  if (!Number.isFinite(ageSec) || ageSec > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature']
  const raw = event.body || ''
  if (!verifyStripeSignature(raw, sig, secret)) {
    return { statusCode: 400, body: 'Invalid signature' }
  }

  let evt
  try { evt = JSON.parse(raw) } catch { return { statusCode: 400, body: 'Bad JSON' } }

  if (evt.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'ignored' }   // ack other events so Stripe stops retrying
  }

  const session = evt.data?.object || {}
  if (session.payment_status && session.payment_status !== 'paid') {
    return { statusCode: 200, body: 'unpaid' }
  }
  const userId = session.metadata?.user_id || session.client_reference_id
  const qty = Number(session.metadata?.credits) || 1
  if (!userId) {
    console.error('stripe-webhook: no user_id on session', session.id)
    return { statusCode: 200, body: 'no user' }   // ack — nothing we can do, don't loop
  }

  try {
    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    const { data, error } = await supabase.rpc('grant_credits', {
      p_user: userId, p_qty: qty, p_session: session.id,
    })
    if (error) throw new Error(error.message)
    console.log(`stripe-webhook: granted ${data} credit(s) to ${userId} (session ${session.id})`)
    return { statusCode: 200, body: JSON.stringify({ granted: data }) }
  } catch (err) {
    console.error('stripe-webhook grant failed:', err.message)
    // 500 → Stripe retries; the grant is idempotent so a retry is safe.
    return { statusCode: 500, body: 'grant failed' }
  }
}
