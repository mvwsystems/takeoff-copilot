import './RiskPill.css'

const CONFIG = {
  high:   { label: 'HIGH',   meaning: 'Confirmed against labeled plan callout' },
  medium: { label: 'MEDIUM', meaning: 'Calculated or interpreted — verify before pricing' },
  low:    { label: 'LOW',    meaning: 'Inferred — estimator must confirm' },
  miss:   { label: 'MISS',   meaning: 'Not in AI takeoff — appeared in contractor actuals' },
}

export default function RiskPill({ level = 'medium', size = 'sm', children }) {
  const cfg = CONFIG[level] || CONFIG.medium
  return (
    <span className={`risk-pill rp-${size} rp-${level}`} title={cfg.meaning}>
      {cfg.label}
      {children && <span className="rp-trail">{children}</span>}
    </span>
  )
}
