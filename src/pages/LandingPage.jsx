import { Link } from 'react-router-dom'
import { Upload, FileText, BarChart3, AlertTriangle, Layers, Eye, ScanSearch, ChevronDown, CheckCircle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import './LandingPage.css'

const FAQS = [
  {
    q: 'Does this replace my estimator?',
    a: 'No. It is a second set of eyes for the estimator\'s own work, not a replacement. The estimator builds the takeoff. Takeoff Copilot reads the plans and geotech against it and tells them what may be wrong before the bid goes out.'
  },
  {
    q: 'What does the Bid Risk Report include?',
    a: 'It includes an executive risk summary, every quantity item that appears low or missing relative to the plans, geotech conflicts (dewatering, rock, lime stabilization, haul-off), commonly missed scope items, clarification questions the estimator should ask before bidding, assumptions that need approval, and recommended bid notes to include in the proposal letter. Everything in one downloadable PDF.'
  },
  {
    q: 'What if the plans are not good quality?',
    a: 'Every submission is graded A, B, or C for plan readability before the QA review runs. A Grade C plan set limits what can be confirmed or disputed — the report will tell you exactly what it cannot verify and why, so the estimator knows which items require field verification before the bid goes final.'
  },
  {
    q: 'What trades is this for?',
    a: 'The beta is focused on underground and site utility work — sanitary sewer, storm drain, water main, force main, and related civil utility scope. Calibrated against DFW and greater Texas market conditions.'
  },
  {
    q: 'Can I upload geotech reports?',
    a: 'Yes, and you should. Geotech reports are a core part of the workflow. Soil classification, groundwater depth, boring data, and backfill suitability are cross-referenced against the estimator\'s takeoff. If the estimator has no dewatering line item and groundwater is at 6 feet, that shows up as a HIGH risk flag.'
  },
  {
    q: 'How does pricing work?',
    a: 'Each report is $97. Upload your plan sheets, geotech report, and completed takeoff CSV or Excel file. The report is generated and available to download as a PDF immediately. No subscription. No seat fees. Pay per review.'
  },
]

function FAQ({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`faq-item ${open ? 'open' : ''}`}
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
  const cardRef = useRef(null)

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

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    let raf
    const onScroll = () => {
      raf = requestAnimationFrame(() => {
        card.style.transform = `rotate(-3deg) translateY(${window.scrollY * 0.5}px)`
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])

  return (
    <div className="landing">

      {/* HERO */}
      <section className="hero">
        <div className="hero-bg-grid" />
        <div className="hero-glow" />
        <div className="hero-two-col animate-in">

          {/* LEFT — copy */}
          <div className="hero-left">
            <div className="hero-badge">
              <span className="hero-badge-dot" />
              <span>Beta &mdash; Built for utility contractors</span>
            </div>

            <h1 className="hero-title">
              Find the mistake<br />
              before the bid<br />
              <span className="text-red">goes out.</span>
            </h1>

            <p className="hero-subtitle">
              Upload your plans, geotech, and completed takeoff. Takeoff Copilot
              reviews the package for missed quantities, risky assumptions,
              plan&thinsp;/&thinsp;geotech conflicts, and scope gaps before you submit.
            </p>

            <div className="hero-actions">
              <Link to="/login" className="btn btn-primary btn-lg">
                <Upload size={18} />
                Submit a Bid for QA Review
              </Link>
              <a href="#how-it-works" className="btn btn-secondary btn-lg">
                See How It Works
              </a>
            </div>

            <div className="hero-trust">
              {['Plan screening', 'Missed quantity detection', 'Geotech conflict flags', 'Scope gap check', 'Bid Risk Report PDF'].map((t, i) => (
                <span key={i} className="hero-trust-item">
                  {i > 0 && <span className="hero-trust-sep">//</span>}
                  {t}
                </span>
              ))}
            </div>
          </div>

          {/* RIGHT — mock Bid Risk Report card */}
          <div className="hero-right">
            <div className="hero-report-glow" />
            <div className="hero-report-card" ref={cardRef}>

              <div className="hrrc-header">
                <div>
                  <div className="hrrc-label">BID RISK REPORT</div>
                  <div className="hrrc-job">JOB-DFW-2461</div>
                </div>
                <div className="hrrc-status">REVIEW COMPLETE</div>
              </div>

              <div className="hrrc-section">
                <div className="hrrc-section-title">EXECUTIVE SUMMARY</div>
                <ul className="hrrc-bullets">
                  <li><span className="hrrc-dot hrrc-dot-red" />Missing dewatering allowance — geotech shows groundwater at 5.5&nbsp;ft</li>
                  <li><span className="hrrc-dot hrrc-dot-amber" />Storm drain manhole count appears low vs. plan sheet C-4</li>
                  <li><span className="hrrc-dot hrrc-dot-green" />Sanitary sewer footage aligns with profile sheets</li>
                </ul>
              </div>

              <div className="hrrc-section hrrc-section-table">
                <div className="hrrc-section-title">HIGH RISK MISSES</div>
                <table className="hrrc-table">
                  <thead>
                    <tr>
                      <th>ITEM</th>
                      <th>PLAN QTY</th>
                      <th>T/O QTY</th>
                      <th>FLAG</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Dewatering</td>
                      <td>Required</td>
                      <td className="hrrc-td-missing">—</td>
                      <td><span className="hrrc-flag hrrc-flag-red">HIGH</span></td>
                    </tr>
                    <tr>
                      <td>MH, 4&apos; Dia</td>
                      <td>14 EA</td>
                      <td>9 EA</td>
                      <td><span className="hrrc-flag hrrc-flag-red">HIGH</span></td>
                    </tr>
                    <tr>
                      <td>Lime Stabilization</td>
                      <td>3,200 SY</td>
                      <td className="hrrc-td-missing">—</td>
                      <td><span className="hrrc-flag hrrc-flag-amber">MED</span></td>
                    </tr>
                    <tr>
                      <td>CCTV Inspection</td>
                      <td>Spec req.</td>
                      <td className="hrrc-td-missing">—</td>
                      <td><span className="hrrc-flag hrrc-flag-amber">MED</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="hrrc-footer">
                <span className="hrrc-footer-label">ESTIMATOR CONFIDENCE</span>
                <span className="hrrc-grade">B</span>
              </div>

            </div>
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
            <p className="section-sub">A second set of eyes on every bid package before the number leaves the building.</p>
          </div>
          <div className="features-grid">
            {[
              {
                icon: <ScanSearch size={22} />,
                title: 'Plan Set Screening',
                desc: 'Before reviewing the estimator\'s takeoff, the system grades the plan set A, B, or C. Grade C plans cannot support a reliable QA review and are flagged before the report runs.'
              },
              {
                icon: <FileText size={22} />,
                title: 'Bid Risk Report',
                desc: 'The primary output is a structured Bid Risk Report — not a raw takeoff. Executive summary, risk flags, quantity discrepancies, scope gaps, clarification questions, and recommended bid notes. Downloadable as a PDF.'
              },
              {
                icon: <AlertTriangle size={22} />,
                title: 'Missed Quantity Detection',
                desc: 'Each line item in the estimator\'s takeoff is compared against what the plans show. Items that appear low, appear high, or are missing from the plans entirely are flagged with a risk level and a note.'
              },
              {
                icon: <Layers size={22} />,
                title: 'Geotech Conflict Detection',
                desc: 'Geotech data is cross-referenced against the takeoff. If groundwater is at 6 feet and there\'s no dewatering line item, that is a HIGH risk flag. Same for rock excavation, lime stabilization, imported fill, and haul-off.'
              },
              {
                icon: <BarChart3 size={22} />,
                title: 'Estimator Confidence Score',
                desc: 'The report closes with an A–F confidence grade on the estimator\'s overall package — scored by how well quantities align with the plans and how complete the scope appears. Not a judgment. A calibration.'
              },
              {
                icon: <Eye size={22} />,
                title: 'Second Set of Eyes',
                desc: 'Calibrated against real completed jobs in the DFW market. The system knows what utility contractors miss — trench safety, testing requirements, municipal-specific callouts, and scope items that don\'t show up until the RFI.'
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

      {/* HOW WE CALIBRATE */}
      <section className="calibration-section">
        <div className="calibration-inner">

          <div className="section-header" data-reveal>
            <span className="titan-label">// Calibration — DFW Multifamily Off-Site Utilities, 2025</span>
            <h2 className="calibration-headline">
              Where we were right.<br />
              <span className="text-red">Where we missed.</span>
            </h2>
            <p className="calibration-lede">
              Every Bid Risk Report compares the AI takeoff to what the contractor
              actually built on similar jobs. HIGH means we matched. MISS means we
              didn&apos;t — and the report says so. This is one of those comparisons.
            </p>
          </div>

          <div className="calibration-cols" data-reveal>

            {/* LEFT — stat tiles */}
            <div className="cal-stats">
              {[
                { eyebrow: 'MAINLINE REVIEWED', num: '1,527', unit: 'LF', sub: 'sewer + water + storm' },
                { eyebrow: 'ITEMS MATCHED ACTUALS', num: '13 / 17', unit: '', sub: '76% first-pass accuracy' },
                { eyebrow: 'AI MISSES DISCLOSED', num: '4', unit: '', sub: 'flagged in red, in the report' },
              ].map((s, i) => (
                <div key={i} className="cal-stat-tile">
                  <div className="cal-stat-eyebrow">{s.eyebrow}</div>
                  <div className="cal-stat-num">
                    {s.num}
                    {s.unit && <span className="cal-stat-unit">{s.unit}</span>}
                  </div>
                  <div className="cal-stat-sub">{s.sub}</div>
                </div>
              ))}
            </div>

            {/* RIGHT — accuracy table */}
            <div className="cal-table-wrap">
              <div className="cal-table-title">System-Level Accuracy vs. Contractor Actuals</div>
              <div className="cal-table-scroll">
                <table className="cal-table">
                  <thead>
                    <tr>
                      <th>SYSTEM</th>
                      <th>AI EXTRACT</th>
                      <th>ACTUAL</th>
                      <th>DELTA</th>
                      <th>FLAG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { system: 'Sanitary sewer main 8"', ai: '468 LF', actual: '466 LF', delta: '-2 LF',   flag: 'HIGH', badge: '99.6%' },
                      { system: 'Water main 8"',           ai: '932 LF', actual: '932 LF', delta: '—',       flag: 'HIGH', badge: 'MATCH' },
                      { system: 'Gate valves 4"',          ai: '0 EA',   actual: '2 EA',   delta: '-2 EA',   flag: 'MISS', badge: null },
                      { system: 'Storm drain 24" RCP',     ai: '30 LF',  actual: '129 LF', delta: '-99 LF',  flag: 'MISS', badge: null },
                      { system: "Curb inlets 10'",         ai: '1 EA',   actual: '2 EA',   delta: '-1 EA',   flag: 'MISS', badge: null },
                      { system: 'TV inspection',           ai: '—',      actual: '595 LF', delta: '-595 LF', flag: 'MISS', badge: null },
                    ].map((r, i) => (
                      <tr key={i} className={r.flag === 'MISS' ? 'cal-row-miss' : ''}>
                        <td className="cal-td-system">{r.system}</td>
                        <td>{r.ai}</td>
                        <td>{r.actual}</td>
                        <td className={r.flag === 'MISS' ? 'cal-td-delta-miss' : ''}>{r.delta}</td>
                        <td>
                          <span className={`cal-flag ${r.flag === 'HIGH' ? 'cal-flag-high' : 'cal-flag-miss'}`}>
                            {r.badge || r.flag}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cal-footnote">
                MISS rows are surfaced in your report in red. We disclose the AI&apos;s own
                gaps so the estimator knows exactly where to verify before pricing.
                Calibrated against actuals from Rumsey Site Construction and others
                in the DFW market.
              </p>
            </div>

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
                title: 'Upload the Full Package',
                desc: 'Send in the plan set, geotech report, and the estimator\'s completed takeoff as a CSV or Excel file. All three together give the review full context.'
              },
              {
                num: '02',
                title: 'Plan Grade Assessment',
                desc: 'The system evaluates plan quality and assigns a grade. Grade A and B plans support a reliable QA review. Grade C plans are flagged — the report tells you what cannot be confirmed and why.'
              },
              {
                num: '03',
                title: 'Line-by-Line QA Review',
                desc: 'Every line item in the estimator\'s takeoff is checked against what the plans show. Quantities that appear low, high, or missing are identified. Items on the plans not in the takeoff are flagged as misses.'
              },
              {
                num: '04',
                title: 'Bid Risk Report Generated',
                desc: 'A structured report is produced: executive summary, high-risk misses, quantity rechecks, geotech conflicts, scope gaps, clarification questions, and bid notes formatted for the proposal letter.'
              },
              {
                num: '05',
                title: 'Estimator Reviews and Decides',
                desc: 'The report is downloaded as a PDF. The estimator reviews every flag, makes corrections where warranted, and submits the bid with confidence. The tool raises the flags. The estimator makes the call.'
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
            Not every plan set supports<br />
            <span className="text-red">a reliable QA review.</span>
          </h2>
          <div className="accuracy-body">
            <p>
              Clean utility profiles, explicit callouts, complete sheet sets, and useful geotech
              produce HIGH and MEDIUM confidence flags. Dense, unclear, or incomplete plans
              produce UNVERIFIABLE items — and the report says so clearly.
            </p>
            <p>
              The goal is not to automate the estimator out of the process. The goal is to surface
              the risk before it becomes a change order, so the estimator knows exactly what to
              verify and what to protect in the proposal.
            </p>
          </div>
          <div className="accuracy-pills">
            {[
              { cls: 'pill-high', label: 'HIGH — confirmed against plans' },
              { cls: 'pill-medium', label: 'MEDIUM — verify before pricing' },
              { cls: 'pill-low', label: 'LOW — estimator must confirm' },
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

      {/* PRICING */}
      <section className="pricing-section">
        <div className="pricing-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Pricing</span>
            <h2>Simple. Per Report.</h2>
            <p className="section-sub">No subscription. No seat fees. Pay when you need a second set of eyes.</p>
          </div>
          <div className="pricing-card-wrap" data-reveal>
            <div className="pricing-card">
              <div className="pricing-card-header">
                <div className="pricing-tier-label">QA Bid Review</div>
                <div className="pricing-amount">
                  <span className="pricing-dollar">$</span>
                  <span className="pricing-num">97</span>
                  <span className="pricing-per">/ report</span>
                </div>
                <p className="pricing-tagline">One submission. Full Bid Risk Report. Downloadable PDF.</p>
              </div>
              <ul className="pricing-features">
                {[
                  'Plan grade assessment (A / B / C)',
                  'Line-by-line quantity comparison against plans',
                  'High Risk Misses table with risk level and notes',
                  'Geotech cross-reference (dewatering, rock, lime, fill, haul-off)',
                  'Scope gap check (CCTV, testing, traffic control, permits, and more)',
                  'Clarification questions and assumptions needing approval',
                  'Recommended bid notes formatted for the proposal letter',
                  'Estimator confidence score (A–F)',
                  'Full PDF download',
                ].map((item, i) => (
                  <li key={i}>
                    <CheckCircle size={14} className="pricing-check" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="pricing-cta">
                <Link to="/login" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }}>
                  <Upload size={16} />
                  Submit a Bid for QA Review
                </Link>
                <p className="pricing-disclaimer">Upload your plans, geotech, and takeoff. Report is ready immediately.</p>
              </div>
            </div>
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
            {FAQS.map((f, i) => <FAQ key={i} {...f} />)}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="cta">
        <div className="cta-inner" data-reveal>
          <span className="titan-label">Beta Program</span>
          <h2>
            Your estimator built the number.<br />
            <span className="text-red">We check it.</span>
          </h2>
          <p className="cta-sub">
            Upload your plan set, geotech report, and completed takeoff.
            Get a structured Bid Risk Report that tells you exactly what
            to verify, protect, and fix before the bid goes out.
          </p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            <Link to="/login" className="btn btn-primary btn-lg">
              <Upload size={18} />
              Submit a Bid for QA Review
            </Link>
          </div>
          <p className="cta-disclaimer">
            $97 per report. No subscription. Download the PDF immediately.
          </p>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="brand-name" style={{ fontSize: '0.9rem' }}>Takeoff Copilot</span>
            <span className="titan-separator">//</span>
            <a href="https://6signal.co" target="_blank" rel="noopener noreferrer" className="titan-label footer-brand-link">Powered by 6 Signal</a>
          </div>
          <div className="titan-label">&copy; {new Date().getFullYear()} 6 Signal. All rights reserved.</div>
        </div>
      </footer>

    </div>
  )
}
