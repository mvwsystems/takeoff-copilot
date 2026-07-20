import { Link } from 'react-router-dom'
import { Upload, FileText, BarChart3, AlertTriangle, Layers, Eye, ScanSearch, ChevronDown, CheckCircle, Check, Minus } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import RiskPill from '../components/RiskPill'
import './LandingPage.css'

const FAQS = [
  {
    q: 'Will this slow down my bid?',
    tag: 'SPEED',
    a: 'No. Upload your plan set, geotech, and takeoff file. The report is ready immediately — typically under two minutes. You get a PDF with every risk flag, quantity variance, and scope gap sorted by severity. The only work on your end is reviewing the flags and deciding which ones to address. Most estimators run this the night before submission, not the morning of.',
  },
  {
    q: 'Does the report replace my estimator?',
    tag: 'PROCESS',
    a: 'No. The estimator builds the takeoff. Takeoff Copilot reads the plans and geotech against it and flags what they may have missed before the bid goes out. Your estimator\'s judgment, experience, and sub relationships stay at the center of the number. This is a structured second read — the kind a senior PM would do if you had one available for every bid.',
  },
  {
    q: 'Where do our plans and takeoffs go? Who sees them?',
    tag: 'SECURITY',
    a: 'Your files are transmitted over TLS, processed in an isolated environment, and not retained after the report is generated. No human at Takeoff Copilot reads your documents. We do not sell, share, or transfer your files to third parties. Each submission is scoped and discarded — your bid information does not persist in our system after delivery.',
  },
  {
    q: 'What if the plans are unclear or incomplete?',
    tag: 'ACCURACY',
    a: 'Every submission is graded A, B, or C for plan readability before the QA review runs. A Grade C plan set limits what can be confirmed — the report tells you exactly what it could not verify and why. Items with incomplete plan support are flagged MEDIUM or LOW rather than HIGH. The estimator knows which flags need field verification before the number goes final.',
  },
  {
    q: 'What trades does this support?',
    tag: 'SCOPE',
    a: 'The beta is focused on underground and site utility work — sanitary sewer, storm drain, water main, force main, and related civil scope. Calibrated against DFW and greater Texas market conditions. Road work, earthwork, and structural concrete are not in scope for this release. Additional trade coverage is in development.',
  },
  {
    q: 'How is this different from another takeoff service?',
    tag: 'PROCESS',
    a: 'Takeoff services produce a quantity list from plans. Takeoff Copilot reads your estimator\'s completed takeoff against the plans and tells them what they missed. The assumption is the takeoff is done — this is the QA pass that happens after. If you\'re looking for someone to build the number from scratch, that\'s a different product.',
  },
  {
    q: 'Can I dispute a flag?',
    tag: 'PROCESS',
    a: 'Yes. Flags are not decisions — they are structured concerns for the estimator to evaluate. If a flag is wrong, that\'s useful information: it means the answer is in the plans somewhere the system didn\'t catch. We are building a formal flag feedback loop that will feed into calibration. For now, note your resolution alongside the flag in your own records.',
  },
  {
    q: 'Do you train on our data?',
    tag: 'SECURITY',
    a: 'No. Your plans, takeoff, and geotech are not used to train any model. Each submission is processed, the report is generated, and the input files are discarded. We do not use your proprietary project data for any purpose beyond producing your report.',
  },
]

const SECTIONS = [
  { id: 'capabilities', label: 'CAPABILITIES' },
  { id: 'built-for',    label: 'BUILT FOR'    },
  { id: 'sample-job',   label: 'SAMPLE JOB'   },
  { id: 'workflow',     label: 'WORKFLOW'      },
  { id: 'accuracy',     label: 'ACCURACY'      },
  { id: 'difference',   label: 'DIFFERENCE'    },
  { id: 'pricing',      label: 'PRICING'       },
  { id: 'faq',          label: 'FAQ'           },
]

