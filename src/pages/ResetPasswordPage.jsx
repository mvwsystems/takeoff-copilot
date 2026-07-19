import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import './LoginPage.css'

// Landing page for Supabase password-recovery links. The recovery link signs
// the user in (AuthContext routes them here on PASSWORD_RECOVERY); this form
// sets the new password.
export default function ResetPasswordPage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setSaving(true)
    const { error: updErr } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (updErr) { setError(updErr.message); return }
    navigate('/dashboard', { replace: true })
  }

  if (loading) return null

  return (
    <div className="login-page">
      <div className="login-card card animate-in">
        <div className="login-header">
          <h3>Reset Password</h3>
          <span className="titan-label">Takeoff Copilot</span>
        </div>

        {!session ? (
          <p className="text-muted" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            This reset link is invalid or has expired.{' '}
            <Link to="/login" style={{ color: 'var(--titan-red)' }}>
              Request a new one from the login page.
            </Link>
          </p>
        ) : (
          <form className="login-form" onSubmit={submit}>
            <div className="form-group">
              <label className="titan-label" htmlFor="new-password">New Password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label className="titan-label" htmlFor="confirm-password">Confirm Password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            {error && (
              <div style={{
                fontSize: '0.82rem', padding: '10px 12px', borderRadius: 2,
                border: '1px solid #5a2320', background: '#2a1513', color: '#f0b9b4',
              }}>{error}</div>
            )}
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Set New Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
