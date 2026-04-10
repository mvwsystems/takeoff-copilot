import { Link } from 'react-router-dom'
import { Upload, Zap, FileSpreadsheet, Shield, Clock, Target } from 'lucide-react'
import './LandingPage.css'

export default function LandingPage() {
  return (
    <div className="landing">
      {/* HERO */}
      <section className="hero">
        <div className="hero-bg-grid" />
        <div className="hero-content animate-in">
          <div className="hero-tag">
            <span className="titan-label">Titan AI</span>
            <span className="titan-separator">//</span>
            <span className="titan-label">Construction AI Operations</span>
          </div>
          <h1 className="hero-title">
            Takeoff<br />
            <span className="text-red">Copilot</span>
          </h1>
          <p className="hero-subtitle">
            Upload plan sheets. Get a structured takeoff in minutes — pipe types, 
            fittings, structures, quantities. Your estimator's head start before 
            PlanSwift even opens.
          </p>
          <div className="hero-actions">
            <Link to="/dashboard" className="btn btn-primary btn-lg">
              <Upload size={18} />
              Launch Dashboard
            </Link>
            <Link to="/login" className="btn btn-secondary btn-lg">
              Login
            </Link>
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-value">90%+</span>
              <span className="hero-stat-label">Item Identification</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">&lt;5 min</span>
              <span className="hero-stat-label">Per Sheet Analysis</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">PDF</span>
              <span className="hero-stat-label">Direct Upload</span>
            </div>
          </div>
        </div>

        {/* Angled accent bar */}
        <div className="hero-angle" />
      </section>

      {/* WHAT IT READS */}
      <section className="features">
        <div className="features-inner">
          <div className="section-header">
            <span className="titan-label">Capabilities</span>
            <h2>What The AI Reads</h2>
          </div>
          <div className="features-grid">
            {[
              {
                icon: <Target size={22} />,
                title: 'Pipe & Conduit',
                items: 'PVC, RCP, HDPE, DIP, VCP — type, size, class (SDR-35, C900, DR-18), slope, and estimated footage'
              },
              {
                icon: <Shield size={22} />,
                title: 'Structures',
                items: 'Manholes, catch basins, cleanouts, valve boxes, hydrants, inlets, headwalls, grease interceptors'
              },
              {
                icon: <Zap size={22} />,
                title: 'Fittings',
                items: 'Bends (11.25° to 90°), tees, wyes, reducers, couplings, adapters, restraints, valves'
              },
              {
                icon: <FileSpreadsheet size={22} />,
                title: 'Excavation & Restoration',
                items: 'Trench specs, bedding, backfill, pavement restoration, sawcut & replace, spoil removal'
              },
              {
                icon: <Clock size={22} />,
                title: 'Services & Testing',
                items: 'Water services, meter sets, backflow devices, pressure testing, CCTV, compaction requirements'
              },
              {
                icon: <Upload size={22} />,
                title: 'Geotechnical Data',
                items: 'Soil types, groundwater depth, expansion potential — flags items that impact your bid'
              }
            ].map((f, i) => (
              <div key={i} className="feature-card card" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="feature-icon">{f.icon}</div>
                <h4 className="feature-title">{f.title}</h4>
                <p className="feature-desc">{f.items}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-it-works">
        <div className="how-inner">
          <div className="section-header">
            <span className="titan-label">Workflow</span>
            <h2>How It Works</h2>
          </div>
          <div className="steps">
            {[
              { num: '01', title: 'Upload Plans', desc: 'Drop your PDF plan set. The system splits each page automatically.' },
              { num: '02', title: 'AI Analyzes', desc: 'Claude Vision reads every callout, symbol, and note on each sheet.' },
              { num: '03', title: 'Review Takeoff', desc: 'Structured table with items, quantities, and confidence levels. Export to CSV.' },
              { num: '04', title: 'Estimator Finalizes', desc: 'Your team verifies quantities and moves straight to pricing.' }
            ].map((s, i) => (
              <div key={i} className="step" style={{ animationDelay: `${i * 100}ms` }}>
                <div className="step-num">{s.num}</div>
                <div className="step-content">
                  <h4>{s.title}</h4>
                  <p>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta">
        <div className="cta-inner">
          <span className="titan-label">Ready to Move</span>
          <h2>Stop Reading Plans.<br /><span className="text-red">Start Analyzing Them.</span></h2>
          <Link to="/dashboard" className="btn btn-primary btn-lg">
            <Upload size={18} />
            Open Takeoff Copilot
          </Link>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="brand-name" style={{ fontSize: '0.9rem' }}>Takeoff Copilot</span>
            <span className="titan-separator">//</span>
            <span className="titan-label">Powered by Titan AI</span>
          </div>
          <div className="titan-label">&copy; {new Date().getFullYear()} Titan AI. All rights reserved.</div>
        </div>
      </footer>
    </div>
  )
}
