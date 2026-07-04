// Temporary diagnostic: rescores stored analysis results against their own
// engineer rows using the current (improved) matcher. Returns aggregate
// metrics only — no plan content. Remove after the calibration comparison.

import { createClient } from '@supabase/supabase-js'
import { buildVariance, varianceMetrics } from './analyze-project-background.mjs'

export const handler = async (event) => {
  const project = event.queryStringParameters?.project
  if (!project) return { statusCode: 400, body: 'pass ?project=' }

  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await supabase.from('analysis_results')
    .select('created_at, result_json').eq('project_id', project)
    .order('created_at', { ascending: false }).limit(5)
  if (error) return { statusCode: 500, body: error.message }

  const out = (data || []).map(r => {
    const rj = r.result_json
    const engRows = (rj.variance_table || []).map(v => ({
      description: v.engineer_description, quantity: v.engineer_quantity, unit: v.unit,
    }))
    return {
      created_at: r.created_at,
      label: rj.config?.label || 'pre-harness',
      items: rj.items?.length,
      cost: rj.run_cost?.est_usd ?? null,
      rescored_vs_engineer: engRows.length ? varianceMetrics(buildVariance(engRows, rj.items || [])) : null,
    }
  })
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) }
}
