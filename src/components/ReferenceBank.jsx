import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Search, ChevronLeft, ChevronRight, X } from 'lucide-react'
import './ReferenceBank.css'

/* ════════════════════════════════════════════════════════════════
   REFERENCE BANK — in-app help articles for Takeoff Copilot
   Slide-over panel. No routing, no external markdown lib.
   ════════════════════════════════════════════════════════════════ */

const CATEGORIES = [
  'Getting Started',
  'Understanding Results',
  'Working with the Takeoff',
  'Account & Limits',
  'Troubleshooting',
]

const ARTICLES = [
  /* ─── GETTING STARTED ─── */
  {
    slug: 'first-takeoff',
    title: 'Your first takeoff in 5 steps',
    category: 'Getting Started',
    body: `Takeoff Copilot turns a plan set into a structured wet-utility takeoff. Here's the whole flow, start to finish.

## 1. Upload your plan set

Drop a PDF (up to 100 MB) into the sidebar. The file uploads straight to secure storage and processing starts automatically — you'll see live progress as pages are prepared.

## 2. Triage classifies every sheet

Before any counting happens, the system reads the whole set and labels each sheet: utility plan, plan & profile, detail sheet, cover, grading, and so on. It also screens the set for legibility and assigns a plan grade (A, B, or C). This takes a minute or two on a typical set.

## 3. Pick sheets on the sheet map

You get a visual grid of every page with its classification badge. Sheets that carry quantities — utility plans and profiles — come pre-selected. Toggle anything on or off. Skipping cover sheets, landscaping, and electrical saves analysis time and keeps the takeoff clean.

## 4. Run the analysis

Hit **Proceed** and the 5-pass analysis engine goes to work: plan quantities, profiles, merge and reconcile, a small-diameter sweep, and a check against the engineer's own quantity table. Progress shows pass by pass. A typical set finishes in a few minutes.

## 5. Review and export

You get line items with confidence tags (HIGH / MEDIUM / LOW), depth data per structure and run, an engineer variance table, and risk flags. Answer the AI's clarifying questions, edit anything that needs adjusting, then export to CSV, Excel, or a PDF report.

**Tip:** the takeoff is a verified starting point, not a finished bid. The confidence tags tell you exactly where to spend your review time — start with the LOW items.`,
  },
  {
    slug: 'plan-set-quality',
    title: 'What plan sets work best',
    category: 'Getting Started',
    body: `Accuracy is plan-dependent. The same engine that hits 100% on a clean pad site can only do so much with a blurry scan. Here's what drives the difference.

## Vector PDFs vs scans

Most engineering PDFs exported from CAD carry a real **text layer** — the pipe callouts, station numbers, and elevation figures exist in the file as text, not just pixels. Takeoff Copilot extracts that text and treats it as ground truth for numbers, diameters, and materials, using the image only for geometry and symbols. That's the best case.

Scanned or flattened plans are **raster-only**: every number has to be read visually from the image. It still works, but extractability is lower and you'll see a banner telling you the set is raster-only.

## The A / B / C grade

Every upload is screened before analysis:

- **Grade A** — explicit callouts, consistent labeling, profiles present. Expect high accuracy with mostly HIGH-confidence items.
- **Grade B** — usable, but some quantities will be scaled or inferred. Expect more MEDIUM items that need a second look.
- **Grade C** — dense, poorly labeled, or heavily degraded. The system may decline to analyze rather than hand you numbers it can't stand behind.

## Why dense raster sets score lower

A low-quality plan doesn't mean a simple job — it usually means a complex job with inadequate documentation. Unlabeled pipe segments, callouts buried under keynote bubbles, and missing profiles force the engine to infer instead of read, and inference is capped at MEDIUM or LOW confidence on purpose.

**What you can do:** request the original CAD-exported PDF from the engineer instead of a scan, and include the profile sheets — they're engineer-dimensioned and dramatically improve length and depth accuracy.`,
  },

  /* ─── UNDERSTANDING RESULTS ─── */
  {
    slug: 'five-pass-analysis',
    title: 'How the 5-pass analysis works',
    category: 'Understanding Results',
    body: `One look at a plan sheet misses things — that's as true for software as it is for a person. So Takeoff Copilot reads your sheets five separate times, each pass with one job.

## Pass 1 — Plan quantities

Every pipe run, structure, fitting, valve, hydrant, FDC, and service visible in plan view. Sheets are split into overlapping tiles so nothing gets lost at the edge of a page, and every item is tagged with its best location — station, structure ID, or street name.

## Pass 2 — Profiles

Profiles are read separately: stationing, rim and invert elevations, slope, and run length. This is where depth data comes from, and it's the most reliable source of lengths because profiles are dimensioned by the engineer.

## Pass 3 — Merge and reconcile

The two reads are combined. Duplicates from overlapping tiles are removed using those location tags. Where plan and profile disagree on a length by more than 5%, the item is **flagged showing both values — never silently averaged**. Depths are computed from rim minus invert.

## Pass 4 — Small-diameter sweep

A dedicated pass just for small lines: 1", 1.5", and 2" domestic and irrigation services. Calibration against real field takeoffs showed these are the most commonly missed items on any plan, so they get their own look.

## Pass 5 — Engineer table check

If the engineer printed a quantity table, it gets parsed and compared against our takeoff line by line. Anything off by more than 5% lands in the variance table for your review.

## Why multiple passes beat one look

Each pass is simple and focused, so it's harder to fool. And because plan view, profiles, and the engineer's table are three independent sources, disagreements between them surface as flags instead of hiding inside a single number. That cross-checking is the accuracy core of the product.`,
  },
  {
    slug: 'confidence-levels',
    title: 'Confidence levels: HIGH / MEDIUM / LOW',
    category: 'Understanding Results',
    body: `Every line item carries a confidence tag. It's not decoration — it's a direct instruction about where your review time should go.

## HIGH

Size, material, and length were all **explicitly called out** on the plans, or the structure was clearly labeled with type, size, and depth. The note tells you where the callout was found (e.g. "Callout at Sta 10+00 profile").

**What to verify:** spot-check a few. HIGH items track the plans closely, but the plans themselves can still contain engineer errors.

## MEDIUM

The item is visible, but something was **scaled or inferred** rather than dimensioned — a length estimated from the drawing, a material implied by spec section rather than labeled, a structure shown symbolically without depth. The note states exactly what assumption was made.

**What to verify:** the assumption in the note. These are the "confirm before pricing" items.

## LOW

Inferred from symbols, context, or partially obscured areas — a callout hidden under a keynote bubble, a run with no scale reference, a smudged scan. The note states what triggered the inference and what resolves it.

**What to verify:** everything on the line. Treat LOW items as leads, not quantities. Many of them also generate clarifying questions in the chat panel — answering those is the fastest way to firm them up.

## The honest-uncertainty rule

The engine is instructed never to fabricate an item and never to dress up a guess as a fact. A takeoff with some LOW items and clear notes is worth more than one that looks clean but hides its guesses. If the tags skew heavily MEDIUM/LOW, that's the plan set talking — see "What plan sets work best."`,
  },
  {
    slug: 'depth-engine',
    title: 'Depth engine & trench safety',
    category: 'Understanding Results',
    body: `Depth drives excavation cost, bedding, shoring, and production rates — so it gets computed, not eyeballed.

## Where depth comes from

For every structure and run with rim and invert elevations on the profile, depth is **rim minus invert**. Explicitly dimensioned depths are used as-is (HIGH confidence); depths computed from rim/invert callouts are tagged MEDIUM with the math noted; anything undeterminable is flagged "depth unknown — must verify before pricing excavation."

## Depth buckets

Pipe footage is broken into LF by depth range (e.g. 0–5 ft, 5–10 ft, 10+ ft) so you can price trench work by band instead of one blended average. Average and maximum depth per run are also reported.

## Trench safety triggers

- **≥ 5 ft:** OSHA requires a protective system — sloping, benching, shielding, or shoring. The takeoff calls out total LF at or beyond 5 ft so trench safety can be priced as its own line.
- **≥ 10 ft:** flagged as deep excavation. Expect engineered shoring or trench boxes rated for the depth, and a protective system designed by a registered professional engineer at 20 ft or more.

## Rock and groundwater

If a geotech report is included in the upload, the analysis cross-references boring data against your trench depths. Rock above invert or groundwater within the excavation zone generates a risk flag — those two items sink more utility bids than any counting error.

**Bottom line:** never price excavation off the depth summary alone when a run is tagged "depth unknown." That tag exists to stop exactly that.`,
  },
  {
    slug: 'engineer-variance',
    title: 'The engineer variance table',
    category: 'Understanding Results',
    body: `When the plan set includes the engineer's own quantity table, Pass 5 parses it and lines it up against our takeoff, item by item.

## Reading the table

Each row shows the item, **our quantity**, the **engineer's printed quantity**, and the percentage difference. Rows within 5% are considered in agreement. Anything beyond **5%** is flagged for review.

## When the numbers disagree

A flagged variance doesn't automatically mean either side is wrong:

- Engineer tables are sometimes stale — revised plans, unrevised table.
- Engineer tables sometimes cover a different scope (public vs private, phase 1 vs full build).
- Our read can be off on poorly labeled runs — check the confidence tag on the item.

Either way, a big variance on a big-dollar item is exactly the thing you want to find **before** bid day, not after. Chase down the reason; don't just pick a side.

## UNQUANTIFIED rows

Rows marked **UNQUANTIFIED** are items that appear in the engineer's table but that the analysis could not independently quantify from the drawings — or the reverse. Common causes: the item lives on a sheet you didn't select, it's shown only in a detail, or the callout is illegible. Treat these as a checklist of items needing a manual count.

**Tip:** if the whole table is empty, the set likely has no printed quantity table, or it sits on a sheet that wasn't included in the analysis. Re-run with the general notes / quantity sheets selected.`,
  },
  {
    slug: 'plan-profile-mismatch',
    title: 'Plan vs profile mismatches',
    category: 'Understanding Results',
    body: `The same pipe run often shows up twice in a plan set — once in plan view, once in profile — and the two don't always agree.

## Why they differ

Plan-view lengths are frequently scaled off the drawing; profile lengths are **dimensioned by the engineer** along the run with stationing. Horizontal curves, fittings, and drafting shortcuts all create daylight between the two numbers.

## What the system does

During merge and reconcile, matching runs are paired up by station and structure IDs. If the lengths differ by more than 5%, the line item is **flagged and shows both values side by side**. The two numbers are never averaged and never silently summed — averaging a real discrepancy just hides it.

## Which number governs

As a rule, **the profile governs**: it's the engineer-dimensioned measurement. The takeoff uses the profile value as primary when both exist.

## Always verify

"Usually governs" is not "always right." Before you commit the quantity:

- Check whether the profile stationing actually covers the full run shown in plan (profiles sometimes stop at a match line or phase limit).
- Check for a plan revision that didn't make it into the profile sheet.
- On big deltas, measure it yourself — a 40% mismatch usually means the two views are showing different scope, not a scaling error.

Flagged mismatches also appear in the clarification questions, so you can resolve them in the chat and have your answer carried into the export.`,
  },
  {
    slug: 'coverage-warnings',
    title: 'Coverage warnings',
    category: 'Understanding Results',
    body: `Big sheets are analyzed in overlapping tiles. A coverage warning means some tiles didn't complete — which means **parts of your plans were never analyzed**.

## Failed tiles

Each tile is attempted multiple times before it's given up on. If a tile still fails after retries, the analysis finishes anyway and reports which sheets have gaps, rather than pretending the whole sheet was covered. Quantities from that sheet may be incomplete — anything living in the failed area simply isn't in the takeoff.

## Raster-only mode

A separate banner appears when the set carries essentially no embedded text layer (scanned plans). Analysis still runs, but every number is a vision read from pixels instead of being cross-checked against the file's own text. Expect lower confidence tags across the board. This is a property of the file you uploaded, not a failure — see "What plan sets work best" for how to get a better source file.

## What to do about coverage gaps

- **Re-run the analysis.** Tile failures are often transient (timeouts, rate limits) and a retry usually clears them.
- **Trim the sheet selection.** Very large runs can hit the processing time limit; analyzing fewer sheets per run leaves more headroom for retries.
- **Manually review the flagged sheets.** If a gap persists, open that sheet in Plan View and count the affected area by hand.

**Never export around an unresolved coverage warning on a quantity-bearing sheet.** A missing tile on a cover sheet is nothing; a missing tile on the main utility plan is a hole in your bid.`,
  },

  /* ─── WORKING WITH THE TAKEOFF ─── */
  {
    slug: 'answering-questions',
    title: "Answering the AI's questions",
    category: 'Working with the Takeoff',
    body: `After analysis, the chat panel surfaces clarification questions. These aren't small talk — each one is tied to a specific unresolved item in your takeoff.

## What gets asked

- **Depth gaps** — structures or runs where no rim/invert data was found ("MH-4 has no invert callout — do you know the depth, or should it be carried as unknown?").
- **Plan vs profile mismatches** — where the two views disagree and the system wants your ruling.
- **Low-confidence items** — symbol-only reads, obscured callouts, bore crossings that don't say wet or dry, items that may be outside your scope (grease interceptors, conduit).

## Why answering is worth your time

Your answers are applied directly to the takeoff: quantities firm up, confidence tags upgrade, and flags clear. The resolved values — and the fact that you resolved them — carry through to your CSV, Excel, and PDF exports. An export with the questions answered is a bid-ready document; one with 15 open questions is a draft.

## How to answer

Plain language works. "MH-4 is 12 feet to invert," "use the profile length," "the bore at Sta 14+50 is a dry bore, add casing," "grease trap is not our scope." One question at a time or all at once — the panel keeps track of what's resolved and shows your progress.

**If you don't know the answer,** say so — "carry it as unknown" is a valid answer. The item stays flagged in the export, which is exactly what your estimator reviewing the bid needs to see.`,
  },
  {
    slug: 'editing-line-items',
    title: 'Editing line items',
    category: 'Working with the Takeoff',
    body: `The takeoff table isn't read-only. If you know better than the plans — and sometimes you do — change it.

## Inline edits

Click into a line item to adjust quantity, size, material, or description directly in the table. Edits save automatically to the project; there's no separate save step.

## Edits are permanent to the project

Your changes persist with the project and are what you'll see when you come back to it. They are **included in every export** — CSV, Excel, and the PDF report all reflect the edited values, not the original AI reads.

## Good habits

- **Edit the quantity, keep the note.** The confidence note records where the number came from — useful context even after you've corrected it.
- **Use the chat for systematic issues.** If one run is wrong, edit it. If the AI misread a whole class of items (say, it called your C900 water line PVC sanitary), tell the chat panel — it can correct the pattern across items instead of you editing thirty rows.
- **Don't delete flagged items to clean up the export.** A flagged unknown in front of your estimator is worth more than a tidy-looking hole in the scope.

## Re-running analysis

A fresh analysis run generates fresh line items. If you've made substantial manual edits, export first — re-running is the one operation that can supersede your edited table.`,
  },
  {
    slug: 'exports',
    title: 'Exports: CSV, Excel, PDF report',
    category: 'Working with the Takeoff',
    body: `Every takeoff exports in three formats, all reflecting your current state — inline edits and answered clarifications included.

## CSV

The raw table: item, category, size, material, quantity, unit, depth data, confidence, and notes. Best for pulling into your own estimating software or a bid spreadsheet you already maintain. No formatting, maximum portability.

## Excel

The same data, organized for humans: items grouped by category (sanitary, storm, water, fire, services), depth buckets broken out, variance table on its own sheet, flagged items highlighted. Best for working the bid.

## PDF report

The presentation document: executive summary, plan grade, confidence score, quantities by category, engineer variance table, risk flags, and open assumptions. Best for the estimator or owner who needs to review the takeoff without opening a spreadsheet — and for your bid file, as a record of what was known and assumed at bid time.

## Before you export

- Answer the clarification questions — resolved items export at their resolved values.
- Clear or acknowledge any coverage warnings on quantity-bearing sheets.
- Skim the LOW-confidence items one last time.

**The confidence tags and notes ship in every format.** That's deliberate: whoever prices this work downstream should see the same uncertainty you saw.`,
  },

  /* ─── ACCOUNT & LIMITS ─── */
  {
    slug: 'usage-limits',
    title: 'Usage limits',
    category: 'Account & Limits',
    body: `Analysis runs are computationally heavy — a full 5-pass run on a big set makes hundreds of AI calls — so accounts carry daily limits to keep the service fast and available for everyone.

## What's limited

- **Analysis runs per day** — full 5-pass analyses started per account.
- **AI calls per day** — the underlying model calls consumed by analyses, triage, and chat combined. A large plan set consumes more than a small one.

When you hit a cap you'll get a clear message rather than a silent failure, and the counter resets daily.

## Making your limit go further

- Deselect non-utility sheets on the sheet map — covers, landscaping, and electrical burn calls without adding quantities.
- Fix upload problems before re-running; a failed analysis resumes where it stopped rather than starting over, so retries are cheaper than fresh runs.
- Use chat for corrections instead of re-running the full analysis.

## Need more?

If your workload genuinely needs higher caps — multiple estimators, large sets daily — contact **hello@6signal.co** and we'll raise your limits. Tell us roughly how many sets per week you run and the typical page count; it helps us size the account correctly.`,
  },
  {
    slug: 'your-data',
    title: 'Your data',
    category: 'Account & Limits',
    body: `A plan set is bid-sensitive material. Here's exactly how yours is handled.

## Storage

Uploaded plans are stored **privately, per account**, in access-controlled storage. Files are readable only by your authenticated account and by the processing pipeline — there is no public URL to your plans, and other users cannot see your projects, sheets, or takeoffs.

## Analysis

Plan analysis runs on **Anthropic's Claude API**. During an analysis, your sheet images and extracted text are sent to Anthropic for processing, subject to Anthropic's commercial API data terms. Your plans are not used to train our models.

## What we keep

Your projects, sheets, line items, edits, and analysis results are retained so you can return to a takeoff later. Job history in the sidebar is your own account's history only.

## Deleting your data

**Delete a project to remove its files** — the uploaded PDF, generated sheet images and thumbnails, and the associated takeoff data are removed from storage. If you need an account-level wipe or have a data question that isn't covered here, contact **hello@6signal.co**.`,
  },

  /* ─── TROUBLESHOOTING ─── */
  {
    slug: 'analysis-failed',
    title: 'Analysis failed or stuck',
    category: 'Troubleshooting',
    body: `Occasionally an analysis errors out or sits at the same percentage too long. Here's the triage.

## First: retry from the sidebar

Open the project in the sidebar and start the analysis again. **Failed runs resume where they stopped** — completed passes and finished sheets aren't redone, so a retry after a mid-run failure is fast and doesn't double-bill your daily limits for the finished work.

## If it looks stuck

- Progress on large sets genuinely moves in bursts — a 3×3-tiled Arch E profile sheet can hold one percentage for a couple of minutes. Give it five minutes before calling it stuck.
- Refresh the page. Progress streams live, and a dropped connection can freeze the display even though the run is still going server-side.

## Very large sets

Extremely large analysis selections (roughly 25+ sheets) can run into the processing time limit. The error message will say so. Split the work: run the sanitary/storm sheets as one analysis and water/fire as another, or deselect detail sheets that carry no quantities.

## If retries keep failing

Contact support at **hello@6signal.co** with the project name and roughly when the run failed. The processing logs are kept server-side, so we can usually see exactly which sheet and pass died and fix it from our end.`,
  },
  {
    slug: 'upload-problems',
    title: 'Upload problems',
    category: 'Troubleshooting',
    body: `Uploads go straight from your browser to secure storage, so most problems are about the file itself or the connection.

## File requirements

- **PDF** — up to **100 MB** per file. This is the normal path for plan sets.
- **Images** — PNG or JPG, for single sheets or photos of paper plans.
- Password-protected or corrupted PDFs will fail processing — remove the password and re-export before uploading.

## Over the size limit?

Plan sets over 100 MB are almost always scans at unnecessary resolution or sets padded with hundreds of non-utility sheets. Two fixes:

- Ask the engineer for the CAD-exported PDF — vector sets are dramatically smaller **and** analyze better than scans.
- Split or trim the set to the civil/utility sheets before uploading. Any standard PDF tool can extract a page range.

## Multi-hundred-page sets

Very large page counts can make the processing stage slow or push past its time limit even when the file size is fine. If a 300-page full-discipline set stalls during processing, trim it to the civil sheets and re-upload — triage is good at classifying sheets, but it can't classify pages that never finish processing.

## Upload fails or hangs

- Check your connection and retry — the failed state clears and you can re-upload immediately.
- Corporate networks and VPNs sometimes block large direct-to-storage uploads; try off-VPN.
- Still stuck? Contact **hello@6signal.co** with the file size and page count.`,
  },
]

