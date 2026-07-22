// Stripe webhook. Handles:
//   customer.subscription.created / updated / deleted → upsert subscriptions row
//   checkout.session.completed (mode=payment)         → grant 1 pay-as-you-go credit
// Verifies the Stripe signature (HMAC-SHA256 over "timestamp.payload").
//
// Configure in Stripe → Developers → Webhooks (URL: /.netlify/functions/stripe-webhook):
//   checkout.session.completed, customer.subscription.created,
//   customer.subscription.updated, customer.subscription.deleted
// Required env: STRIPE_WEBHOOK_SECRET, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Quota + seats per plan — the plan slug rides in subscription metadata.
const PLAN_CONFIG = {
  solo:   { quota: 20,  seats: 1 },
  growth: { quota: 100, seats: 3 },
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')))
  const t = parts.t, v1 = parts.v1
  if (!t || !v1) return false
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t))
  if (!Number.isFinite(ageSec) || ageSec > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(v1)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null)

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature']
  const raw = event.body || ''
  if (!verifyStripeSignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Invalid signature' }
  }

  let evt
  try { evt = JSON.parse(raw) } catch { return { statusCode: 400, body: 'Bad JSON' } }

  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  try {
    // ── Subscription lifecycle ──────────────────────────────
    if (evt.type.startsWith('customer.subscription.')) {
      const sub = evt.data.object
      const userId = sub.metadata?.user_id
      const plan = sub.metadata?.plan
      if (!userId || !PLAN_CONFIG[plan]) {
        console.error('subscription event missing user_id/plan metadata', sub.id)
        return { statusCode: 200, body: 'ignored' }
      }
      const canceled = evt.type === 'customer.subscription.deleted' || sub.status === 'canceled'
      const cfg = PLAN_CONFIG[plan]
      const { error } = await supabase.rpc('upsert_subscription', {
        p_user: userId,
        p_customer: sub.customer || null,
        p_sub: sub.id,
        p_plan: plan,
        p_status: canceled ? 'canceled' : sub.status, // active | trialing | past_due | canceled
        p_seats: cfg.seats,
        p_quota: canceled ? 0 : cfg.quota,
        p_start: iso(sub.current_period_start),
        p_end: iso(sub.current_period_end),
      })
      if (error) throw new Error(error.message)
      console.log(`subscription ${evt.type}: ${userId} → ${plan} (${sub.status})`)
      return { statusCode: 200, body: JSON.stringify({ ok: true }) }
    }

    // ── One-time single-takeoff purchase → grant a credit ───
    if (evt.type === 'checkout.session.completed') {
      const session = evt.data.object
      if (session.mode !== 'payment') return { statusCode: 200, body: 'subscription checkout — handled via subscription events' }
      if (session.payment_status && session.payment_status !== 'paid') return { statusCode: 200, body: 'unpaid' }
      const userId = session.metadata?.user_id || session.client_reference_id
      const qty = Number(session.metadata?.credits) || 1
      if (!userId) return { statusCode: 200, body: 'no user' }
      const { data, error } = await supabase.rpc('grant_credits', { p_user: userId, p_qty: qty, p_session: session.id })
      if (error) throw new Error(error.message)
      console.log(`single-takeoff: granted ${data} credit(s) to ${userId}`)
      return { statusCode: 200, body: JSON.stringify({ granted: data }) }
    }

    return { statusCode: 200, body: 'ignored' }
  } catch (err) {
    console.error('stripe-webhook error:', err.message)
    return { statusCode: 500, body: 'error' }   // Stripe retries; all our writes are idempotent
  }
}
