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

  // Per-user daily analysis ceiling. Every run is real Opus spend ($3–8), so
  // an unbounded loop — malicious or accidental — must hit a wall. The RLS-
  // scoped join counts only the caller's own jobs.
  const cap = Number(Deno.env.get('QUOTA_ANALYSES_PER_DAY')) || 10
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: recentRuns } = await supabase
    .from('processing_jobs')
    .select('id, projects!inner(user_id)', { count: 'exact', head: true })
    .eq('kind', 'analysis')
    .gte('created_at', since)
  if (recentRuns != null && recentRuns >= cap) {
    return new Response(JSON.stringify({
      error: `Daily analysis limit reached (${cap} runs per 24h). Contact hello@6signal.co if you need more.`,
    }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  }

  // Calibration config: sanitize to known fields and valid model tiers.
  let jobConfig = null
  if (config && typeof config === 'object') {
    const TIERS = new Set(['opus', 'sonnet', 'haiku'])
    const models = {}
    for (const k of ['pass1', 'pass2', 'pass4', 'pass5', 'pass6', 'pass7']) {
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

  // Per-takeoff fair-use: bound COGS on giant sheet sets. Pad-site jobs are
  // well under this; a huge highway set is asked to trim or contact us.
  const SHEET_CAP = Number(Deno.env.get('MAX_SHEETS_PER_TAKEOFF')) || 60
  if (count > SHEET_CAP && !jobConfig?.calibration) {
    return new Response(JSON.stringify({
      error: `This plan set has ${count} sheets selected — the per-takeoff limit is ${SHEET_CAP}. Trim the sheet selection, or contact us for a heavy-civil plan.`,
      reason: 'too_many_sheets',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  // ── Billing gate ──────────────────────────────────────────
  // charge_project decides how this takeoff is covered (charged once per
  // project; re-runs/retries free). Order: subscription quota → pay-as-you-go
  // credit → 2 free-trial takeoffs → blocked. When Stripe isn't configured
  // billing is off and everything runs free. Calibration runs never charge.
  const billingOn = !!Deno.env.get('STRIPE_SECRET_KEY')
  let charged = false
  let chargeSource = null
  if (billingOn && !jobConfig?.calibration) {
    const svc = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    const { data: outcome, error: chargeErr } = await svc.rpc('charge_project', {
      p_project: project_id, p_user: user.id,
    })
    if (chargeErr) {
      return new Response(JSON.stringify({ error: 'Could not start this takeoff — try again.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (outcome === 'insufficient') {
      // Out of monthly takeoffs / trial / credits → the UI opens the plans + overage.
      return new Response(JSON.stringify({ error: 'payment_required', reason: 'out_of_takeoffs' }), {
        status: 402, headers: { 'Content-Type': 'application/json' },
      })
    }
    chargeSource = outcome                        // subscription | credit | trial | already_paid | admin_free
    charged = ['subscription', 'credit', 'trial'].includes(outcome)
  }

  // Refund if the run can't actually launch — never charge for a takeoff that
  // never started. Undo whichever way it was covered (credit vs quota/trial ledger).
  const refundIfCharged = async () => {
    if (!charged) return
    const svc = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    if (chargeSource === 'credit') {
      await svc.rpc('grant_credits', { p_user: user.id, p_qty: 1, p_session: `refund_${project_id}_${Date.now()}` })
    } else {
      // subscription/trial were recorded as zero-delta ledger rows against this
      // project; clearing paid_at frees the slot and the ledger row is harmless.
      await svc.from('credit_ledger').delete().eq('project_id', project_id).in('reason', ['subscription_use', 'trial'])
    }
    await svc.from('projects').update({ paid_at: null }).eq('id', project_id)
  }

  const { data: job, error: jobErr } = await supabase
    .from('processing_jobs')
    .insert({ project_id, kind: 'analysis', stage: 'analysis_queued', progress: 0, config: jobConfig })
    .select('id')
    .single()

  if (jobErr) {
    await refundIfCharged()
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
      headers: {
        'Content-Type': 'application/json',
        'x-fn-secret': Deno.env.get('WEBHOOK_SECRET') || '',
      },
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
    await refundIfCharged()
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ job_id: job.id, sheet_count: count, charged, charge_source: chargeSource }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
