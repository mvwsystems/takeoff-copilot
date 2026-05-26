// Receives a raw PDF (multipart FormData, field name "file")
// Uploads it to the Anthropic Files API and returns { file_id }.
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

  const incomingForm = await request.formData()
  const file = incomingForm.get('file')
  if (!file) return new Response('Missing file field', { status: 400 })

  const outgoingForm = new FormData()
  outgoingForm.append('file', file, file.name || 'document.pdf')

  const uploadRes = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: outgoingForm,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    return new Response(err, { status: uploadRes.status, headers: { 'Content-Type': 'application/json' } })
  }

  const data = await uploadRes.json()
  return new Response(JSON.stringify({ file_id: data.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
