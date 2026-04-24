import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, FileText, ChevronDown, ChevronRight, Download } from 'lucide-react'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import './AdminPage.css'

const ADMIN_EMAIL = 'mattvincentwalker@gmail.com'

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
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    if (loading) return
    if (!user) { navigate('/login', { replace: true }); return }
    if (user.email !== ADMIN_EMAIL) { navigate('/dashboard', { replace: true }); return }

    const load = async () => {
      setFetching(true)
      const [{ data: p, error: pe }, { data: j, error: je }] = await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: false }),
        supabase.from('jobs').select('id, user_id, plan_filename, geotech_filename, screening_grade, line_item_count, risk_flag_count, created_at').order('created_at', { ascending: false }),
      ])
      if (pe || je) setError((pe || je).message)
      setProfiles(p || [])
      setJobs(j || [])
      setFetching(false)
    }
    load()
  }, [user, loading, navigate])

  const jobsByUser = jobs.reduce((acc, j) => {
    if (!acc[j.user_id]) acc[j.user_id] = []
    acc[j.user_id].push(j)
    return acc
  }, {})

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
          <button className="btn btn-secondary" onClick={exportCSV} style={{ marginLeft: 16 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
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
                                <th>Line Items</th>
                                <th>Risk Flags</th>
                                <th>Date</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userJobs.map(j => (
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
                                  <td className="admin-date">{formatDate(j.created_at)}</td>
                                </tr>
                              ))}
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