/* ════════════════════════════════════════════════════════════════
   Tiny markdown-ish renderer: ## subheads, **bold**, "- " bullets,
   blank-line-separated paragraphs. No external deps.
   ════════════════════════════════════════════════════════════════ */

function renderInline(text) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

function renderBody(body) {
  const lines = body.split('\n')
  const blocks = []
  let para = []
  let list = null

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: para.join(' ') })
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'ul', items: list })
      list = null
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushPara()
      flushList()
    } else if (line.startsWith('## ')) {
      flushPara()
      flushList()
      blocks.push({ type: 'h2', text: line.slice(3) })
    } else if (line.startsWith('- ')) {
      flushPara()
      if (!list) list = []
      list.push(line.slice(2))
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()

  return blocks.map((block, i) => {
    if (block.type === 'h2') {
      return (
        <h3 className="rb-article-subhead" key={i}>
          {renderInline(block.text)}
        </h3>
      )
    }
    if (block.type === 'ul') {
      return (
        <ul className="rb-article-list" key={i}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    }
    return <p key={i}>{renderInline(block.text)}</p>
  })
}

/* ════════════════════════════════════════════════════════════════
   Component
   ════════════════════════════════════════════════════════════════ */

export default function ReferenceBank({ open, onClose, initialTopic }) {
  const [query, setQuery] = useState('')
  const [activeSlug, setActiveSlug] = useState(null)

  // Jump to a requested topic whenever the panel is opened with one
  useEffect(() => {
    if (open && initialTopic && ARTICLES.some((a) => a.slug === initialTopic)) {
      setActiveSlug(initialTopic)
    }
  }, [open, initialTopic])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Body scroll lock while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const activeArticle = useMemo(
    () => ARTICLES.find((a) => a.slug === activeSlug) || null,
    [activeSlug]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ARTICLES
    return ARTICLES.filter(
      (a) => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q)
    )
  }, [query])

  const searching = query.trim().length > 0

  const openArticle = (slug) => setActiveSlug(slug)
  const backToList = () => setActiveSlug(null)

  return (
    <div className={`rb-root ${open ? 'rb-open' : ''}`} aria-hidden={!open}>
      <div className="rb-backdrop" onClick={onClose} />

      <aside
        className="rb-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Reference Bank"
      >
        {/* HEADER */}
        <div className="rb-header">
          <div className="rb-header-title">
            <BookOpen size={16} className="rb-header-icon" />
            <span className="rb-title-text">
              Reference Bank <span className="rb-title-sep">//</span>
            </span>
          </div>
          <button className="rb-close" onClick={onClose} aria-label="Close reference bank">
            <X size={16} />
          </button>
        </div>

        {activeArticle ? (
          /* ── ARTICLE VIEW ── */
          <div className="rb-body" key={activeArticle.slug}>
            <button className="rb-back" onClick={backToList}>
              <ChevronLeft size={14} />
              <span>All topics</span>
            </button>
            <div className="rb-article">
              <div className="rb-article-category">{activeArticle.category}</div>
              <h2 className="rb-article-title">{activeArticle.title}</h2>
              <div className="rb-article-body">{renderBody(activeArticle.body)}</div>
            </div>
          </div>
        ) : (
          /* ── TOPIC LIST VIEW ── */
          <div className="rb-body">
            <div className="rb-search">
              <Search size={14} className="rb-search-icon" />
              <input
                className="rb-search-input"
                type="text"
                placeholder="Search articles..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search articles"
              />
              {searching && (
                <button
                  className="rb-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {searching ? (
              <div className="rb-section">
                <div className="rb-section-label">
                  {filtered.length} result{filtered.length === 1 ? '' : 's'}
                </div>
                {filtered.length === 0 ? (
                  <div className="rb-empty">
                    No articles match "{query.trim()}". Try a different term, or contact
                    hello@6signal.co.
                  </div>
                ) : (
                  filtered.map((a) => (
                    <button
                      key={a.slug}
                      className="rb-topic"
                      onClick={() => openArticle(a.slug)}
                    >
                      <div className="rb-topic-text">
                        <span className="rb-topic-title">{a.title}</span>
                        <span className="rb-topic-cat">{a.category}</span>
                      </div>
                      <ChevronRight size={14} className="rb-topic-arrow" />
                    </button>
                  ))
                )}
              </div>
            ) : (
              CATEGORIES.map((cat) => (
                <div className="rb-section" key={cat}>
                  <div className="rb-section-label">{cat}</div>
                  {ARTICLES.filter((a) => a.category === cat).map((a) => (
                    <button
                      key={a.slug}
                      className="rb-topic"
                      onClick={() => openArticle(a.slug)}
                    >
                      <div className="rb-topic-text">
                        <span className="rb-topic-title">{a.title}</span>
                      </div>
                      <ChevronRight size={14} className="rb-topic-arrow" />
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
