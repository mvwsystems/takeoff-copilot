import { Link } from 'react-router-dom'
import { Upload, FileText, BarChart3, AlertTriangle, Layers, Users, ScanSearch, ChevronDown } from 'lucide-react'
import { useState, useEffect } from 'react'
import './LandingPage.css'

const FAQS = [
  {
    q: 'Does this replace my estimator?',
    a: 'No. It is built to help estimators move faster, not remove them from the process. Your estimator reviews the output before anything goes into a bid.'
  },
  {
    q: 'How accurate is it?',
    a: 'Accuracy depends on plan quality, scope clarity, and how much information is actually shown in the documents. That is why every line item gets a confidence score and unclear items are flagged for review. We do not publish a single accuracy number because it would not be honest.'
  },
  {
    q: 'What happens if the plans are not good enough?',
    a: 'The system checks the documents first. If the plan set is incomplete, too dense to read reliably, or missing key information, it tells you instead of producing a bad takeoff.'
  },
  {
    q: 'What trades is this for?',
    a: 'The beta is focused on underground and site utility work — sanitary sewer, storm drain, water main, force main, and related civil utility scope.'
  },
  {
    q: 'Can I upload geotech reports?',
    a: 'Yes. Geotech reports are part of the intended workflow. Soil classification, groundwater depth, boring data, and backfill suitability are pulled into the review so excavation and subgrade concerns show up before they become bid risk.'
  },
  {
    q: 'Is this ready for production bids?',
    a: 'It is currently in beta. Use the output as a first-pass review tool. Final bid decisions should remain with your estimator. We are tuning the system against real plans and completed takeoffs before we call it production-ready.'
  },
]

function FAQ({ q, a, index }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`faq-item ${open ? 'open' : ''}`}
      data-reveal
      style={{ '--reveal-delay': `${index * 60}ms` }}
      onClick={() => setOpen(!open)}
    >
      <div className="faq-question">
        <span>{q}</span>
        <ChevronDown size={16} className="faq-chevron" />
      </div>
      <div className="faq-body">
        <div className="faq-body-inner">
          <div className="faq-answer">{a}</div>
        </div>
      </div>
    </div>
  )
}

