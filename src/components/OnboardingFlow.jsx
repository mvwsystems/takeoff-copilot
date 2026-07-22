import { useState, useEffect, useRef } from 'react'
import {
  Upload, LayoutGrid, Layers, FileCheck,
  BookOpen, FileText, Gauge, ArrowRight, ArrowLeft,
  MessageCircleQuestion, Flag, ShieldCheck, DollarSign,
} from 'lucide-react'
import './OnboardingFlow.css'

const TOTAL_STEPS = 5

/**
 * Multi-step onboarding sequence.
 *
 * Props:
 * - open            boolean — render/hide the flow
 * - initialProfile  { full_name, company, phone } — pre-fills the profile step
 * - onComplete      (profile) => void — receives { full_name, company, phone }
 * - onSkip          () => void — close without completing
 */
export default function OnboardingFlow({ open, initialProfile, onComplete, onSkip, billingLive = false }) {
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState('fwd')
  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const [profile, setProfile] = useState({ full_name: '', company: '', phone: '' })
  const nameInputRef = useRef(null)

  // Reset + seed profile every time the flow opens
  useEffect(() => {
    if (open) {
      setStep(0)
      setDir('fwd')
      setConfirmingSkip(false)
      setProfile({
        full_name: initialProfile?.full_name || '',
        company: initialProfile?.company || '',
        phone: initialProfile?.phone || '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Focus the first input when the profile step arrives
  useEffect(() => {
    if (open && step === 1 && nameInputRef.current) {
      nameInputRef.current.focus()
    }
  }, [open, step])

  const goNext = () => {
    if (step >= TOTAL_STEPS - 1) {
      onComplete(profile)
    } else {
      setDir('fwd')
      setStep(s => s + 1)
    }
  }

  const goBack = () => {
    if (step > 0) {
      setDir('back')
      setStep(s => s - 1)
    }
  }

  // Keyboard: Enter advances, Escape opens the skip confirmation
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirmingSkip(c => !c) // second Escape cancels the confirmation
        return
      }
      if (e.key === 'Enter') {
        // Buttons handle their own Enter — avoid double-advancing
        if (e.target && e.target.tagName === 'BUTTON') return
        e.preventDefault()
        if (confirmingSkip) {
          setConfirmingSkip(false) // Enter = keep going
        } else {
          goNext()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, confirmingSkip, profile])

  if (!open) return null

  const setField = (field) => (e) =>
    setProfile(p => ({ ...p, [field]: e.target.value }))

  const howItWorks = [
    { icon: Upload, title: 'Upload your PDF', desc: 'Drop in the plan set — up to 100 MB.' },
    { icon: LayoutGrid, title: 'Sheets auto-classified', desc: 'You pick which sheets to analyze.' },
    { icon: Layers, title: '6-pass AI analysis', desc: 'Plan quantities, profiles, grading-plan depths, merge, small-line sweep, engineer-table check.' },
    { icon: FileCheck, title: 'Review & export', desc: 'Answer the AI’s questions, then export.' },
  ]

  const trustPoints = [
    {
      icon: ShieldCheck,
      title: 'Every quantity is graded',
      desc: 'Each line carries a HIGH / MED / LOW confidence rating and a note explaining it.',
    },
    {
      icon: MessageCircleQuestion,
      title: 'The AI asks you',
      desc: 'When it can’t pin something down — depths, mismatched lengths — it asks, and your answers tighten the takeoff.',
    },
    {
      icon: Flag,
      title: 'Gaps are flagged loudly',
      desc: 'Coverage gaps and raster-only sets are called out up front, never hidden.',
    },
  ]

  const readyItems = [
    // Pricing line only appears once billing is live (VITE_BILLING_ENABLED),
    // so testers in the free window aren't told about a charge that won't happen.
    ...(billingLive ? [{ icon: DollarSign, text: 'Start with 2 free takeoffs — no card. Then plans from $197/mo (Solo, 20 takeoffs). A takeoff is one full plan set; re-runs and exports are included.' }] : []),
    { icon: FileText, text: 'Have your plan PDF ready — up to 100 MB.' },
    { icon: Gauge, text: 'Best fit: single-level pad sites & site-civil plans (storm, sanitary, water). Not built for multi-level building risers.' },
    { icon: BookOpen, text: 'The Reference Bank (book icon, top bar) answers questions any time.' },
  ]

  return (
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-label="Takeoff Copilot onboarding">
      <div className="onb-card" onClick={e => e.stopPropagation()}>

        {/* Skip link */}
        <button
          type="button"
          className="onb-skip-link"
          onClick={() => setConfirmingSkip(true)}
        >
          Skip setup
        </button>

        {/* Step content — keyed so the transition replays each step */}
        <div key={step} className={`onb-step-body ${dir === 'fwd' ? 'onb-anim-fwd' : 'onb-anim-back'}`}>

          {step === 0 && (
            <div className="onb-step onb-step-welcome">
              <img src="/logo-ascent-blue.svg" alt="" className="onb-logo-mark" />
              <div className="onb-kicker"><span className="onb-slashes">//</span> WELCOME</div>
              <h2 className="onb-title onb-title-brand">
                TAKEOFF <span className="onb-accent-text">COPILOT</span>
              </h2>
              <p className="onb-lede">
                Upload plan sheets, get a structured wet-utility takeoff with depths,
                flags, and an audit trail.
              </p>
              <p className="onb-sub">Setup takes under a minute.</p>
            </div>
          )}

          {step === 1 && (
            <div className="onb-step">
              <div className="onb-kicker"><span className="onb-slashes">//</span> STEP 01</div>
              <h2 className="onb-title">Your Profile</h2>
              <p className="onb-lede onb-lede-sm">
                Used for support and your report headers. All fields optional — but they
                make your exports look sharp.
              </p>
              <div className="onb-form">
                <div className="onb-field-row">
                  <div className="onb-field">
                    <label className="onb-label" htmlFor="onb-name">Full Name</label>
                    <input
                      id="onb-name"
                      ref={nameInputRef}
                      type="text"
                      className="onb-input"
                      placeholder="John Smith"
                      value={profile.full_name}
                      onChange={setField('full_name')}
                      autoComplete="name"
                    />
                  </div>
                  <div className="onb-field">
                    <label className="onb-label" htmlFor="onb-company">Company</label>
                    <input
                      id="onb-company"
                      type="text"
                      className="onb-input"
                      placeholder="Smith Utility Contractors"
                      value={profile.company}
                      onChange={setField('company')}
                      autoComplete="organization"
                    />
                  </div>
                </div>
                <div className="onb-field">
                  <label className="onb-label" htmlFor="onb-phone">Phone Number</label>
                  <input
                    id="onb-phone"
                    type="tel"
                    className="onb-input"
                    placeholder="(555) 000-0000"
                    value={profile.phone}
                    onChange={setField('phone')}
                    autoComplete="tel"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="onb-step">
              <div className="onb-kicker"><span className="onb-slashes">//</span> STEP 02</div>
              <h2 className="onb-title">How It Works</h2>
              <div className="onb-strip">
                {howItWorks.map(({ icon: Icon, title, desc }, i) => (
                  <div className="onb-strip-item" key={title}>
                    <div className="onb-strip-icon"><Icon size={18} strokeWidth={1.75} /></div>
                    <div className="onb-strip-text">
                      <div className="onb-strip-title">
                        <span className="onb-strip-num">{String(i + 1).padStart(2, '0')}</span>
                        {title}
                      </div>
                      <div className="onb-strip-desc">{desc}</div>
                    </div>
                    {i < howItWorks.length - 1 && <div className="onb-strip-connector" aria-hidden="true" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="onb-step">
              <div className="onb-kicker"><span className="onb-slashes">//</span> STEP 03</div>
              <h2 className="onb-title">Built For Trust</h2>
              <div className="onb-trust-list">
                {trustPoints.map(({ icon: Icon, title, desc }) => (
                  <div className="onb-trust-item" key={title}>
                    <div className="onb-trust-icon"><Icon size={18} strokeWidth={1.75} /></div>
                    <div>
                      <div className="onb-trust-title">{title}</div>
                      <div className="onb-trust-desc">{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="onb-disclaimer">
                <span className="onb-slashes">//</span> Always verify before pricing.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="onb-step">
              <div className="onb-kicker"><span className="onb-slashes">//</span> READY</div>
              <h2 className="onb-title">Run Your First Takeoff</h2>
              <div className="onb-ready-list">
                {readyItems.map(({ icon: Icon, text }) => (
                  <div className="onb-ready-item" key={text}>
                    <div className="onb-ready-icon"><Icon size={16} strokeWidth={1.75} /></div>
                    <div className="onb-ready-text">{text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer: back / dots / next */}
        <div className="onb-footer">
          <button
            type="button"
            className="onb-btn onb-btn-ghost"
            onClick={goBack}
            disabled={step === 0}
            style={{ visibility: step === 0 ? 'hidden' : 'visible' }}
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>

          <div className="onb-dots" role="progressbar" aria-valuemin={1} aria-valuemax={TOTAL_STEPS} aria-valuenow={step + 1}>
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <button
                key={i}
                type="button"
                className={`onb-dot ${i === step ? 'onb-dot-active' : ''} ${i < step ? 'onb-dot-done' : ''}`}
                aria-label={`Go to step ${i + 1}`}
                onClick={() => {
                  setDir(i > step ? 'fwd' : 'back')
                  setStep(i)
                }}
              />
            ))}
          </div>

          <button type="button" className="onb-btn onb-btn-primary" onClick={goNext}>
            {step === TOTAL_STEPS - 1 ? 'Get Started' : 'Next'}
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Skip confirmation */}
        {confirmingSkip && (
          <div className="onb-confirm-overlay">
            <div className="onb-confirm-card">
              <div className="onb-confirm-title">Skip setup?</div>
              <div className="onb-confirm-desc">
                You can update your profile any time from the dashboard.
              </div>
              <div className="onb-confirm-actions">
                <button
                  type="button"
                  className="onb-btn onb-btn-ghost"
                  onClick={() => onSkip()}
                >
                  Skip
                </button>
                <button
                  type="button"
                  className="onb-btn onb-btn-primary"
                  onClick={() => setConfirmingSkip(false)}
                  autoFocus
                >
                  Keep Going
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
