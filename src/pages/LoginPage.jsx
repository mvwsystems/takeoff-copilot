import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import './LoginPage.css'

export default function LoginPage() {
  const { session } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (session) navigate('/dashboard', { replace: true })
  }, [session, navigate])

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

        <Auth
          supabaseClient={supabase}
          providers={[]}
          appearance={{
            theme: ThemeSupa,
            variables: {
              default: {
                colors: {
                  brand: '#E8372C',
                  brandAccent: '#FF4438',
                  brandButtonText: '#F5F5F0',
                  defaultButtonBackground: '#161616',
                  defaultButtonBackgroundHover: '#1A1A1A',
                  defaultButtonBorder: '#333333',
                  defaultButtonText: '#CCCCCC',
                  dividerBackground: '#222222',
                  inputBackground: '#111111',
                  inputBorder: '#222222',
                  inputBorderHover: '#E8372C',
                  inputBorderFocus: '#E8372C',
                  inputText: '#F5F5F0',
                  inputPlaceholder: '#555555',
                  inputLabelText: '#888888',
                  messageText: '#CCCCCC',
                  messageTextDanger: '#E8372C',
                  anchorTextColor: '#E8372C',
                  anchorTextHoverColor: '#FF4438',
                },
                fonts: {
                  bodyFontFamily: `'Outfit', -apple-system, sans-serif`,
                  buttonFontFamily: `'Outfit', -apple-system, sans-serif`,
                  inputFontFamily: `'Outfit', -apple-system, sans-serif`,
                  labelFontFamily: `'Outfit', -apple-system, sans-serif`,
                },
                fontSizes: {
                  baseBodySize: '14px',
                  baseInputSize: '14px',
                  baseLabelSize: '11px',
                  baseButtonSize: '14px',
                },
                space: {
                  buttonPadding: '10px 20px',
                  inputPadding: '10px 14px',
                },
                borderWidths: {
                  buttonBorderWidth: '1px',
                  inputBorderWidth: '1px',
                },
                radii: {
                  borderRadiusButton: '2px',
                  buttonBorderRadius: '2px',
                  inputBorderRadius: '2px',
                },
              },
            },
            style: {
              button: { textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: '600' },
              anchor: { fontSize: '0.78rem' },
              message: { fontSize: '0.78rem' },
              label: { textTransform: 'uppercase', letterSpacing: '1.5px' },
            },
          }}
          localization={{
            variables: {
              sign_in: { email_label: 'Email', password_label: 'Password', button_label: 'Sign In', link_text: 'Already have an account? Sign in' },
              sign_up: { email_label: 'Email', password_label: 'Password', button_label: 'Create Account', link_text: "Don't have an account? Sign up" },
            },
          }}
        />

        <div className="login-footer">
          <span className="text-muted" style={{ fontSize: '0.72rem' }}>
            Need access? <a href="mailto:matt@growwithtitan.com" style={{ color: 'var(--titan-red)' }}>Contact Titan AI</a>
          </span>
        </div>
      </div>
    </div>
  )
}
