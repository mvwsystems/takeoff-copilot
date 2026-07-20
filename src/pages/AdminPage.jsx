import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, FileText, ChevronDown, ChevronRight, Download, FlaskConical, Upload } from 'lucide-react'
import { parseTakeoffFile } from '../utils/parseTakeoff'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import './AdminPage.css'

// Keep in sync with the is_admin() SQL function (migration 009) — the RLS
// policies are what actually grant cross-user reads; this list only gates the UI.
const ADMIN_EMAILS = new Set([
  'mattvincentwalker@gmail.com',
  'mvw@mattvincentwalker.com',
  'hello@6signal.co',
])

// Model tier per pass: pass1 plan quantities, pass2 profiles, pass4 small-dia
// sweep, pass5 engineer tables. Merge/assembly is always Haiku.
const CAL_PRESETS = [
  { id: 'baseline', label: 'Opus baseline', models: { pass1: 'opus', pass2: 'opus', pass4: 'opus', pass5: 'haiku' } },
  { id: 'sonnet', label: 'Sonnet 5 extraction', models: { pass1: 'sonnet', pass2: 'sonnet', pass4: 'sonnet', pass5: 'haiku' } },
  { id: 'budget', label: 'Budget (Sonnet + Haiku sweep)', models: { pass1: 'sonnet', pass2: 'sonnet', pass4: 'haiku', pass5: 'haiku' } },
]

const modelsShort = (models) => ['pass1', 'pass2', 'pass4', 'pass5']
  .map(k => (models?.[k] || (k === 'pass5' ? 'haiku' : 'opus'))[0].toUpperCase()).join('/')

// Same metric shape the pipeline computes — used as a fallback for older
// results that carry a variance_table but no calibration_score.
const varianceMetricsClient = (variance) => {
  if (!variance?.length) return null
  const matched = variance.filter(v => v.pct_difference != null)
  return {
    matched: matched.length,
    within_5: matched.filter(v => Math.abs(v.pct_difference) <= 5).length,
    within_15: matched.filter(v => Math.abs(v.pct_difference) <= 15).length,
    mean_abs_pct: matched.length ? Math.round(matched.reduce((s, v) => s + Math.abs(v.pct_difference), 0) / matched.length * 10) / 10 : null,
    missing_from_ours: variance.filter(v => v.status === 'MISSING_FROM_OURS').length,
  }
}

const ScoreCell = ({ s }) => {
  if (!s) return <span className="text-muted">—</span>
  return (
    <span className="cal-score">
      <strong>{s.within_5}/{s.matched}</strong> ±5% · μΔ {s.mean_abs_pct != null ? `${s.mean_abs_pct}%` : '—'} · {s.missing_from_ours} missed
    </span>
  )
}

function formatDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function GradeBadge({ grade }) {
  if (!grade) return <span className="admin-grade-none">—</span>
  const cls = grade === 'A' ? 'admin-grade-a' : grade === 'B' ? 'admin-grade-b' : 'admin-grade-c'
  return <span className={`admin-grade ${cls}`}>{grade}</span>
}

