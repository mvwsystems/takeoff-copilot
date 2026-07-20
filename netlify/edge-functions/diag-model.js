// TEMPORARY diagnostic — delete after use. Tests whether a given model+temperature
// is accepted by the Anthropic API. Guarded by the fn secret so it isn't open.
export default async (request) => {
  if (request.method !== 'POST') return new Response('no', { status: 405 })
  if (request.headers.get('x-fn-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('no', { status: 401 })
  }
  const { model, temperature } = await request.json()
  const body = {
    model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Say hi' }],
    ...(temperature !== undefined ? { temperature } : {}),
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return new Response(JSON.stringify({ sent: { model, temperature }, status: res.status, body: text.slice(0, 400) }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
