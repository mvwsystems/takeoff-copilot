// Synchronous diagnostic: replicates analyze-project-background's top-level
// imports and prompt-file load. A non-background function surfaces init/cold-
// start errors directly in the HTTP response, unlike background functions
// which swallow them behind a 202. Remove after debugging.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

export const handler = async () => {
  const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  const report = { ok: true, dirname: dir, steps: {} }

  // 1. createClient
  try {
    const c = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    report.steps.createClient = !!c
  } catch (e) { report.steps.createClient = `ERR: ${e.message}` }

  // 2. brain file load — try every candidate path, report which exist
  const candidates = [
    path.join(dir, 'server/prompts/takeoff-brain.md'),
    path.join(dir, '../../server/prompts/takeoff-brain.md'),
    path.join(process.cwd(), 'server/prompts/takeoff-brain.md'),
    path.join(process.env.LAMBDA_TASK_ROOT || '.', 'server/prompts/takeoff-brain.md'),
  ]
  report.steps.brain = candidates.map(p => {
    try { const s = fs.readFileSync(p, 'utf8'); return { p, ok: true, bytes: s.length } }
    catch (e) { return { p, ok: false, err: e.code || e.message } }
  })

  // 3. cwd listing + LAMBDA_TASK_ROOT
  report.cwd = process.cwd()
  report.lambdaRoot = process.env.LAMBDA_TASK_ROOT || null
  try { report.cwdFiles = fs.readdirSync(process.cwd()).slice(0, 40) } catch (e) { report.cwdFiles = `ERR: ${e.message}` }
  try { report.dirnameFiles = fs.readdirSync(__dirname).slice(0, 40) } catch (e) { report.dirnameFiles = `ERR: ${e.message}` }

  // 4. raw REST reachability (no job mutation — just a HEAD-ish select)
  try {
    const url = process.env.VITE_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const r = await fetch(`${url}/rest/v1/processing_jobs?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    report.steps.restReachable = `${r.status}`
  } catch (e) { report.steps.restReachable = `ERR: ${e.message}` }

  // 5. mupdf dynamic import
  try {
    const m = await import('mupdf')
    report.steps.mupdf = typeof m.Document?.openDocument === 'function'
  } catch (e) { report.steps.mupdf = `ERR: ${e.message}` }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report, null, 2) }
}