export default function AdminPage() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [jobs, setJobs] = useState([])
  const [feedback, setFeedback] = useState([])
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState({})
  const [accuracy, setAccuracy] = useState(null)
  const [corrections, setCorrections] = useState([])

  // ── Calibration state ──
  const [calProjects, setCalProjects] = useState([])
  const [calProject, setCalProject] = useState('')
  const [calRuns, setCalRuns] = useState([])
  const [calPresets, setCalPresets] = useState({ baseline: false, sonnet: true, budget: false })
  const [calTruth, setCalTruth] = useState(null)     // parsed rows pending upload
  const [calTruthName, setCalTruthName] = useState(null)
  const [calLaunching, setCalLaunching] = useState(false)
  const [calMsg, setCalMsg] = useState(null)
  const calFileRef = useRef(null)

  const loadCalRuns = useCallback(async (projectId) => {
    if (!projectId) { setCalRuns([]); return }
    const { data: jobRows } = await supabase
      .from('processing_jobs')
      .select('id, stage, progress, stage_detail, error, created_at, config')
      .eq('project_id', projectId).eq('kind', 'analysis')
      .order('created_at', { ascending: false }).limit(20)
    const ids = (jobRows || []).map(j => j.id)
    let resultsByJob = {}
    if (ids.length) {
      const { data: results } = await supabase
        .from('analysis_results')
        .select('job_id, created_at, result_json')
        .in('job_id', ids).order('created_at', { ascending: false })
      for (const r of results || []) {
        if (!resultsByJob[r.job_id]) resultsByJob[r.job_id] = r.result_json
      }
    }
    setCalRuns((jobRows || []).map(j => ({ ...j, result: resultsByJob[j.id] || null })))
  }, [])

  useEffect(() => {
    if (!user || !ADMIN_EMAILS.has(user.email)) return
    supabase.from('projects')
      .select('id, name, created_at, calibration_truth')
      .order('created_at', { ascending: false }).limit(25)
      .then(({ data }) => {
        setCalProjects(data || [])
        if (data?.length && !calProject) setCalProject(data[0].id)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => { loadCalRuns(calProject) }, [calProject, loadCalRuns])

  // Poll while any calibration run is still working
  useEffect(() => {
    const active = calRuns.some(r => r.stage !== 'complete' && r.stage !== 'error')
    if (!active) return
    const t = setInterval(() => loadCalRuns(calProject), 20000)
    return () => clearInterval(t)
  }, [calRuns, calProject, loadCalRuns])

  const handleTruthUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    setCalMsg('Reading takeoff…')
    try {
      const rows = await parseTakeoffFile(file)
      setCalTruth(rows)
      setCalTruthName(file.name)
      setCalMsg(`${rows.length} ground-truth rows parsed — will attach on launch.`)
    } catch (err) {
      setCalMsg(`Parse failed: ${err.message}`)
    }
  }

  const launchCalibration = async () => {
    const selected = CAL_PRESETS.filter(p => calPresets[p.id])
    if (!calProject || !selected.length) return
    setCalLaunching(true)
    setCalMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` }
      for (let i = 0; i < selected.length; i++) {
        const p = selected[i]
        const res = await fetch('/api/start-analysis', {
          method: 'POST', headers,
          body: JSON.stringify({
            project_id: calProject,
            config: { calibration: true, label: p.label, models: p.models },
            ...(i === 0 && calTruth ? { ground_truth: calTruth } : {}),
          }),
        })
        if (!res.ok) throw new Error(`${p.label}: ${(await res.text()).slice(0, 120)}`)
      }
      setCalMsg(`Launched ${selected.length} calibration run${selected.length > 1 ? 's' : ''}. Scores appear below as each completes.`)
      setCalTruth(null); setCalTruthName(null)
      setTimeout(() => loadCalRuns(calProject), 1500)
    } catch (err) {
      setCalMsg(`Launch failed: ${err.message}`)
    } finally {
      setCalLaunching(false)
    }
  }

  useEffect(() => {
    if (loading) return
    if (!user) { navigate('/login', { replace: true }); return }
    if (!ADMIN_EMAILS.has(user.email)) { navigate('/dashboard', { replace: true }); return }

    const load = async () => {
      setFetching(true)
      const [{ data: p, error: pe }, { data: j, error: je }, { data: f }] = await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: false }),
        supabase.from('jobs').select('id, user_id, plan_filename, geotech_filename, screening_grade, line_item_count, risk_flag_count, created_at').order('created_at', { ascending: false }),
        supabase.from('feedback').select('id, job_id, rating, corrections, comments, created_at').order('created_at', { ascending: false }),
      ])
      if (pe || je) setError((pe || je).message)
      setProfiles(p || [])
      setJobs(j || [])
      setFeedback(f || [])
      setFetching(false)

      // House accuracy rollup + recent corrections feed.
      const [{ data: acc }, { data: corr }] = await Promise.all([
        supabase.rpc('accuracy_stats'),
        supabase.from('corrections').select('item_no, description, field, original_value, corrected_value, source, screening_grade, created_at').order('created_at', { ascending: false }).limit(40),
      ])
      if (acc && !acc.error) setAccuracy(acc)
      setCorrections(corr || [])
    }
    load()
  }, [user, loading, navigate])

  const jobsByUser = jobs.reduce((acc, j) => {
    if (!acc[j.user_id]) acc[j.user_id] = []
    acc[j.user_id].push(j)
    return acc
  }, {})

  const feedbackByJob = feedback.reduce((acc, f) => {
    acc[f.job_id] = f
    return acc
  }, {})

  const totalFeedback = feedback.length
  const avgRating = feedback.length
    ? (feedback.reduce((s, f) => s + (f.rating || 0), 0) / feedback.length).toFixed(1)
    : '—'

  const exportCSV = () => {
    const BOM = '﻿'
    const header = ['Email', 'Name', 'Company', 'Phone', 'Joined', 'Jobs Run', 'Last Job']
    const rows = profiles.map(p => {
      const userJobs = jobsByUser[p.id] || []
      return [
        p.email,
        p.full_name || '',
        p.company || '',
        p.phone || '',
        formatDate(p.created_at),
        userJobs.length,
        userJobs.length ? formatDate(userJobs[0].created_at) : '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    })
    const csv = BOM + [header.join(','), ...rows].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `takeoff-copilot-beta-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
  }

  if (loading || fetching) {
    return (
      <div className="admin-loading">
        <div className="spinner" />
        <span>Loading beta data...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="admin-error">
        <p>Error loading data: {error}</p>
        <p className="text-dim" style={{ fontSize: '0.82rem', marginTop: 8 }}>
          Make sure the profiles and jobs tables exist in Supabase with the correct RLS policies.
        </p>
      </div>
    )
  }

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h2>Beta Dashboard</h2>
          <span className="titan-label">Takeoff Copilot &mdash; Contractor Testing</span>
        </div>
        <div className="admin-header-stats">
          <div className="admin-stat">
            <span className="admin-stat-value">{profiles.length}</span>
            <span className="admin-stat-label">Testers</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-value">{jobs.length}</span>
            <span className="admin-stat-label">Jobs Run</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-value">
              {jobs.length && profiles.length ? (jobs.length / profiles.length).toFixed(1) : '—'}
            </span>
            <span className="admin-stat-label">Jobs/User</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-value">{totalFeedback}</span>
            <span className="admin-stat-label">Feedback</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-value">{avgRating}</span>
            <span className="admin-stat-label">Avg Rating</span>
          </div>
          <button className="btn btn-secondary" onClick={exportCSV} style={{ marginLeft: 16 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── HOUSE ACCURACY ── */}
      {accuracy && (
        <div className="cal-section" style={{ marginBottom: 20 }}>
          <div className="cal-header">
            <span className="cal-title">House Accuracy</span>
            <span className="titan-label" style={{ fontSize: '0.62rem' }}>Agreement = share of AI line items the estimator did not correct</span>
          </div>
          <div className="admin-header-stats" style={{ padding: '14px 0', flexWrap: 'wrap', gap: 20 }}>
            <div className="admin-stat">
              <span className="admin-stat-value" style={{ color: 'var(--titan-red)' }}>{accuracy.agreement_rate != null ? `${accuracy.agreement_rate}%` : '—'}</span>
              <span className="admin-stat-label">Agreement Rate</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-value">{accuracy.takeoffs || 0}</span>
              <span className="admin-stat-label">Takeoffs</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-value">{(accuracy.line_items || 0).toLocaleString()}</span>
              <span className="admin-stat-label">Line Items</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-value">{accuracy.edited_items || 0}</span>
              <span className="admin-stat-label">Corrected</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-value">
                {accuracy.engineer_matched ? `${Math.round((accuracy.engineer_within_5 / accuracy.engineer_matched) * 100)}%` : '—'}
              </span>
              <span className="admin-stat-label">Within 5% of Engineer</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-value">
                {accuracy.engineer_matched ? `${Math.round((accuracy.engineer_within_15 / accuracy.engineer_matched) * 100)}%` : '—'}
              </span>
              <span className="admin-stat-label">Within 15%</span>
            </div>
          </div>

          {accuracy.by_grade?.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              {accuracy.by_grade.filter(g => g.grade !== '?').map(g => (
                <div key={g.grade} style={{
                  padding: '8px 14px', border: '1px solid var(--titan-border)', borderRadius: 6,
                  background: 'var(--titan-card)', fontSize: '0.8rem',
                }}>
                  <strong>Grade {g.grade}</strong>: {g.agreement != null ? `${g.agreement}% agreement` : '—'}
                  <span className="text-dim"> · {g.total} items</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-dim" style={{ fontSize: '0.72rem', lineHeight: 1.6, marginTop: 6 }}>
            Marketing-ready when the sample is large enough: e.g. &ldquo;{accuracy.by_grade?.find(g => g.grade === 'A')?.agreement ?? '—'}% agreement on Grade A across {accuracy.by_grade?.find(g => g.grade === 'A')?.total ?? 0} line items.&rdquo;
            {accuracy.corrections != null && ` ${accuracy.corrections} corrections captured for rule drafting.`}
          </p>

          {corrections.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.78rem', color: 'var(--titan-text)' }}>
                Recent corrections ({corrections.length}) — the raw material for Brain rules
              </summary>
              <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
                <table className="titan-table" style={{ fontSize: '0.72rem' }}>
                  <thead><tr>{['When', 'Grade', 'Field', 'Item', 'Was', 'Now', 'Via'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {corrections.map((c, i) => (
                      <tr key={i}>
                        <td className="text-dim">{formatDate(c.created_at)}</td>
                        <td>{c.screening_grade || '—'}</td>
                        <td>{c.field}</td>
                        <td style={{ maxWidth: 220 }}>{c.description || `#${c.item_no ?? '—'}`}</td>
                        <td className="text-dim">{c.original_value ?? '—'}</td>
                        <td style={{ fontWeight: 600 }}>{c.corrected_value ?? '—'}</td>
                        <td className="text-dim">{c.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── CALIBRATION HARNESS ── */}
      <div className="cal-section">
        <div className="cal-header">
          <span className="cal-title"><FlaskConical size={15} /> Calibration Harness</span>
          <span className="cal-subtitle">Run the same project through different model configs — scores vs the engineer's quantity table and (optionally) a verified ground-truth takeoff</span>
        </div>

        <div className="cal-controls">
          <select className="cal-select" value={calProject} onChange={e => setCalProject(e.target.value)}>
            {!calProjects.length && <option value="">No projects yet</option>}
            {calProjects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name || p.id.slice(0, 8)}{p.calibration_truth?.length ? ` (truth: ${p.calibration_truth.length} rows)` : ''}
              </option>
            ))}
          </select>

          {CAL_PRESETS.map(p => (
            <label key={p.id} className="cal-preset">
              <input
                type="checkbox"
                checked={!!calPresets[p.id]}
                onChange={e => setCalPresets(prev => ({ ...prev, [p.id]: e.target.checked }))}
              />
              {p.label} <span className="cal-models">{modelsShort(p.models)}</span>
            </label>
          ))}

          <button className="btn btn-ghost" style={{ fontSize: '0.72rem' }} onClick={() => calFileRef.current?.click()}>
            <Upload size={12} /> {calTruthName || 'Ground truth (PDF/CSV/XLSX)'}
          </button>
          <input ref={calFileRef} type="file" accept=".csv,.xlsx,.xls,.pdf" onChange={handleTruthUpload} style={{ display: 'none' }} />

          <button
            className="btn btn-primary"
            disabled={calLaunching || !calProject || !CAL_PRESETS.some(p => calPresets[p.id])}
            onClick={launchCalibration}
          >
            {calLaunching ? 'Launching…' : 'Run Calibration'}
          </button>
        </div>

        {calMsg && <div className="cal-msg">{calMsg}</div>}

        {calRuns.length > 0 && (
          <div className="admin-table-wrap cal-runs-wrap" style={{ marginTop: 10 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Config</th><th>Models</th><th>Status</th><th>Items</th><th>Cost</th>
                  <th>vs Engineer Table</th><th>vs Ground Truth</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {calRuns.map(r => {
                  const res = r.result
                  const score = res?.calibration_score
                  const vsEng = score?.vs_engineer || varianceMetricsClient(res?.variance_table)
                  const done = r.stage === 'complete'
                  return (
                    <tr key={r.id}>
                      <td>{r.config?.label || res?.config?.label || 'Standard (Opus)'}</td>
                      <td className="cal-models">{modelsShort(r.config?.models || res?.config?.models)}</td>
                      <td>
                        {r.stage === 'error'
                          ? <span style={{ color: 'var(--titan-red)' }} title={r.error}>error</span>
                          : done ? '✓ complete' : `${r.progress || 0}% — ${r.stage_detail || r.stage}`}
                      </td>
                      <td>{res?.summary?.total_items ?? '—'}</td>
                      <td>{res?.run_cost?.est_usd != null ? `$${res.run_cost.est_usd}` : '—'}</td>
                      <td><ScoreCell s={vsEng} /></td>
                      <td><ScoreCell s={score?.vs_truth} /></td>
                      <td className="admin-date">{formatDate(r.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {profiles.length === 0 ? (
        <div className="admin-empty">
          <Users size={32} style={{ color: 'var(--titan-text-muted)', marginBottom: 12 }} />
          <p>No beta testers yet.</p>
          <p className="text-dim" style={{ fontSize: '0.82rem', marginTop: 4 }}>
            Profiles appear here once a contractor signs up and completes onboarding.
          </p>
        </div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Company</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Joined</th>
                <th>Jobs</th>
                <th>Last Job</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => {
                const userJobs = jobsByUser[p.id] || []
                const isOpen = expanded[p.id]
                return [
                  <tr
                    key={p.id}
                    className={`admin-row ${isOpen ? 'admin-row-open' : ''}`}
                    onClick={() => setExpanded(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                  >
                    <td className="admin-expand-cell">
                      {userJobs.length > 0
                        ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
                        : <span style={{ width: 14, display: 'inline-block' }} />}
                    </td>
                    <td className="admin-name">{p.full_name || <span className="text-muted">—</span>}</td>
                    <td>{p.company || <span className="text-muted">—</span>}</td>
                    <td className="admin-email">{p.email}</td>
                    <td>{p.phone || <span className="text-muted">—</span>}</td>
                    <td className="admin-date">{formatDate(p.created_at)}</td>
                    <td>
                      <span className="admin-job-count">{userJobs.length}</span>
                    </td>
                    <td className="admin-date">
                      {userJobs.length ? formatDate(userJobs[0].created_at) : <span className="text-muted">—</span>}
                    </td>
                  </tr>,
                  isOpen && userJobs.length > 0 && (
                    <tr key={`${p.id}-jobs`} className="admin-jobs-row">
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div className="admin-jobs-panel">
                          <table className="admin-jobs-table">
                            <thead>
                              <tr>
                                <th>Plan File</th>
                                <th>Geotech File</th>
                                <th>Grade</th>
                                <th>Items</th>
                                <th>Flags</th>
                                <th>Rating</th>
                                <th>Contractor Notes</th>
                                <th>Date</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userJobs.map(j => {
                                const fb = feedbackByJob[j.id]
                                return (
                                  <tr key={j.id}>
                                    <td>
                                      {j.plan_filename
                                        ? <span className="admin-filename"><FileText size={11} /> {j.plan_filename}</span>
                                        : <span className="text-muted">—</span>}
                                    </td>
                                    <td>
                                      {j.geotech_filename
                                        ? <span className="admin-filename"><FileText size={11} /> {j.geotech_filename}</span>
                                        : <span className="text-muted">—</span>}
                                    </td>
                                    <td><GradeBadge grade={j.screening_grade} /></td>
                                    <td>{j.line_item_count ?? '—'}</td>
                                    <td>{j.risk_flag_count ?? '—'}</td>
                                    <td>
                                      {fb ? (
                                        <span className="admin-rating">
                                          {'★'.repeat(fb.rating)}{'☆'.repeat(5 - fb.rating)}
                                        </span>
                                      ) : <span className="text-muted">—</span>}
                                    </td>
                                    <td style={{ maxWidth: 260 }}>
                                      {fb?.corrections && <div className="admin-feedback-text">{fb.corrections}</div>}
                                      {fb?.comments && <div className="admin-feedback-text admin-feedback-comment">{fb.comments}</div>}
                                      {!fb && <span className="text-muted">—</span>}
                                    </td>
                                    <td className="admin-date">{formatDate(j.created_at)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
