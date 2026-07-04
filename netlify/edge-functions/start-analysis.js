// Starts the tiled multi-pass analysis for a project's selected sheets.
// Verifies the Supabase JWT, creates an analysis processing_job, and fires
// the analyze-project-background function (fire-and-forget).
//
// Request body: { project_id }
// Response: { job_id, sheet_count }

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

  // User-scoped client — all queries respect RLS, so a user can only
  // start analysis on their own project.
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  const { project_id, geotech, config, ground_truth } = body
  if (!project_id) {
    return new Response('Missing project_id', { status: 400 })
  }

  // Calibration config: sanitize to known fields and valid model tiers.
  let jobConfig = null
  if (config && typeof config === 'object') {
    const TIERS = new Set(['opus', 'sonnet', 'haiku'])
    const models = {}
    for (const k of ['pass1', 'pass2', 'pass4', 'pass5']) {
      if (TIERS.has(config.models?.[k])) models[k] = config.models[k]
    }
    jobConfig = {
      calibration: config.calibration === true,
      label: typeof config.label === 'string' ? config.label.slice(0, 60) : null,
      models,
    }
  }

  // Ground-truth takeoff rows (estimator-verified) — stored once on the project;
  // every calibration run scores against them. RLS scopes the update to the owner.
  if (Array.isArray(ground_truth) && ground_truth.length) {
    const rows = ground_truth.slice(0, 1000)
      .filter(r => r && typeof r.description === 'string' && isFinite(Number(r.quantity)))
      .map(r => ({
        description: r.description.slice(0, 300),
        quantity: Number(r.quantity),
        unit: typeof r.unit === 'string' ? r.unit.slice(0, 8).toUpperCase() : '',
      }))
    if (rows.length) {
      await supabase.from('projects').update({ calibration_truth: rows }).eq('id', project_id)
    }
  }

  // Persist geotech findings (rock depth, groundwater depth) on the project so
  // the depth engine can cross-reference them server-side across resumable runs.
  if (geotech && (geotech.rock_depth_ft != null || geotech.groundwater_depth_ft != null)) {
    await supabase.from('projects').update({
      geotech_rock_depth_ft: geotech.rock_depth_ft ?? null,
      geotech_groundwater_depth_ft: geotech.groundwater_depth_ft ?? null,
      geotech_summary: geotech.summary ?? null,
    }).eq('id', project_id)
  }

  // RLS guarantees this only returns the user's own sheets
  const { count, error: cntErr } = await supabase
    .from('sheets')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', project_id)
    .eq('included_in_analysis', true)

  if (cntErr || !count) {
    return new Response(JSON.stringify({ error: 'No sheets selected for analysis' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const { data: job, error: jobErr } = await supabase
    .from('processing_jobs')
    .insert({ project_id, kind: 'analysis', stage: 'analysis_queued', progress: 0, config: jobConfig })
    .select('id')
    .single()

  if (jobErr) {
    return new Response(JSON.stringify({ error: `Could not create job: ${jobErr.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // MUST await — edge isolates freeze on return, killing un-awaited fetches.
  // Background functions ack with 202 immediately.
  const siteUrl = Deno.env.get('URL') || new URL(request.url).origin
  const bgUrl = `${siteUrl}/.netlify/functions/analyze-project-background`
  try {
    const bgRes = await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, project_id }),
    })
    if (!bgRes.ok && bgRes.status !== 202) {
      throw new Error(`background function returned ${bgRes.status}`)
    }
  } catch (err) {
    await supabase
      .from('processing_jobs')
      .update({ stage: 'error', error: `Could not start analysis: ${err.message}` })
      .eq('id', job.id)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ job_id: job.id, sheet_count: count }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
