// Proxies requests to the Anthropic Messages API with the server-side API key.
// Accepts three payload shapes:
//   Analyze (file_id):  { file_id, prompt, maxTokens }
//   Analyze (image):    { fileBlock, prompt, maxTokens }   ← base64 image fallback
//   Chat:               { systemPrompt, messages, maxTokens }
// Required env vars: ANTHROPIC_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const token = auth.slice(7)

  try {
    const verify = await fetch(`${Deno.env.get('VITE_SUPABASE_URL')}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': Deno.env.get('VITE_SUPABASE_ANON_KEY'),
      },
    })
    if (!verify.ok) return new Response('Unauthorized', { status: 401 })
  } catch {
    return new Response('Auth verification failed', { status: 401 })
  }

  const { file_id, specs_file_id, fileBlock, prompt, maxTokens, systemPrompt, messages } = await request.json()
  const isChatMode = Array.isArray(messages)

  let anthropicBody, betaHeader

  if (isChatMode) {
    anthropicBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }
    betaHeader = null
  } else {
    const contentParts = [{ type: 'text', text: prompt }]
    if (file_id) contentParts.push({ type: 'document', source: { type: 'file', file_id } })
    else if (fileBlock) contentParts.push(fileBlock)
    if (specs_file_id) contentParts.push({ type: 'document', source: { type: 'file', file_id: specs_file_id } })

    anthropicBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
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
    return new Response(err, { status: response.status, headers: { 'Content-Type': 'application/json' } })
  }

  const data = await response.json()
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
