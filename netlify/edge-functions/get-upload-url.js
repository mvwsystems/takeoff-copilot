// Returns a Supabase Storage signed upload URL for a plan PDF.
// Also creates: project, sheet, and processing_job records in the DB.
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//
// Request body: { filename: string }
// Response:     { upload_url, storage_path, project_id, sheet_id, job_id }

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

  const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('VITE_SUPABASE_ANON_KEY')

  // Client initialized with user JWT — all DB ops respect RLS
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401 })
  }

  let filename = 'document.pdf'
  try {
    const body = await request.json()
    if (body.filename) filename = body.filename
  } catch { /* ignore parse errors */ }

  // Create project (one per uploaded file)
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .insert({ user_id: user.id, name: filename })
    .select('id')
    .single()
  if (projErr) {
    return new Response(JSON.stringify({ error: projErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Create sheet record (one per PDF; updated after rasterization)
  const { data: sheet, error: sheetErr } = await supabase
    .from('sheets')
    .insert({ project_id: project.id, page_number: 1 })
    .select('id')
    .single()
  if (sheetErr) {
    return new Response(JSON.stringify({ error: sheetErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Create processing job (stage: pending)
  const { data: job, error: jobErr } = await supabase
    .from('processing_jobs')
    .insert({ project_id: project.id, stage: 'pending', progress: 0 })
    .select('id')
    .single()
  if (jobErr) {
    return new Response(JSON.stringify({ error: jobErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Signed upload URL — client uploads directly to Supabase Storage
  const storagePath = `${user.id}/${project.id}/original.pdf`
  const { data: signedData, error: signErr } = await supabase.storage
    .from('plan-uploads')
    .createSignedUploadUrl(storagePath)
  if (signErr) {
    return new Response(JSON.stringify({ error: signErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    upload_url: signedData.signedUrl,
    storage_path: storagePath,
    project_id: project.id,
    sheet_id: sheet.id,
    job_id: job.id,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
