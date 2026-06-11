# TAKEOFF CO-PILOT v2.0 — EVALUATION & BUILD ROADMAP
### From "good prompt" to "PlanGrid for SMB wet utility contractors"
### Prepared for Matt Vincent Walker · 6 Signal · June 2026

---

## PART 1: HONEST EVALUATION OF WHERE YOU ARE

### The calibration record

| Job | Engineer | Accuracy | Plan Grade |
|---|---|---|---|
| Golden Corral (Baytown) | Pape-Dawson | 100% | A |
| Pioneer 360 (Arlington) | Turnkey Tract | 85.7% | B+ |
| Prosper Ridge | Kirkman | 58% | — |
| SurePoint (Spring) | Lindsey | 24% | F |

### The core finding

Your accuracy is **bimodal**, and v1.0 → v1.2 has been treating the symptom, not the disease. Every Brain update adds rules ("watch for INSTALL X LF W/ EMBEDMENT misreads," "sweep for small-diameter lines," "sanity-check RCP quantities"). Those rules are good — but they're compensating for a **pipeline problem**, not a knowledge problem.

The failures at SurePoint and Prosper Ridge share root causes that no prompt rule can fully fix:

1. **Resolution.** pdf.js rasterizes sheets client-side at whatever resolution the browser tolerates. On a dense 24x36 civil sheet, the callouts the model needs ("8" SDR-35 @ 1.04%", invert elevations) are 6pt text. At browser-safe resolution, they're illegible smudges. The model isn't misreading — it literally can't see. This is why clean, sparse Pape-Dawson sheets score 100% and dense Lindsey sheets score 24%.
2. **Single-pass extraction.** One look per sheet means no reconciliation between the plan view and the profile view, no second sweep for small-diameter lines, no cross-check against the engineer's quantity table when one exists.
3. **No depth model.** Depths live in the profiles (rim/invert elevations) and structure schedules. You're not systematically extracting them, so you can't produce the thing wet utility estimators actually price on: LF by depth bucket (0–6', 6–8', 8–10', 10'+), trench safety quantities, and bore depth.
4. **Everything runs in the browser.** Slow uploads, no job persistence, no queue, and — flag this one hard — **the Anthropic API key sits in localStorage and is sent from the client.** For a paid product, that's both a security exposure and the reason uploads feel slow: the user's laptop is doing rasterization work a server should do.

### What v1.2 got right (keep all of it)

- Grade A/B/C screening before committing to a takeoff — this is honest product design and protects the $197 price point.
- Confidence tagging with WHY/WHAT-to-verify notes.
- The pre-takeoff protocol (public/private, city specs, grease trap scope).
- Engineer-specific notes (Kirkman, Lindsey, Pape-Dawson patterns).
- The feedback loop discipline — five calibration jobs in three months is real R&D.

The Brain isn't broken. It's just hit the ceiling of what a prompt pasted into a chat can do. v2 is about turning the Brain into a **system**.

---

## PART 2: WHAT TO BUILD — THE FULL LIST, NO LIMITS

Ordered by accuracy impact per unit of effort.

### Tier 1 — The accuracy unlock (do these first)

**1. Server-side processing pipeline (kills the slow uploads + the localStorage key)**
Move PDF handling off the browser. User uploads the raw PDF via a signed URL straight to Supabase Storage (you're already connected to Supabase). A background function rasterizes pages server-side at 200–300 DPI, runs the analysis pipeline, and writes results to Postgres. The dashboard polls job status. Uploads become "as fast as your internet connection," and your API key lives in an environment variable where it belongs.

**2. Smart sheet triage (your "scan to pick out only the pages it needs")**
Two-stage pass:
- **Stage A (cheap):** Render every page at low resolution, send batches to Claude Haiku to classify each sheet: cover, sheet index, general notes, demo, grading, paving, **utility plan**, **plan & profile**, **storm**, **sanitary**, **water**, **details**, erosion control, landscape, electrical, irrelevant. Also OCR the cover sheet index — engineers list their sheets, and the index is the cheapest classifier there is.
- **Stage B (expensive, targeted):** Only utility plans, profiles, details, and schedule sheets go to the heavy model at high resolution. A 60-sheet set becomes 8–12 analyzed sheets. Faster, cheaper, and the heavy model's attention isn't diluted across landscape plans.

**3. High-resolution tiling (the single biggest accuracy lever)**
For each relevant sheet, render at 250+ DPI and slice into overlapping quadrants/tiles (e.g., 2x2 or 3x3 with 15% overlap). Analyze tiles, then run a merge pass that deduplicates line items appearing in the overlap zones. This is the difference between "can't read the callout" and "reads every callout." Expect SurePoint-class plans to jump from ~25% toward 70%+ from this alone.

**4. Multi-pass extraction with reconciliation**
Replace single-pass with a fixed sequence:
- Pass 1: Plan-view quantity extraction (mains, services, structures, fittings)
- Pass 2: Profile-sheet pass — extract every run's rim/invert/flowline elevations, slopes, and stationing
- Pass 3: Reconciliation — plan LF vs. profile LF per run; mismatches get flagged, not averaged
- Pass 4: Small-diameter sweep (the v1.2 rule, now enforced as its own pass)
- Pass 5: Sanity check against the engineer's quantity table if one exists, with a variance report

**5. Depth engine (your "it doesn't give depths")**
From the profile pass: depth = rim/finished grade elevation − invert elevation at each structure, interpolated along runs. Output per run: average depth, max depth, **LF by depth bucket**, trench safety trigger (>5' OSHA), groundwater proximity if geotech is loaded, and bore depth at crossings. This is what makes the report priceable instead of just countable — it's the feature MBS-type estimators will pay for.

### Tier 2 — The PlanGrid-grade features

**6. Vector/text-layer hybrid extraction**
Most modern civil PDFs are vector, not scans. Server-side, extract the embedded text layer **with coordinates** (pdfplumber or pdf.js getTextContent). Now "8" PVC SDR-35 — 342 LF" is exact text, not a vision read. Use vision for geometry and context, text layer for numbers. Where the text layer exists, callout misreads drop to near zero. Schedule tables (structure schedules, quantity tables) get parsed as actual tables.

**7. Scale-aware measurement (phase 2 of this)**
Detect the scale bar / scale callout per sheet. With vector geometry + scale, you can eventually *measure* pipe runs rather than trusting callouts — true PlanGrid territory. Hard; ship it after 1–6.

**8. Materials visual library (your "show images of materials")**
A `materials` table in Supabase: canonical material → image, spec summary, typical suppliers. Every line item maps to a material record, and the report renders a thumbnail beside each row: SDR-35 pipe, C900, RCP, precast manholes, FDC, RPZ assemblies, hydrants, cleanouts, gate valves, etc. **One caution:** don't scrape Core & Main or Ferguson catalog photos — that's copyrighted material. Use your own photos from job sites (you have field access through Sunbelt relationships), commission/generate a clean illustrated set in the Takeoff Co-Pilot visual identity, or link out to supplier product pages. An owned, consistent illustration set actually looks more premium than mismatched catalog photos.

**9. Engineer & city knowledge base (the Brain becomes a database)**
Move the Brain's accumulated knowledge out of one giant prompt and into Postgres:
- `engineer_profiles` — Kirkman's storm callout quirks, Lindsey's density problem, Pape-Dawson's clarity
- `city_specs` — NCTCOG standards plus per-city overrides for public jobs
- `processing_rules` — every v1.0–v1.2 rule, individually toggleable and versioned
- `project_type_patterns` — restaurants → grease interceptors, etc.
At takeoff time, the system injects only the relevant slices (this engineer, this city, this project type). The prompt gets smaller and sharper, not bigger and mushier.

**10. Correction feedback loop (compounding accuracy)**
After each job, the estimator marks each line item: confirmed / corrected (with the right value) / missed item added. Store every correction. Each correction auto-drafts a candidate rule; you approve it into `processing_rules`. This is the moat — after 50 jobs, no competitor without your correction history can match your accuracy on DFW plans.

**11. Geotech integration**
Upload the soils report alongside the plans. Parse for: rock depth, groundwater elevation, expansive clay, PI values. Cross-reference against your depth engine: "Runs S-4 through S-7 reach 9' depth; geotech shows limestone at 7' — expect rock excavation on ~410 LF." That single flag can be worth tens of thousands on a bid and is a killer demo line.

**12. The Bid Risk Report as the deliverable layer**
You already decided this pivot in May (review-before-you-submit framing, comparison engine diffing the estimator's numbers vs. the AI read). v2's pipeline feeds it: depth buckets, reconciliation variances, geotech flags, and confidence tagging all roll into one branded PDF.

### Tier 3 — Product polish

13. Projects & auth (Supabase auth, jobs saved per account — required for the $497/mo tier anyway)
14. Streaming progress UI ("Classifying 64 sheets… Analyzing C-401 tile 3 of 9…") — perceived speed matters as much as real speed
15. Accuracy scoreboard per engineer/plan-grade — marketing gold ("94% average on Grade A plans across 23 jobs")
16. Export: CSV, Excel (formatted), and the branded Bid Risk PDF

---

## PART 3: CLAUDE CODE PROMPTS

Run these in order from the `takeoff-copilot` repo. Each is one session. Commit between prompts.

---

### PROMPT 1 — Backend foundation (Supabase + server-side processing)

```
We're migrating Takeoff Copilot from client-only to a proper backend. Current stack: React 18 + Vite, pdf.js rasterizing in the browser, Anthropic API called directly from the client with a key in localStorage, deployed on Netlify.

Build this migration:

1. Add Supabase: storage bucket "plan-uploads", Postgres tables: projects (id, user_id, name, status, created_at), sheets (id, project_id, page_number, classification, dpi, storage_path), line_items (id, project_id, category, description, quantity, unit, confidence, confidence_note, depth_avg, depth_max, depth_bucket_json, source_sheet, status), jobs (id, project_id, stage, progress, error, created_at, updated_at).

2. Upload flow: client requests a signed upload URL from a Netlify function, uploads the raw PDF directly to Supabase Storage. No client-side rasterization at all — remove the pdf.js rendering from the upload path entirely. Uploads should now take seconds.

3. Create a Netlify background function "process-plan" that: downloads the PDF from storage, rasterizes pages server-side (use pdf-to-img or mupdf via WASM — pick what runs reliably in Netlify functions; if Netlify's limits make rasterization of large plan sets infeasible, set up a small worker on Railway or Fly.io instead and document the choice), saves page images back to storage, and updates the jobs table with progress at each stage.

4. Move the Anthropic API key to a server environment variable. All Claude API calls now happen server-side. Remove the API key input and localStorage logic from the dashboard completely.

5. Dashboard polls the jobs table (or uses Supabase realtime) and shows a live progress state.

Keep the existing Takeoff Copilot design system untouched. Write a MIGRATION.md documenting env vars and the new data flow.
```

---

### PROMPT 2 — Smart sheet triage

```
Add a two-stage sheet classification system to the process-plan pipeline.

Stage A — cheap triage: After rasterization, render every page at low resolution (~72 DPI). Send them in batches of 8 to claude-haiku-4-5 with a classification prompt. Classify each sheet as one of: cover, sheet_index, general_notes, demo, grading, paving, utility_plan, plan_profile, storm, sanitary, water, details, erosion_control, landscape, electrical, other. Also: if a cover or index sheet is found, extract the sheet index table (sheet number → title) and use it to confirm/correct classifications. Store classification per sheet in the sheets table.

Stage B — targeted analysis: Only sheets classified as utility_plan, plan_profile, storm, sanitary, water, or details proceed to the heavy analysis pipeline. All other sheets are skipped and marked "not analyzed — [classification]" so the user can see nothing was hidden.

Dashboard: after triage completes, show a sheet map — thumbnails in a grid with classification badges, analyzed sheets highlighted in the accent color. Let the user manually toggle any sheet into or out of the analysis set before the heavy pass runs, with a "Proceed with N sheets" button.
```

---

### PROMPT 3 — High-res tiling + multi-pass extraction

```
Replace the single-pass sheet analysis with a tiled, multi-pass pipeline. This is the accuracy core.

Tiling: For each sheet in the analysis set, rasterize at 250 DPI. If the resulting image exceeds ~1568px on the long edge after downscaling for the API, slice it into a grid of overlapping tiles (2x2 for 24x36 sheets, 3x3 for very dense sheets — decide based on pixel dimensions) with 15% overlap. Send each tile with context: sheet title, classification, tile position (e.g., "top-left quadrant of sheet C-401").

Pass structure, run in this order per project:
- Pass 1 (plan quantities): extract every utility line item from utility_plan/storm/sanitary/water tiles — pipe runs with diameter, material, length; structures; fittings; valves; hydrants; FDCs; services.
- Pass 2 (profiles): from plan_profile tiles, extract per run: run ID/stationing, rim or finished grade elevations, invert elevations at each structure, slope, length.
- Pass 3 (merge + dedupe): consolidate tile results, deduplicating items that appear in overlap zones (same description + overlapping location), and reconcile plan lengths vs profile lengths per run. Any mismatch >5% becomes a flagged line item with both values shown, never silently averaged.
- Pass 4 (small-diameter sweep): a dedicated pass asking only for lines 2" and smaller — domestic services, irrigation taps, small fire lines. This pass exists because these were systematically missed in calibration.
- Pass 5 (sanity check): if any sheet contains an engineer quantity table, parse it and produce a variance table: our quantity vs engineer quantity per item, with % difference.

Each pass writes structured JSON validated against a schema before insertion into line_items. The system prompt for the heavy passes is the Takeoff Brain — load it from a file at server/prompts/takeoff-brain.md so I can update it without code changes. Use claude-opus-4-8 for passes 1–2 and claude-haiku-4-5 for merge/dedupe formatting work.

Show pass-by-pass progress in the dashboard job status.
```

---

### PROMPT 4 — Depth engine

```
Build the depth engine on top of the profile data from Pass 2.

For every run with elevation data: compute depth at each structure (rim/finished grade minus invert), interpolate depth along the run, and produce: average depth, maximum depth, and LF per depth bucket (0–6 ft, 6–8 ft, 8–10 ft, 10+ ft). Store in line_items (depth_avg, depth_max, depth_bucket_json).

Derived flags, added as report line items:
- Trench safety: total LF deeper than 5 ft (OSHA trigger), called out as its own quantity.
- Deep excavation: any run exceeding 10 ft flagged HIGH risk.
- Crossing depths: where storm/sanitary/water cross, note the controlling depth if determinable from profiles.
- If a geotech report has been uploaded (add an optional second upload slot for it), parse it for rock depth and groundwater elevation, then cross-reference: any run whose max depth reaches rock or groundwater gets a specific flag like "Run S-4: 9.2 ft max depth vs limestone at 7 ft — expect ~410 LF rock excavation."

Report UI: add a Depth Summary section — table of runs with depth buckets, plus total trench safety LF. In the line items table, show depth_avg/depth_max columns for all gravity lines. If profile data was missing or illegible for a run, show "DEPTH UNAVAILABLE — verify from profiles" rather than guessing.
```

---

### PROMPT 5 — Vector text-layer hybrid

```
Add embedded-text extraction to the pipeline so we stop relying on vision for text the PDF already contains.

Server-side, for each analyzed sheet, extract the PDF text layer with coordinates (pdf.js getTextContent in the Node function, or pdfplumber if we add a Python worker — choose based on our current backend and document why). Store the text runs with their positions.

Integration: when building each tile's analysis request, attach the text-layer content that falls within that tile's coordinates as supplementary structured text alongside the image: "Embedded text found in this region: [list]". Instruct the model to treat embedded text as ground truth for numbers, diameters, and material callouts, and to use the image for geometry, symbols, and anything not in the text layer.

Table parsing: detect schedule-like text clusters (structure schedules, quantity tables) by alignment patterns, reconstruct them as tables, and feed them to Pass 5's sanity check directly as structured data instead of vision reads.

If a PDF has no text layer (scanned plans), mark the project "raster-only — vision mode" and surface that in the plan screening grade, since scanned sets should grade lower on extractability.
```

---

### PROMPT 6 — Materials visual library

```
Add a materials library so every line item renders with an image of the material.

Supabase table: materials (id, slug, name, category, image_path, spec_summary, aliases_json). Seed it with the core wet utility catalog: PVC SDR-35, PVC SDR-26, C900 PVC, ductile iron, RCP (by class), HDPE, precast manholes (4 ft and 5 ft), curb inlets, grate inlets, junction boxes, cleanouts, gate valves, tapping sleeves, fire hydrant assemblies, FDC, RPZ backflow assemblies, double check assemblies, grease interceptors, wyes, bends (11.25/22.5/45/90), tees, reducers, couplings, concrete collars, embedment/bedding material, trench safety boxes.

Image strategy: create a placeholder illustration system for now — a clean, consistent SVG icon set in the Takeoff Copilot visual identity (one per category, generated as part of this work), stored in /public/materials and referenced by image_path. Structure it so each placeholder can later be swapped for a real photo just by replacing the file. Do NOT pull images from supplier catalogs.

Matching: after the merge pass, a lightweight matching step (alias/regex first, claude-haiku-4-5 for ambiguous cases) maps each line item description to a material slug.

UI: line items table gets a thumbnail column; clicking opens a material card with the larger image, spec summary, and every line item on this job using that material. The Bid Risk PDF export includes thumbnails per line item.
```

---

### PROMPT 7 — Knowledge base + feedback loop

```
Move the Takeoff Brain's accumulated knowledge from one monolithic prompt into a database-driven system, and add the correction loop.

Tables:
- engineer_profiles (name, notes, plan_quality_history, specific_rules_json) — seed with Pape-Dawson, Turnkey Tract, Lindsey Engineering, Kirkman Engineering using the notes in server/prompts/takeoff-brain.md.
- processing_rules (id, rule_text, category, source_job, version_added, active) — seed by splitting every rule in the Brain (v1.0 through v1.2) into individual rows.
- city_specs (city, spec_notes, source_doc_path) — empty for now, with an upload path for city standard detail PDFs.
- corrections (id, project_id, line_item_id, original_value, corrected_value, correction_type [confirmed/adjusted/missed_item], note, created_at).

Prompt assembly: at analysis time, build the system prompt dynamically: core Brain role/scope + only the active processing_rules + the matching engineer_profile (detect the engineer from the title block during triage) + city_specs when the job is public + project_type_patterns. Log the assembled prompt per job for auditability.

Feedback loop: after a takeoff, the report gets a Review Mode — each line item can be marked Confirmed / Adjusted (with corrected value) / plus an "Add missed item" button. Every correction is stored. A "Brain Updates" admin page lists corrections grouped by pattern and drafts a candidate processing rule for each recurring pattern (use claude-opus-4-8 to draft), which I approve or reject into processing_rules.

Finally: add an accuracy dashboard — per-job accuracy (confirmed items / total), trending over time, segmented by engineer and plan grade.
```

---

## PART 4: SEQUENCING & EXPECTATIONS

**Weeks 1–2:** Prompts 1–3. This alone fixes your three loudest complaints (slow uploads, no page selection, dense-plan accuracy) and the security hole.

**Weeks 3–4:** Prompts 4–5. Depths make the product priceable; the text-layer hybrid is what pushes Grade B/C plans from "risky" to "usable."

**Weeks 5–6:** Prompts 6–7. Visual materials make demos land; the knowledge base + feedback loop is the compounding moat.

**Honest expectation:** Tiling + multi-pass + text-layer should move SurePoint-class plans from ~24% to 65–80%, and Grade A/B plans to consistent 95%+. True measured takeoffs (scale-aware polyline measurement, item 7) is the last 10% and the hardest — treat it as v3.

**Cost note:** Server-side multi-pass on Opus across 10 sheets x 4–9 tiles is real API spend per job — likely $3–8/job at Opus rates. Fine at $197/job. Use the model tiering in the prompts (Haiku for triage/formatting, Opus for extraction) and reserve Fable 5 for the hardest reconciliation passes if you find Opus missing things.
