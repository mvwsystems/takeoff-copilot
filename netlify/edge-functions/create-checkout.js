// Creates a Stripe Checkout Session for one takeoff credit ($97 by default).
// Verifies the caller's Supabase JWT and stamps their user id into the session
// metadata so the webhook can grant the credit to the right account.
//
// Request body: { return_to?: string }   (path to come back to, e.g. "/dashboard")
// Response:     { url }                    (Stripe-hosted checkout URL)
//
// Required env: STRIPE_SECRET_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
// Optional env: TAKEOFF_PRICE_CENTS (default 9700), STRIPE_PRICE_ID (overrides
//               the inline price if you created a Price in Stripe), APP_URL.

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

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
  try { body = await request.json() } catch { /* optional body */ }
  const origin = Deno.env.get('APP_URL') || new URL(request.url).origin
  const returnTo = typeof body.return_to === 'string' && body.return_to.startsWith('/') ? body.return_to : '/dashboard'

  // Stripe has no Deno SDK we want to pull in — post the form-encoded params directly.
  const priceId = Deno.env.get('STRIPE_PRICE_ID')
  const cents = Number(Deno.env.get('TAKEOFF_PRICE_CENTS')) || 9700
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', `${origin}${returnTo}?checkout=success&session_id={CHECKOUT_SESSION_ID}`)
  params.set('cancel_url', `${origin}${returnTo}?checkout=cancel`)
  params.set('client_reference_id', user.id)
  params.set('metadata[user_id]', user.id)
  params.set('metadata[credits]', '1')
  if (user.email) params.set('customer_email', user.email)
  if (priceId) {
    params.set('line_items[0][price]', priceId)
    params.set('line_items[0][quantity]', '1')
  } else {
    params.set('line_items[0][price_data][currency]', 'usd')
    params.set('line_items[0][price_data][unit_amount]', String(cents))
    params.set('line_items[0][price_data][product_data][name]', 'Takeoff Copilot — one takeoff')
    params.set('line_items[0][price_data][product_data][description]', 'Full multi-pass AI takeoff for one plan set')
    params.set('line_items[0][quantity]', '1')
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('Stripe checkout error:', res.status, err.slice(0, 300))
    return new Response(JSON.stringify({ error: 'Could not start checkout — try again in a moment.' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }
  const session = await res.json()
  return new Response(JSON.stringify({ url: session.url }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