export default function LandingPage() {
  useEffect(() => {
    const els = document.querySelectorAll('[data-reveal]')
    if (!els.length) return
    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target) }
      }),
      { threshold: 0.08, rootMargin: '0px 0px -32px 0px' }
    )
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <div className="landing">

      {/* HERO */}
      <section className="hero">
        <div className="hero-bg-grid" />
        <div className="hero-glow" />
        <div className="hero-content animate-in">
          <div className="hero-badge">
            <span className="hero-badge-dot" />
            <span>Beta &mdash; Built for utility contractors</span>
          </div>

          <h1 className="hero-title">
            First-pass utility<br />
            takeoffs, built for<br />
            <span className="text-red">estimator review.</span>
          </h1>

          <p className="hero-subtitle">
            Upload your plans and geotech. Takeoff Copilot checks whether the
            documents are usable, runs a first-pass takeoff, grades confidence
            on every line item, and flags what your estimator should verify
            before it goes anywhere near a bid.
          </p>

          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary btn-lg">
              <Upload size={18} />
              Request Beta Access
            </Link>
            <a href="#how-it-works" className="btn btn-secondary btn-lg">
              See How It Works
            </a>
          </div>

          <div className="hero-trust">
            {['Plan screening', 'Confidence-graded line items', 'Estimator review flags', 'Geotech-aware', 'Built for utility scope'].map((t, i) => (
              <span key={i} className="hero-trust-item">
                {i > 0 && <span className="hero-trust-sep">//</span>}
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="hero-angle" />
      </section>

      {/* WHAT IT DOES */}
      <section className="features">
        <div className="features-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Capabilities</span>
            <h2>What It Does</h2>
            <p className="section-sub">Six things Takeoff Copilot does on every uploaded job.</p>
          </div>
          <div className="features-grid">
            {[
              {
                icon: <ScanSearch size={22} />,
                title: 'Plan Set Screening',
                desc: 'Before it runs the takeoff, Takeoff Copilot checks whether the plans are clear enough to produce useful output. If the set is missing key information, it tells you instead of guessing.'
              },
              {
                icon: <FileText size={22} />,
                title: 'First-Pass Takeoff',
                desc: 'Organized line items for pipe, structures, fittings, excavation, services, and quantities pulled from the uploaded documents.'
              },
              {
                icon: <BarChart3 size={22} />,
                title: 'Confidence Grading',
                desc: 'Every line item includes a confidence score — High, Medium, or Low — so your estimator knows what looks solid and what needs a closer look.'
              },
              {
                icon: <AlertTriangle size={22} />,
                title: 'Review Flags',
                desc: 'Items with unclear quantities, missing callouts, geotech concerns, or possible scope gaps are flagged before they become bid risk.'
              },
              {
                icon: <Layers size={22} />,
                title: 'Geotech-Aware Review',
                desc: 'Upload geotech reports alongside the plans. Soil classification, groundwater depth, boring data, and backfill suitability are surfaced in the review.'
              },
              {
                icon: <Users size={22} />,
                title: 'Estimator-Controlled',
                desc: 'The tool gives your team a faster starting point. Your estimator still makes the final call. Use it to speed up review, not skip review.'
              }
            ].map((f, i) => (
              <div
                key={i}
                className="feature-card card"
                data-reveal
                style={{ '--reveal-delay': `${i * 80}ms` }}
              >
                <div className="feature-icon-wrap">
                  <div className="feature-icon">{f.icon}</div>
                </div>
                <h4 className="feature-title">{f.title}</h4>
                <p className="feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-it-works" id="how-it-works">
        <div className="how-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Workflow</span>
            <h2>How It Works</h2>
          </div>
          <div className="steps">
            {[
              {
                num: '01',
                title: 'Upload Plans & Geotech',
                desc: 'Send in the plan set, relevant specs, and geotech report. PDF or image files.'
              },
              {
                num: '02',
                title: 'Document Check',
                desc: 'Takeoff Copilot checks whether the files are complete and readable enough to run. Plans that are not a good fit are flagged or rejected here — not after the fact.'
              },
              {
                num: '03',
                title: 'First-Pass Takeoff',
                desc: 'Visible quantities, scope items, utility notes, and likely bid concerns are extracted and organized into a structured table.'
              },
              {
                num: '04',
                title: 'Confidence Review',
                desc: 'Each line item is graded High, Medium, or Low confidence. Anything unclear is flagged with a note explaining what to verify and why.'
              },
              {
                num: '05',
                title: 'Estimator Final Check',
                desc: 'Your team reviews, adjusts, and decides what makes it into the bid. The tool does the first pass. The estimator stays in control.'
              }
            ].map((s, i) => (
              <div
                key={i}
                className="step"
                data-reveal
                style={{ '--reveal-delay': `${i * 90}ms` }}
              >
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

      {/* ACCURACY / HONEST FRAMING */}
      <section className="accuracy-section">
        <div className="accuracy-inner" data-reveal>
          <div className="accuracy-label titan-label">On Accuracy</div>
          <h2 className="accuracy-headline">
            Not every plan set is equal.<br />
            <span className="text-red">We do not pretend otherwise.</span>
          </h2>
          <div className="accuracy-body">
            <p>
              Clean utility profiles, clear callouts, complete sheet sets, and useful geotech produce stronger outputs.
              Messy, incomplete, or unclear plans get flagged or rejected.
            </p>
            <p>
              The goal is not blind automation. The goal is a faster,
              better-organized first pass with the risk clearly marked so your
              estimator knows exactly where to spend their time.
            </p>
          </div>
          <div className="accuracy-pills">
            {[
              { cls: 'pill-high', label: 'High confidence — looks solid' },
              { cls: 'pill-medium', label: 'Medium — verify before pricing' },
              { cls: 'pill-low', label: 'Low — estimator must confirm' },
            ].map((p, i) => (
              <span
                key={i}
                className={`accuracy-pill ${p.cls}`}
                style={{ '--reveal-delay': `${i * 100 + 200}ms` }}
              >
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="faq-section">
        <div className="faq-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Questions</span>
            <h2>Common Questions</h2>
          </div>
          <div className="faq-list">
            {FAQS.map((f, i) => <FAQ key={i} index={i} {...f} />)}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="cta">
        <div className="cta-inner" data-reveal>
          <span className="titan-label">Beta Program</span>
          <h2>
            Currently testing with<br />
            <span className="text-red">utility contractors.</span>
          </h2>
          <p className="cta-sub">
            We are tuning Takeoff Copilot against real plans, geotech reports,
            and completed takeoffs. If you bid underground utility work and want
            a faster first pass, request access and try it on a real job.
          </p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            <Link to="/login" className="btn btn-primary btn-lg">
              <Upload size={18} />
              Request Beta Access
            </Link>
          </div>
          <p className="cta-disclaimer">
            No commitment. No sales call. Upload a plan set and see what it produces.
          </p>
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
