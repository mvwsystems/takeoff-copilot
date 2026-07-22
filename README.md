# Takeoff Copilot // 6 SIGNAL

AI-powered plan analysis for wet-utility contractors. Upload construction plan sets, get a structured, depth-aware takeoff with an audit trail.

## Stack

- **React 18** + **Vite** — SPA frontend
- **Supabase** — Auth (email/password + Google/Microsoft/Apple OAuth), Postgres, Storage, Realtime
- **Netlify** — Edge functions (`/api/*` auth-verifying proxies) + background functions (heavy processing)
- **MuPDF (WASM)** — server-side rasterization + embedded text-layer extraction
- **Claude API** (Anthropic) — tiled multi-pass vision analysis via Message Batches

## Security model

**The Anthropic API key lives server-side only** (`ANTHROPIC_API_KEY` in Netlify env). The browser only ever holds the user's Supabase JWT; edge functions verify it before proxying. Background functions additionally require the `x-fn-secret` shared secret (`WEBHOOK_SECRET`) — they run with the service-role key and must never be publicly invokable. Per-user daily quotas are enforced in `analyze.js` (AI calls) and `start-analysis.js` (analysis runs) via the `usage_events` ledger.

## How an analysis runs

1. Client gets a signed URL (`/api/get-upload-url`) and PUTs the PDF straight to Supabase Storage.
2. `/api/confirm-upload` verifies ownership and fires `process-plan-background`: Haiku triage classifies every page, pages rasterize at 108 DPI, thumbnails land in Storage.
3. The user picks sheets on the sheet map → `/api/start-analysis` → `analyze-project-background` runs 5 passes over 1568px tiles (15% overlap) through Message Batches: plan quantities, profiles, merge+reconcile, small-diameter sweep, engineer-table variance. The PDF text layer is attached per-tile as ground truth. Depth engine derives LF-by-depth buckets, OSHA trench-safety LF, and geotech flags.
4. Results land in `line_items` + `analysis_results`; progress streams over Realtime with a polling fallback. Unresolved items surface as clarification questions the estimator answers in-app.

## Environment variables (Netlify → Site settings)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | All Claude calls (server-side only) |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase project + public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Background functions + usage ledger (secret) |
| `WEBHOOK_SECRET` | Shared secret: Supabase webhook → notify-signup, and edge → background function auth |
| `RESEND_API_KEY` | Signup notification emails |
| `QUOTA_AI_CALLS_PER_DAY` (opt) | Per-user daily single-call/chat cap (default 300) |
| `QUOTA_ANALYSES_PER_DAY` (opt) | Per-user daily pipeline-run cap (default 10) |

## Local development

```bash
npm install
npm run dev        # UI only — upload/analysis needs the deployed backend
npm run build
```

The database schema is fully reproducible from `supabase/migrations/` (001–004). Apply them in order to a fresh Supabase project, create the private `plan-uploads` bucket per migration 001, enable Realtime on `processing_jobs`, and configure OAuth providers + the signup webhook (with `x-webhook-secret`) in the Supabase dashboard.

## Project structure

```
netlify/edge-functions/   # /api/* — JWT-verified proxies (analyze, uploads, start-analysis, delete-project)
netlify/functions/        # background workers (triage, multi-pass analysis), notify-signup, parse-takeoff
server/prompts/           # takeoff-brain.md — the analysis system prompt (edit + redeploy, no code changes)
src/pages/                # Landing, Login, Reset, Dashboard, Admin
src/components/           # Navbar, OnboardingFlow, ReferenceBank, RiskPill
src/utils/                # prompts, exporters (CSV/XLSX/print), parseTakeoff, supabase, AuthContext
supabase/migrations/      # 001 core, 002 schema sync, 003 hardening, 004 locks+quotas
```

## Design system

**6 SIGNAL** — construction-tech aesthetic. Black `#0A0A0A`, off-white `#F5F5F0`, accent blue `#0057FF`. Bebas Neue (display), Outfit (body), JetBrains Mono (data). "//" separators. Red is reserved for semantic status only (warnings, misses, Grade C).

> Note: CSS tokens/classes are still named `--titan-*` / `.titan-*` for historical reasons — `--titan-red` now holds the blue `#0057FF`. Functional, just legacy naming.