function LandingNav() {
  const [active, setActive] = useState(SECTIONS[0].id)
  const linkRefs = useRef({})

  useEffect(() => {
    const visible = new Set()
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) visible.add(e.target.id)
        else visible.delete(e.target.id)
      })
      const found = SECTIONS.find(s => visible.has(s.id))
      if (found) setActive(found.id)
    }, { rootMargin: '-96px 0px -30% 0px', threshold: 0 })

    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = linkRefs.current[active]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [active])

  const scrollTo = (id) => {
    const el = document.getElementById(id)
    if (!el) return
    const y = el.getBoundingClientRect().top + window.scrollY - 96
    window.scrollTo({ top: y, behavior: 'smooth' })
  }

  return (
    <div className="landing-subnav">
      <div className="landing-subnav-inner">
        {SECTIONS.map(({ id, label }, i) => (
          <div key={id} className="subnav-item">
            {i > 0 && <span className="subnav-sep">//</span>}
            <button
              ref={el => { linkRefs.current[id] = el }}
              className={`subnav-link${active === id ? ' subnav-link-active' : ''}`}
              onClick={() => scrollTo(id)}
            >
              {label}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function FAQ({ q, a, tag, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className={`faq-item ${open ? 'open' : ''}`}
      onClick={() => setOpen(!open)}
    >
      <div className="faq-question">
        <span>{q}</span>
        <span className="faq-question-right">
          {tag && <span className="faq-tag">{tag}</span>}
          <ChevronDown size={16} className="faq-chevron" />
        </span>
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
  const pipelineRef = useRef(null)
  const connLeftRef = useRef(null)
  const connRightRef = useRef(null)
  const howRef = useRef(null)
  const [activeStep, setActiveStep] = useState(0)

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

  // Pipeline animation trigger + connector width measurement
  useEffect(() => {
    const pipeline = pipelineRef.current
    const connLeft = connLeftRef.current
    const connRight = connRightRef.current
    if (!pipeline || !connLeft || !connRight) return

    const setWidths = () => {
      connLeft.style.setProperty('--connector-w', `${connLeft.offsetWidth - 7}px`)
      connRight.style.setProperty('--connector-w', `${connRight.offsetWidth - 7}px`)
    }
    setWidths()
    window.addEventListener('resize', setWidths)

    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { pipeline.classList.add('pipeline-active'); io.disconnect() } },
      { threshold: 0.25 }
    )
    io.observe(pipeline)
    return () => { window.removeEventListener('resize', setWidths); io.disconnect() }
  }, [])

  // Scroll-driven active step
  useEffect(() => {
    const section = howRef.current
    if (!section) return
    let raf
    const onScroll = () => {
      raf = requestAnimationFrame(() => {
        const { top, height } = section.getBoundingClientRect()
        const fraction = Math.max(0, Math.min(1, (-top + window.innerHeight * 0.65) / height))
        setActiveStep(Math.min(4, Math.floor(fraction * 5)))
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])

  return (
    <div className="landing">

      <LandingNav />

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
      <section className="features" id="capabilities">
        <div className="features-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Capabilities</span>
            <h2>What It Does</h2>
            <p className="section-sub">A second set of eyes on every bid package before the number leaves the building.</p>
          </div>
          <div className="features-grid">
            {[
              {
                icon: <FileText size={26} />,
                title: 'Bid Risk Report',
                pill: null,
                bentoCls: 'bento-hero',
                heroCard: true,
                desc: 'The primary output is a structured Bid Risk Report — not a raw takeoff. Executive summary, risk flags, quantity discrepancies, scope gaps, clarification questions, and recommended bid notes. Downloadable as a PDF.'
              },
              {
                icon: <ScanSearch size={22} />,
                title: 'Plan Set Screening',
                pill: null,
                bentoCls: 'bento-c3r1',
                desc: 'Before reviewing the estimator\'s takeoff, the system grades the plan set A, B, or C. Grade C plans cannot support a reliable QA review and are flagged before the report runs.'
              },
              {
                icon: <AlertTriangle size={22} />,
                title: 'Missed Quantity Detection',
                pill: 'miss',
                bentoCls: 'bento-c4r1',
                desc: 'Each line item in the estimator\'s takeoff is compared against what the plans show. Items that appear low, appear high, or are missing from the plans entirely are flagged with a risk level and a note.'
              },
              {
                icon: <Layers size={22} />,
                title: 'Geotech Conflict Detection',
                pill: 'high',
                bentoCls: 'bento-c3r2',
                desc: 'Geotech data is cross-referenced against the takeoff. If groundwater is at 6 feet and there\'s no dewatering line item, that is a HIGH risk flag. Same for rock excavation, lime stabilization, imported fill, and haul-off.'
              },
              {
                icon: <BarChart3 size={22} />,
                title: 'Estimator Confidence Score',
                pill: null,
                bentoCls: 'bento-c4r2',
                desc: 'The report closes with an A–F confidence grade on the estimator\'s overall package — scored by how well quantities align with the plans and how complete the scope appears. Not a judgment. A calibration.'
              },
              {
                icon: <Eye size={22} />,
                title: 'Second Set of Eyes',
                pill: 'medium',
                bentoCls: 'bento-wide',
                wideCard: true,
                desc: 'Calibrated against real completed jobs in the DFW market. The system knows what utility contractors miss — trench safety, testing requirements, municipal-specific callouts, and scope items that don\'t show up until the RFI.'
              },
            ].map((f, i) => {
              if (f.heroCard) return (
                <div
                  key={i}
                  className="feature-card card bento-hero"
                  data-reveal
                  style={{ '--reveal-delay': `${i * 80}ms` }}
                >
                  <div className="feature-card-top">
                    <div className="feature-icon-wrap">
                      <div className="feature-icon">{f.icon}</div>
                    </div>
                  </div>
                  <h4 className="feature-title bento-hero-title">{f.title}</h4>
                  <p className="feature-desc">{f.desc}</p>

                  <div className="bento-pdf">
                    <div className="bento-pdf-header">
                      <span className="bento-pdf-label">BID RISK REPORT</span>
                      <span className="bento-pdf-job">JOB-DFW-2461</span>
                    </div>
                    <div className="bento-pdf-rows">
                      {[
                        { item: 'Dewatering allowance',   level: 'miss'   },
                        { item: 'Sanitary sewer main 8"', level: 'high'   },
                        { item: 'Storm drain MH count',   level: 'medium' },
                        { item: 'Lime stabilization',     level: 'miss'   },
                      ].map((r, ri) => (
                        <div key={ri} className="bento-pdf-row">
                          <span className="bento-pdf-item">{r.item}</span>
                          <RiskPill level={r.level} size="sm" />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bento-grade-badge">B+</div>
                </div>
              )

              if (f.wideCard) return (
                <div
                  key={i}
                  className="feature-card bento-wide"
                  data-reveal
                  style={{ '--reveal-delay': `${i * 80}ms` }}
                >
                  <div className="feature-card-top">
                    <div className="feature-icon-wrap">
                      <div className="feature-icon">{f.icon}</div>
                    </div>
                    {f.pill && <RiskPill level={f.pill} size="sm" />}
                  </div>
                  <h4 className="feature-title">{f.title}</h4>
                  <p className="feature-desc">{f.desc}</p>
                </div>
              )

              return (
                <div
                  key={i}
                  className={`feature-card card ${f.bentoCls}`}
                  data-reveal
                  style={{ '--reveal-delay': `${i * 80}ms` }}
                >
                  <div className="feature-card-top">
                    <div className="feature-icon-wrap">
                      <div className="feature-icon">{f.icon}</div>
                    </div>
                    {f.pill && <RiskPill level={f.pill} size="sm" />}
                  </div>
                  <h4 className="feature-title">{f.title}</h4>
                  <p className="feature-desc">{f.desc}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* BUILT FOR — scope / fit */}
      <section className="fit-section" id="built-for">
        <div className="fit-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">// Scope &amp; Fit</span>
            <h2>Built For Site &amp; Civil Utilities</h2>
            <p className="section-sub">
              Optimized for single-level site work &mdash; not vertical building plumbing.
              Every plan is screened A / B / C before you commit a dollar, so you never
              pay to find out it wasn&apos;t a fit.
            </p>
          </div>

          <div className="fit-grid" data-reveal>

            {/* Best fit */}
            <div className="fit-card fit-card-best">
              <div className="fit-card-head">
                <span className="fit-tag fit-tag-best">Best Fit</span>
                <span className="fit-grade fit-grade-a">A</span>
              </div>
              <h4 className="fit-card-title">Single-Level Site &amp; Civil Plans</h4>
              <ul className="fit-list">
                <li>Pad sites &amp; commercial site development</li>
                <li>Subdivision utility plans</li>
                <li>Storm, sanitary &amp; water &mdash; plan + profile</li>
              </ul>
              <p className="fit-card-note">
                Calibrated for exactly this work. Highest confidence, cleanest extraction.
              </p>
            </div>

            {/* Works but grades lower */}
            <div className="fit-card fit-card-mid">
              <div className="fit-card-head">
                <span className="fit-tag fit-tag-mid">Works &mdash; Grades Lower</span>
                <span className="fit-grade fit-grade-c">C</span>
              </div>
              <h4 className="fit-card-title">Dense, Poorly-Drafted, or Scanned Sets</h4>
              <ul className="fit-list">
                <li>Cluttered or hand-marked plans</li>
                <li>Scanned, raster-only sheets &mdash; no vector data</li>
                <li>Incomplete or low-resolution sets</li>
              </ul>
              <p className="fit-card-note">
                Still runs &mdash; but the report flags exactly what it couldn&apos;t confirm and
                grades it honestly, so you know where to verify.
              </p>
            </div>

            {/* Not designed for */}
            <div className="fit-card fit-card-no">
              <div className="fit-card-head">
                <span className="fit-tag fit-tag-no">Not Designed For</span>
                <span className="fit-grade fit-grade-x">&mdash;</span>
              </div>
              <h4 className="fit-card-title">Vertical / Multi-Level Building Plumbing</h4>
              <ul className="fit-list">
                <li>Plumbing risers &amp; stacks</li>
                <li>Multi-story MEP</li>
                <li>Scope that lives in section, not in plan</li>
              </ul>
              <p className="fit-card-note">
                Out of scope by design. We&apos;d rather tell you up front than waste your spend.
              </p>
            </div>

          </div>

          <p className="fit-footnote" data-reveal>
            Not sure your set qualifies? Upload it. The plan screen grades it A, B, or C
            before you run the analysis &mdash; no charge to find out where it lands.
          </p>
        </div>
      </section>

      {/* HOW WE CALIBRATE */}
      <section className="calibration-section" id="sample-job">
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
                          <RiskPill level={r.flag === 'HIGH' ? 'high' : 'miss'} size="sm">
                            {r.flag === 'HIGH' && r.badge ? r.badge : null}
                          </RiskPill>
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
      <section className="how-it-works" id="workflow" ref={howRef}>
        <div className="how-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Workflow</span>
            <h2>How It Works</h2>
          </div>

          {/* Pipeline diagram */}
          <div className="pipeline" ref={pipelineRef}>

            {/* Input file stack */}
            <div className="pipeline-inputs">
              {[
                { ext: 'PDF',  name: 'plan-set-001.pdf',   label: 'PLAN SET' },
                { ext: 'PDF',  name: 'geotech-report.pdf', label: 'GEOTECH'  },
                { ext: 'XLSX', name: 'takeoff-v3.xlsx',    label: 'TAKEOFF'  },
              ].map((f, i) => (
                <div key={i} className="pipeline-file">
                  <span className={`pipeline-ext pipeline-ext-${f.ext.toLowerCase()}`}>{f.ext}</span>
                  <div className="pipeline-file-info">
                    <span className="pipeline-file-label">{f.label}</span>
                    <span className="pipeline-file-name">{f.name}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Left connector */}
            <div className="pipeline-connector pipeline-connector-left" ref={connLeftRef}>
              <div className="connector-dot" />
            </div>

            {/* QA Review node */}
            <div className="pipeline-node">
              <div className="pipeline-node-ring" />
              <div className="pipeline-node-label">QA<br />REVIEW</div>
            </div>

            {/* Right connector */}
            <div className="pipeline-connector pipeline-connector-right" ref={connRightRef}>
              <div className="connector-dot" />
            </div>

            {/* Output card */}
            <div className="pipeline-output">
              <div className="pipeline-file pipeline-output-file">
                <span className="pipeline-ext pipeline-ext-pdf">PDF</span>
                <div className="pipeline-file-info">
                  <span className="pipeline-file-label">BID RISK REPORT</span>
                  <span className="pipeline-file-name">bid-risk-report.pdf</span>
                </div>
                <div className="pipeline-grade">B</div>
              </div>
            </div>

          </div>

          {/* 5-step cards */}
          <div className="steps-row" data-reveal>
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
              <div key={i} className={`step-card${activeStep === i ? ' step-card-active' : ''}`}>
                <div className="step-card-num">{s.num}</div>
                <h4 className="step-card-title">{s.title}</h4>
                <p className="step-card-desc">{s.desc}</p>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ACCURACY / HONEST FRAMING */}
      <section className="accuracy-section" id="accuracy">
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
            <p>
              Where we matched, we say HIGH. Where we missed, we mark MISS — in red,
              in the report. The estimator sees both.
            </p>
          </div>
          <div className="accuracy-pills">
            {[
              { level: 'high',   sub: 'confirmed against plans' },
              { level: 'medium', sub: 'verify before pricing' },
              { level: 'low',    sub: 'estimator must confirm' },
              { level: 'miss',   sub: "AI's own gap, disclosed in red" },
            ].map((p, i) => (
              <div key={i} className="accuracy-pill-item">
                <RiskPill level={p.level} size="md" />
                <span className="accuracy-pill-sub">{p.sub}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* THE DIFFERENCE */}
      <section className="difference-section" id="difference">
        <div className="difference-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">The Difference</span>
            <h2>QA&apos;d or Not.</h2>
          </div>

          <div className="diff-table" data-reveal>

            {/* Left — unreviewed */}
            <div className="diff-col diff-col-left">
              <div className="diff-header diff-header-left">BID GOES OUT</div>
              {[
                'Plan grade verified',
                'Quantities double-checked',
                'Geotech cross-referenced',
                'Scope gaps surfaced',
                'Estimator confidence graded',
              ].map((label, i) => (
                <div key={i} className="diff-row">
                  <Minus size={15} className="diff-icon-no" strokeWidth={2.5} />
                  <span>{label}</span>
                </div>
              ))}
              <div className="diff-separator" />
              <div className="diff-outcome diff-outcome-left">
                Change order<br />or margin hit
              </div>
            </div>

            {/* vs. chip — visible on mobile only */}
            <div className="diff-vs">VS</div>

            {/* Right — QA'd */}
            <div className="diff-col diff-col-right">
              <div className="diff-header diff-header-right">BID GOES OUT &mdash; QA&apos;D</div>
              {[
                'Plan grade verified',
                'Quantities double-checked',
                'Geotech cross-referenced',
                'Scope gaps surfaced',
                'Estimator confidence graded',
              ].map((label, i) => (
                <div key={i} className="diff-row">
                  <Check size={15} className="diff-icon-yes" strokeWidth={2.5} />
                  <span>{label}</span>
                </div>
              ))}
              <div className="diff-separator" />
              <div className="diff-outcome diff-outcome-right">
                Priced correctly<br />or passed
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="pricing-section" id="pricing">
        <div className="pricing-inner">

          {/* LEFT — sticky price card */}
          <div className="pricing-col-left">
            <div className="section-header pricing-section-header" data-reveal>
              <span className="titan-label">Pricing</span>
              <h2>Simple. Per Plan Set.</h2>
              <p className="section-sub">No subscription. No seat fees. Creating an account, uploading plans, and viewing past takeoffs are free &mdash; you only pay when you run the analysis.</p>
            </div>
            <div data-reveal>
              <div className="pricing-card">
                <div className="pricing-card-header">
                  <div className="pricing-tier-label">QA Bid Review</div>
                  <div className="pricing-amount">
                    <span className="pricing-dollar">$</span>
                    <span className="pricing-num">97</span>
                    <span className="pricing-per">/ report</span>
                  </div>
                  <p className="pricing-tagline">One plan set. Full Bid Risk Report. Downloadable PDF.</p>
                </div>
                <div className="pricing-billing">
                  <div className="pricing-billing-row">
                    <span className="pricing-billing-tag pricing-billing-tag-free">Free</span>
                    <span className="pricing-billing-text">Create an account, upload your plans, and view every past takeoff &mdash; no charge.</span>
                  </div>
                  <div className="pricing-billing-row">
                    <span className="pricing-billing-tag pricing-billing-tag-paid">$97</span>
                    <span className="pricing-billing-text">Charged once when you run the full multi-pass analysis on a new plan set. Re-runs of that same set are included.</span>
                  </div>
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
                  <p className="pricing-disclaimer">Uploading and previewing are free. You&apos;re only charged the $97 when you run the full analysis on a new plan set. Report is ready immediately.</p>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT — fanned PDF page previews */}
          <div className="pricing-col-right">
            <div className="pp-kicker">
              <span className="titan-label">// 16 Pages — What's In the Report</span>
            </div>

            <div className="pp-stack">

              {/* PAGE 01 — Cover */}
              <div className="page-preview pp-1" data-reveal>
                <div className="pp-inner">
                  <div className="pp-page-label">PAGE 01 / 16</div>
                  <div className="pp-cover-title">QA BID REVIEW</div>
                  <div className="pp-cover-subtitle">Bid Risk Report</div>
                  <div className="pp-cover-meta">
                    <div className="pp-meta-row"><span className="pp-meta-key">Contractor</span><span className="pp-meta-val">Valley Utility Contractors</span></div>
                    <div className="pp-meta-row"><span className="pp-meta-key">Engineer</span><span className="pp-meta-val">Meridian Engineering Group</span></div>
                    <div className="pp-meta-row"><span className="pp-meta-key">Plan Date</span><span className="pp-meta-val">March 2025</span></div>
                    <div className="pp-meta-row"><span className="pp-meta-key">Sheets</span><span className="pp-meta-val">C101–C412 (38 sheets)</span></div>
                    <div className="pp-meta-row"><span className="pp-meta-key">Geotech</span><span className="pp-meta-val">BV Associates Report #24-118</span></div>
                    <div className="pp-meta-row"><span className="pp-meta-key">Review Date</span><span className="pp-meta-val">April 14, 2025</span></div>
                  </div>
                  <div className="pp-cover-footer">
                    <div className="pp-grade-stamp">B+</div>
                    <div className="pp-legend">
                      <RiskPill level="high" size="sm">Confirmed</RiskPill>
                      <RiskPill level="medium" size="sm">Calculated</RiskPill>
                      <RiskPill level="low" size="sm">Inferred</RiskPill>
                      <RiskPill level="miss" size="sm">Miss</RiskPill>
                    </div>
                  </div>
                </div>
              </div>

              {/* PAGE 04 — Executive Summary */}
              <div className="page-preview pp-2" data-reveal>
                <div className="pp-inner">
                  <div className="pp-page-label">PAGE 04 / 16</div>
                  <div className="pp-section-title">Executive Summary — Key Variances</div>
                  <table className="pp-table">
                    <thead>
                      <tr>
                        <th>System</th>
                        <th>AI Extract</th>
                        <th>Actual</th>
                        <th>Delta</th>
                        <th>Flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>8″ DI Water Main</td>
                        <td>1,840 LF</td>
                        <td>1,840 LF</td>
                        <td>—</td>
                        <td><RiskPill level="high" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Dewatering</td>
                        <td>Not found</td>
                        <td>$42,000</td>
                        <td>–$42K</td>
                        <td><RiskPill level="miss" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>4″ Force Main</td>
                        <td>610 LF</td>
                        <td>610 LF</td>
                        <td>—</td>
                        <td><RiskPill level="high" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Traffic Control</td>
                        <td>Not found</td>
                        <td>$18,500</td>
                        <td>–$18.5K</td>
                        <td><RiskPill level="miss" size="sm" /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* PAGE 08 — Per-Division Line Items */}
              <div className="page-preview pp-3" data-reveal>
                <div className="pp-inner">
                  <div className="pp-page-label">PAGE 08 / 16</div>
                  <div className="pp-section-title">Division 02 — Water Distribution</div>
                  <div className="pp-sheet-badge">Sheet C202</div>
                  <table className="pp-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Size</th>
                        <th>Mat</th>
                        <th>Qty</th>
                        <th>Unit</th>
                        <th>Src</th>
                        <th>Conf</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Water Main</td>
                        <td>8″</td>
                        <td>DI</td>
                        <td>1,840</td>
                        <td>LF</td>
                        <td>C202</td>
                        <td><RiskPill level="high" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Gate Valve</td>
                        <td>8″</td>
                        <td>MJ</td>
                        <td>6</td>
                        <td>EA</td>
                        <td>C202</td>
                        <td><RiskPill level="high" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Fire Hydrant</td>
                        <td>6″</td>
                        <td>—</td>
                        <td>4</td>
                        <td>EA</td>
                        <td>C205</td>
                        <td><RiskPill level="medium" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Air Release</td>
                        <td>2″</td>
                        <td>—</td>
                        <td>2</td>
                        <td>EA</td>
                        <td>Spec</td>
                        <td><RiskPill level="low" size="sm" /></td>
                      </tr>
                      <tr>
                        <td>Dewatering</td>
                        <td>—</td>
                        <td>—</td>
                        <td>LS</td>
                        <td>—</td>
                        <td>—</td>
                        <td><RiskPill level="miss" size="sm" /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* PAGE 14 — Pre-Bid Checklist */}
              <div className="page-preview pp-4" data-reveal>
                <div className="pp-inner">
                  <div className="pp-page-label">PAGE 14 / 16</div>
                  <div className="pp-section-title">Before Your Number Leaves the Building</div>
                  <div className="pp-checklist">
                    <div className="pp-check-row pp-check-pass">
                      <span className="pp-check-mark">✓</span>
                      <span className="pp-check-text">Water main quantities verified against plan callout</span>
                      <RiskPill level="high" size="sm" />
                    </div>
                    <div className="pp-check-row pp-check-pass">
                      <span className="pp-check-mark">✓</span>
                      <span className="pp-check-text">Geotech cross-referenced — no rock noted</span>
                      <RiskPill level="high" size="sm" />
                    </div>
                    <div className="pp-check-row pp-check-warn">
                      <span className="pp-check-mark pp-x">✗</span>
                      <span className="pp-check-text">Dewatering not in takeoff — geotech shows high water table</span>
                      <RiskPill level="miss" size="sm" />
                    </div>
                    <div className="pp-check-row pp-check-warn">
                      <span className="pp-check-mark pp-x">✗</span>
                      <span className="pp-check-text">Traffic control not scoped — arterial road work on Sheets C301</span>
                      <RiskPill level="miss" size="sm" />
                    </div>
                    <div className="pp-check-row pp-check-mid">
                      <span className="pp-check-mark">~</span>
                      <span className="pp-check-text">CCTV inspection — spec referenced, no unit price included</span>
                      <RiskPill level="medium" size="sm" />
                    </div>
                    <div className="pp-check-row pp-check-pass">
                      <span className="pp-check-mark">✓</span>
                      <span className="pp-check-text">Permit allowance confirmed in bid notes</span>
                      <RiskPill level="high" size="sm" />
                    </div>
                  </div>
                </div>
              </div>

            </div>{/* end pp-stack */}

            <div className="pp-toc" data-reveal>
              <div className="pp-toc-label">All 16 pages include</div>
              <div className="pp-toc-grid">
                {[
                  ['01', 'Cover & project metadata'],
                  ['02', 'Plan quality grade & methodology'],
                  ['03–05', 'Executive summary variances'],
                  ['06–10', 'Per-division line-item tables'],
                  ['11', 'Geotech cross-reference'],
                  ['12', 'Scope gap analysis'],
                  ['13', 'Clarification questions'],
                  ['14', 'Pre-bid go/no-go checklist'],
                  ['15', 'Recommended bid notes'],
                  ['16', 'Confidence score & appendix'],
                ].map(([pg, desc]) => (
                  <div key={pg} className="pp-toc-row">
                    <span className="pp-toc-pg">{pg}</span>
                    <span className="pp-toc-desc">{desc}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>{/* end pricing-col-right */}

        </div>
      </section>

      {/* FAQ */}
      <section className="faq-section" id="faq">
        <div className="faq-inner">
          <div className="section-header" data-reveal>
            <span className="titan-label">Questions</span>
            <h2>Common Questions</h2>
          </div>
          <div className="faq-list">
            {FAQS.map((f, i) => <FAQ key={i} {...f} defaultOpen={i === 0} />)}
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
            Free to create an account, upload, and view past takeoffs. $97 per plan set,
            charged only when you run the analysis. No subscription.
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
