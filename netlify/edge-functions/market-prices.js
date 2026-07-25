// Market unit-price benchmark — the "bid is due today" pricing floor.
//
// Aggregates unit prices across the whole user base from two sources:
//   1. price_book rows (what contractors actually pay), and
//   2. returned vendor quotes (rfqs.quote_json — what vendors actually quote).
// Returns ANONYMIZED bands only: {low, median, high, n, sources} per material
// key. A key is published only when it has >= 2 distinct sources (different
// users, or different vendors), so no single contractor's pricing is ever
// exposed. Auth required — bands are for logged-in users, not the public.
//
// Keys mirror the app's price-book keying: 'mat:<slug>' | 'desc:<normalized>'.
// Quote lines carry no slug, so they land under desc: keys; the client falls
// back mat: -> desc: when looking up an item.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const descKey = (d) => `desc:${String(d || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`

const quantile = (sorted, q) => {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export default async (request) => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })
  const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL')
  const userClient = createClient(supabaseUrl, Deno.env.get('VITE_SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const svc = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))

  // samples: key -> [{ price, src }]
  const samples = new Map()
  const add = (key, unit, price, src) => {
    if (!key || key === 'desc:' || !Number.isFinite(price) || price <= 0) return
    if (!samples.has(key)) samples.set(key, { unit: unit || '', points: [] })
    samples.get(key).points.push({ price, src })
  }

  // 1. Every contractor's price book (their real costs).
  const { data: book } = await svc.from('price_book')
    .select('user_id, key, unit, unit_cost').limit(5000)
  for (const r of book || []) add(r.key, r.unit, Number(r.unit_cost), `u:${r.user_id}`)

  // 2. Every returned vendor quote (what suppliers actually quoted).
  const { data: quoted } = await svc.from('rfqs')
    .select('items_json, quote_json, vendor_snapshot')
    .eq('status', 'quoted').limit(1000)
  for (const r of quoted || []) {
    const items = Array.isArray(r.items_json) ? r.items_json : []
    const vend = `v:${(r.vendor_snapshot?.email || 'unknown').toLowerCase()}`
    for (const l of r.quote_json?.lines || []) {
      const it = items[l.i]
      if (!it || l.unit_price == null) continue
      add(descKey(it.description), it.unit, Number(l.unit_price), vend)
    }
  }

  // Aggregate — publish only multi-source keys.
  const prices = {}
  for (const [key, { unit, points }] of samples) {
    const sources = new Set(points.map((p) => p.src)).size
    if (sources < 2) continue
    const sorted = points.map((p) => p.price).sort((a, b) => a - b)
    prices[key] = {
      unit,
      n: sorted.length,
      sources,
      low: Math.round(quantile(sorted, 0.25) * 100) / 100,
      median: Math.round(quantile(sorted, 0.5) * 100) / 100,
      high: Math.round(quantile(sorted, 0.75) * 100) / 100,
    }
  }

  return new Response(JSON.stringify({ prices, keys: Object.keys(prices).length }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
  })
}
