// Two-step document upload (specs, geotech) that avoids pushing large files
// through Netlify — edge functions cap request bodies, which 500'd on big PDFs.
//
//   action "sign":     { filename }      → { upload_url, storage_path }
//                      Client then PUTs the file straight to Supabase Storage.
//   action "register": { storage_path }  → { file_id }
//                      Server pulls the file from Storage and uploads it to the
//                      Anthropic Files API (server-to-server, no body limits).
//
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ANTHROPIC_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const token = auth.slice(7)

  const supabase = createClient(
    Deno.env.get('VITE_SUPABASE_URL'),
    Deno.env.get('VITE_SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  )

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  if (body.action === 'sign') {
    const safeName = (body.filename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const storagePath = `${user.id}/docs/${Date.now()}-${safeName}`
    const { data, error } = await supabase.storage
      .from('plan-uploads')
      .createSignedUploadUrl(storagePath)
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ upload_url: data.signedUrl, storage_path: storagePath }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (body.action === 'register') {
    const { storage_path } = body
    // Users may only register files under their own docs folder. Exact-match
    // the path shape issued by "sign" — a prefix check alone would let
    // "../<other-user>/…" segments through.
    const DOC_PATH = new RegExp(`^${user.id}/docs/[A-Za-z0-9._-]+$`)
    if (typeof storage_path !== 'string' || !DOC_PATH.test(storage_path)) {
      return new Response('Invalid storage_path', { status: 400 })
    }

    const { data: blob, error: dlErr } = await supabase.storage
      .from('plan-uploads')
      .download(storage_path)
    if (dlErr) {
      return new Response(JSON.stringify({ error: `Download failed: ${dlErr.message}` }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    const outgoingForm = new FormData()
    outgoingForm.append('file', blob, storage_path.split('/').pop() || 'document.pdf')

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
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('Unknown action', { status: 400 })
}
