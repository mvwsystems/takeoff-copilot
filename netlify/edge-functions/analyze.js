// Proxies requests to the Anthropic Messages API with the server-side API key.
// Accepts three payload shapes:
//   Analyze (file_id):  { file_id, prompt, systemPrompt?, maxTokens }
//   Analyze (image):    { fileBlock, prompt, systemPrompt?, maxTokens }   ← base64 image fallback
//   Chat:               { systemPrompt, messages, maxTokens }
// systemPrompt rides the API's system param — instructions never share the
// user turn with untrusted document content.
// Required env vars: ANTHROPIC_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//                    SUPABASE_SERVICE_ROLE_KEY (usage ledger)
// Optional: QUOTA_AI_CALLS_PER_DAY (default 300)

const MAX_TOKENS_CEILING = 8192

// Usage ledger via PostgREST with the service role (usage_events has no user
// INSERT policy on purpose). Quota failures open — a ledger outage must not
// take analysis down — but denials are enforced when the count is readable.
async function usageCount(userId) {
  const url = Deno.env.get('VITE_SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  try {
    const res = await fetch(
      `${url}/rest/v1/usage_events?user_id=eq.${userId}&kind=in.(single_call,chat)&created_at=gte.${since}&select=id`,
      { method: 'HEAD', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' } },
    )
    const range = res.headers.get('content-range') // e.g. "0-24/25"
    const total = range?.split('/')[1]
    return total != null && total !== '*' ? Number(total) : null
  } catch {
    return null
  }
}

async function recordUsage(userId, kind) {
  const url = Deno.env.get('VITE_SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return
  try {
    await fetch(`${url}/rest/v1/usage_events`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_id: userId, kind }),
    })
  } catch { /* ledger write is best-effort */ }
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const token = auth.slice(7)

  let user
  try {
    const verify = await fetch(`${Deno.env.get('VITE_SUPABASE_URL')}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': Deno.env.get('VITE_SUPABASE_ANON_KEY'),
      },
    })
    if (!verify.ok) return new Response('Unauthorized', { status: 401 })
    user = await verify.json()
  } catch {
    return new Response('Auth verification failed', { status: 401 })
  }

  // Per-user daily ceiling — without one, a single account can run unbounded
  // workloads on the shared API key.
  const cap = Number(Deno.env.get('QUOTA_AI_CALLS_PER_DAY')) || 300
  const used = await usageCount(user.id)
  if (used != null && used >= cap) {
    return new Response(JSON.stringify({
      error: `Daily AI usage limit reached (${cap} calls). It resets within 24 hours — contact hello@6signal.co if you need more.`,
    }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  const { file_id, specs_file_id, fileBlock, prompt, maxTokens, systemPrompt, messages } = body
  const isChatMode = Array.isArray(messages)

  // maxTokens is client-supplied — clamp it to a sane window.
  const tokens = Math.min(Math.max(Number(maxTokens) || 4096, 256), MAX_TOKENS_CEILING)

  let anthropicBody, betaHeader

  if (isChatMode) {
    anthropicBody = {
      model: 'claude-sonnet-5',
      max_tokens: tokens,
      system: systemPrompt,
      messages,
    }
    betaHeader = null
  } else {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return new Response('Missing prompt', { status: 400 })
    }
    const contentParts = [{ type: 'text', text: prompt }]
    if (file_id) contentParts.push({ type: 'document', source: { type: 'file', file_id } })
    else if (fileBlock) contentParts.push(fileBlock)
    if (specs_file_id) contentParts.push({ type: 'document', source: { type: 'file', file_id: specs_file_id } })

    anthropicBody = {
      model: 'claude-sonnet-5',
      max_tokens: tokens,
      temperature: 0,
      ...(typeof systemPrompt === 'string' && systemPrompt.trim() ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: contentParts }],
    }
    betaHeader = (file_id || specs_file_id) ? 'files-api-2025-04-14' : null
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': Deno.env.get('ANTHROPIC_API_KEY'),
    'anthropic-version': '2023-06-01',
  }
  if (betaHeader) headers['anthropic-beta'] = betaHeader

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error('Anthropic upstream error:', response.status, err.slice(0, 300))
    const friendly = response.status === 429
      ? 'The AI service is rate-limited right now — wait a minute and retry.'
      : response.status >= 500
        ? 'The AI service had a temporary problem — retry in a moment.'
        : 'The AI request was rejected — try again, and contact support if it persists.'
    return new Response(JSON.stringify({ error: friendly }), {
      status: response.status, headers: { 'Content-Type': 'application/json' },
    })
  }

  const data = await response.json()
  // Awaited — edge isolates freeze on return, killing un-awaited fetches.
  await recordUsage(user.id, isChatMode ? 'chat' : 'single_call')
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
