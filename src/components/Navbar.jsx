import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LogIn, LayoutDashboard, Home, LogOut } from 'lucide-react'
import { useAuth } from '../utils/AuthContext'
import './Navbar.css'

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const isDashboard = location.pathname === '/dashboard'

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <div className="brand-mark">T</div>
          <div className="brand-text">
            <span className="brand-name">Takeoff Copilot</span>
            <span className="brand-separator">//</span>
            <span className="brand-sub">Titan AI</span>
          </div>
        </Link>

        <div className="navbar-links">
          {isDashboard ? (
            <Link to="/" className="nav-link">
              <Home size={15} />
              <span>Home</span>
            </Link>
          ) : (
            <Link to="/dashboard" className="nav-link">
              <LayoutDashboard size={15} />
              <span>Dashboard</span>
            </Link>
          )}

          {user ? (
            <div className="nav-user">
              <span className="nav-user-email">{user.email}</span>
              <button className="btn btn-secondary nav-login" onClick={handleSignOut}>
                <LogOut size={15} />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <Link to="/login" className="btn btn-secondary nav-login">
              <LogIn size={15} />
              <span>Login</span>
            </Link>
          )}
        </div>
      </div>
    </nav>
  )
}
