// Deletes a project: verifies ownership under the caller's JWT (RLS), then
// removes the project's storage files with the service role (users have no
// storage DELETE policy) and the project row (line_items/sheets/jobs cascade;
// job-history rows keep their result_json via ON DELETE SET NULL).
//
// Request body: { project_id }
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

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

  const userClient = createClient(
    Deno.env.get('VITE_SUPABASE_URL'),
    Deno.env.get('VITE_SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  )

  const { data: { user }, error: authErr } = await userClient.auth.getUser()
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  const { project_id } = body
  if (!project_id) return new Response('Missing project_id', { status: 400 })

  // Ownership check under RLS — anything not the caller's own project 404s here.
  const { data: project } = await userClient
    .from('projects').select('id, user_id').eq('id', project_id).maybeSingle()
  if (!project || project.user_id !== user.id) {
    return new Response('Not found', { status: 404 })
  }

  const service = createClient(
    Deno.env.get('VITE_SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  )

  // Storage prefix is canonical: {user_id}/{project_id}/…
  const prefix = `${user.id}/${project_id}`
  const toRemove = []
  for (const dir of [prefix, `${prefix}/pages`]) {
    const { data: files } = await service.storage.from('plan-uploads').list(dir, { limit: 1000 })
    for (const f of files || []) {
      if (f.id) toRemove.push(`${dir}/${f.name}`)
    }
  }
  if (toRemove.length) {
    const { error: rmErr } = await service.storage.from('plan-uploads').remove(toRemove)
    if (rmErr) console.error('storage cleanup failed:', rmErr.message)
  }

  const { error: delErr } = await userClient.from('projects').delete().eq('id', project_id)
  if (delErr) {
    return new Response(JSON.stringify({ error: 'Delete failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true, files_removed: toRemove.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
