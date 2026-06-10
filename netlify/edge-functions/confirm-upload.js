// Called by the dashboard after the client finishes uploading to Supabase Storage.
// Updates job stage to 'uploaded' and fires the background processing function.
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL (auto-set by Netlify)
//
// Request body: { job_id, sheet_id, storage_path, project_id }
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

  const { job_id, sheet_id, storage_path, project_id } = await request.json()
  if (!job_id || !sheet_id || !storage_path || !project_id) {
    return new Response('Missing required fields', { status: 400 })
  }

  // Mark job as uploaded
  await supabase
    .from('processing_jobs')
    .update({ stage: 'uploaded', progress: 10 })
    .eq('id', job_id)

  // Fire background function (fire-and-forget — don't await)
  const siteUrl = Deno.env.get('URL') || ''
  const bgUrl = `${siteUrl}/.netlify/functions/process-plan-background`
  fetch(bgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id, sheet_id, storage_path, project_id }),
  }).catch(() => { /* ignore — background function responds with 202 */ })

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
