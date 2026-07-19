// Called by the dashboard after the client finishes uploading to Supabase Storage.
// Updates job stage to 'uploaded' and fires the background processing function.
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, WEBHOOK_SECRET,
//                    URL (auto-set by Netlify)
//
// Request body: { job_id, sheet_id, project_id }
// Response:     { ok: true }

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
  const { job_id, sheet_id, project_id } = body
  if (!job_id || !sheet_id || !project_id) {
    return new Response('Missing required fields', { status: 400 })
  }

  // Ownership: these reads run under the caller's JWT, so RLS only returns
  // rows from the caller's own project. Anything else 404s here and never
  // reaches the service-role background function.
  const { data: job } = await supabase
    .from('processing_jobs')
    .select('id')
    .eq('id', job_id)
    .eq('project_id', project_id)
    .maybeSingle()
  const { data: sheet } = await supabase
    .from('sheets')
    .select('id')
    .eq('id', sheet_id)
    .eq('project_id', project_id)
    .maybeSingle()
  if (!job || !sheet) {
    return new Response('Not found', { status: 404 })
  }

  // The upload path is canonical — derive it, never trust a client-sent copy.
  const storage_path = `${user.id}/${project_id}/original.pdf`

  const { error: updErr } = await supabase
    .from('processing_jobs')
    .update({ stage: 'uploaded', progress: 10 })
    .eq('id', job_id)
  if (updErr) {
    return new Response(JSON.stringify({ error: 'Could not update job' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Trigger background function. MUST be awaited — edge isolates freeze the
  // moment the response is returned, killing any in-flight fetch. Background
  // functions return 202 immediately, so this only costs a round trip.
  const siteUrl = Deno.env.get('URL') || new URL(request.url).origin
  const bgUrl = `${siteUrl}/.netlify/functions/process-plan-background`
  try {
    const bgRes = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fn-secret': Deno.env.get('WEBHOOK_SECRET') || '',
      },
      body: JSON.stringify({ job_id, sheet_id, storage_path, project_id }),
    })
    if (!bgRes.ok && bgRes.status !== 202) {
      throw new Error(`background function returned ${bgRes.status}`)
    }
  } catch (err) {
    await supabase
      .from('processing_jobs')
      .update({ stage: 'error', error: `Could not start processing: ${err.message}` })
      .eq('id', job_id)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
