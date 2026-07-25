import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import AdminPage from './pages/AdminPage'
import QuotePage from './pages/QuotePage'
import { useAuth } from './utils/AuthContext'

function ProtectedRoute({ children }) {
  const { session, loading } = useAuth()
  if (loading) return null
  if (!session) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  // Vendors land on /quote/<token> from an RFQ email — they're external
  // visitors, so the app chrome (login/dashboard nav) is hidden there.
  const { pathname } = useLocation()
  const isVendorPage = pathname.startsWith('/quote/')
  return (
    <>
      {!isVendorPage && <Navbar />}
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset" element={<ResetPasswordPage />} />
        <Route path="/quote/:token" element={<QuotePage />} />
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } />
        <Route path="/admin" element={
          <ProtectedRoute>
            <AdminPage />
          </ProtectedRoute>
        } />
      </Routes>
    </>
  )
}
