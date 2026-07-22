// Creates a Stripe Checkout Session — either a plan SUBSCRIPTION (solo/growth)
// or a one-time SINGLE takeoff (overage / pay-as-you-go). Verifies the caller's
// Supabase JWT and stamps their user id into metadata so the webhook can attach
// the subscription / credit to the right account.
//
// Request body: { plan: 'solo'|'growth'|'single', interval?: 'month'|'year', return_to?: string }
// Response:     { url }
//
// Required env: STRIPE_SECRET_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
// Plan price IDs (create in Stripe, set in Netlify):
//   STRIPE_PRICE_SOLO, STRIPE_PRICE_GROWTH            (monthly, required for subs)
//   STRIPE_PRICE_SOLO_ANNUAL, STRIPE_PRICE_GROWTH_ANNUAL   (optional, annual)
//   STRIPE_PRICE_SINGLE (optional; else an inline $25 one-time price is used)

const PLANS = {
  solo:   { mode: 'subscription', price: { month: 'STRIPE_PRICE_SOLO',   year: 'STRIPE_PRICE_SOLO_ANNUAL' } },
  growth: { mode: 'subscription', price: { month: 'STRIPE_PRICE_GROWTH', year: 'STRIPE_PRICE_GROWTH_ANNUAL' } },
  single: { mode: 'payment' },
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Billing is not configured.' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })
  }

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })
  const token = auth.slice(7)

  let user
  try {
    const verify = await fetch(`${Deno.env.get('VITE_SUPABASE_URL')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('VITE_SUPABASE_ANON_KEY') },
    })
    if (!verify.ok) return new Response('Unauthorized', { status: 401 })
    user = await verify.json()
  } catch {
    return new Response('Auth verification failed', { status: 401 })
  }

  let body = {}
  try { body = await request.json() } catch { /* optional */ }
  const plan = PLANS[body.plan] ? body.plan : 'single'
  const interval = body.interval === 'year' ? 'year' : 'month'
  const cfg = PLANS[plan]
  const origin = Deno.env.get('APP_URL') || new URL(request.url).origin
  const returnTo = typeof body.return_to === 'string' && body.return_to.startsWith('/') ? body.return_to : '/dashboard'

  const params = new URLSearchParams()
  params.set('mode', cfg.mode)
  params.set('success_url', `${origin}${returnTo}?checkout=success&session_id={CHECKOUT_SESSION_ID}`)
  params.set('cancel_url', `${origin}${returnTo}?checkout=cancel`)
  params.set('client_reference_id', user.id)
  params.set('metadata[user_id]', user.id)
  params.set('metadata[plan]', plan)
  if (user.email) params.set('customer_email', user.email)

  if (cfg.mode === 'subscription') {
    const priceId = Deno.env.get(cfg.price[interval])
    if (!priceId) {
      return new Response(JSON.stringify({ error: `The ${plan} ${interval === 'year' ? 'annual' : 'monthly'} plan isn't set up yet.` }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      })
    }
    params.set('line_items[0][price]', priceId)
    params.set('line_items[0][quantity]', '1')
    params.set('allow_promotion_codes', 'true')
    // Carry plan + user id on the SUBSCRIPTION so every renewal/cancel webhook has them.
    params.set('subscription_data[metadata][user_id]', user.id)
    params.set('subscription_data[metadata][plan]', plan)
  } else {
    // Single takeoff — one-time payment that grants 1 pay-as-you-go credit.
    params.set('metadata[credits]', '1')
    const singlePrice = Deno.env.get('STRIPE_PRICE_SINGLE')
    if (singlePrice) {
      params.set('line_items[0][price]', singlePrice)
      params.set('line_items[0][quantity]', '1')
    } else {
      const cents = Number(Deno.env.get('SINGLE_TAKEOFF_CENTS')) || 2500
      params.set('line_items[0][price_data][currency]', 'usd')
      params.set('line_items[0][price_data][unit_amount]', String(cents))
      params.set('line_items[0][price_data][product_data][name]', 'Takeoff Copilot — single takeoff')
      params.set('line_items[0][price_data][product_data][description]', 'One additional plan-set takeoff')
      params.set('line_items[0][quantity]', '1')
    }
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    console.error('Stripe checkout error:', res.status, (await res.text()).slice(0, 300))
    return new Response(JSON.stringify({ error: 'Could not start checkout — try again in a moment.' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }
  const session = await res.json()
  return new Response(JSON.stringify({ url: session.url }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
