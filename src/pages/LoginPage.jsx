import { useState } from 'react'
import { LogIn, Lock, Mail } from 'lucide-react'
import './LoginPage.css'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    // Auth will be implemented with backend
    alert('Authentication coming soon. Use the Dashboard directly for now.')
  }

  return (
    <div className="login-page">
      <div className="login-card card animate-in">
        <div className="login-header">
          <div className="login-brand">
            <div style={{
              width: 40, height: 40, background: 'var(--titan-red)', color: 'var(--titan-white)',
              fontFamily: 'var(--font-display)', fontSize: '1.5rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              clipPath: 'polygon(0 0, 100% 0, 100% 85%, 85% 100%, 0 100%)'
            }}>T</div>
          </div>
          <h3>Takeoff Copilot</h3>
          <span className="titan-label">Secure Access</span>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label className="titan-label">Email</label>
            <div className="input-wrap">
              <Mail size={16} className="input-icon" />
              <input type="email" className="input input-with-icon" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="titan-label">Password</label>
            <div className="input-wrap">
              <Lock size={16} className="input-icon" />
              <input type="password" className="input input-with-icon" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>
            <LogIn size={16} /> Sign In
          </button>
        </form>

        <div className="login-footer">
          <span className="text-muted" style={{ fontSize: '0.72rem' }}>
            Don't have an account? <a href="mailto:matt@growwithtitan.com" style={{ color: 'var(--titan-red)' }}>Contact Titan AI</a>
          </span>
        </div>
      </div>
    </div>
  )
}
