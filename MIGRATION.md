# Backend Migration — Takeoff Copilot

## What Changed

| Before | After |
|--------|-------|
| PDF uploaded to Anthropic Files API from browser | PDF uploaded directly to Supabase Storage from browser |
| Client-side pdf.js rasterization (removed) | Server-side rasterization via `pdf-to-img` (MuPDF WASM) |
| Anthropic API key held in `localStorage` | Anthropic API key in Netlify env var only |
| Flat `jobs` table (history blobs) | Normalized: `projects`, `sheets`, `line_items`, `processing_jobs` |
| No progress tracking | Live progress via Supabase Realtime |
| Plan View broken for PDFs | Thumbnails generated server-side, served from Supabase Storage |

---

## New Data Flow

```
Browser                    Netlify Edge         Supabase DB / Storage       Netlify BG Function
──────                     ────────────         ─────────────────────       ───────────────────
1. POST /api/get-upload-url ──────────────────► creates project + sheet
                           ◄── signed PUT URL    + processing_job (pending)

2. PUT <signed URL> ───────────────────────────────────────────────────────► Supabase Storage
   (direct, no server hop)

3. POST /api/confirm-upload ─────────────────── job.stage = 'uploaded' ───► fires process-plan-background

4.                                              [Realtime updates flow]     download PDF
                                                job.stage = 'processing'   → Anthropic Files API → file_id
                                                job.progress 15–100%       → rasterize pages → Storage
                                                sheets.file_id = <id>      → thumbnails in plan-uploads/

5. Dashboard subscribes to processing_jobs via Supabase Realtime
   On stage='ready': fetch sheet.storage_path → get signed URL → show thumbnail
                      fetch sheet.file_id     → unlock "Analyze Sheet" button

6. User clicks Analyze Sheet
   → POST /api/analyze with { file_id } (same as before)
```

---

## New Environment Variables

Add these in **Netlify → Site Settings → Environment Variables**:

| Variable | Where | Notes |
|----------|-------|-------|
| `ANTHROPIC_API_KEY` | Already set | Used in `analyze.js` + background function |
| `VITE_SUPABASE_URL` | Already set | e.g. `https://xxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Already set | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **NEW — required** | In Supabase dashboard → Project Settings → API → service_role key. Keep secret. |
| `URL` | Auto-set by Netlify | Your site URL — used to trigger the background function. No action needed. |

---

## Supabase Setup Required

### 1. Storage Bucket
In Supabase dashboard → **Storage → New bucket**:
- Name: `plan-uploads`
- Public: **No** (private)
- File size limit: `100 MB`

Then add these RLS policies under **Storage → plan-uploads → Policies**:

**INSERT (upload)**:
```sql
(bucket_id = 'plan-uploads' AND auth.role() = 'authenticated')
```

**SELECT (read)**:
```sql
(bucket_id = 'plan-uploads' AND auth.uid()::text = (storage.foldername(name))[1])
```

**ALL (service role — for background function)**:
```sql
(auth.role() = 'service_role')
```

### 2. Database Tables
The migration `001_backend_schema.sql` was applied automatically via the Supabase MCP tool. It created:
- `public.projects`
- `public.sheets`
- `public.line_items`
- `public.processing_jobs` (with Realtime enabled)

If you need to apply it manually, run the SQL in `supabase/migrations/001_backend_schema.sql` in the Supabase SQL editor.

### 3. Realtime
In Supabase dashboard → **Database → Replication**, confirm `processing_jobs` is listed under the `supabase_realtime` publication. (Applied by the migration, but verify it's visible.)

---

## New Functions

| File | Type | Purpose |
|------|------|---------|
| `netlify/edge-functions/get-upload-url.js` | Edge (Deno) | Creates DB records, returns signed Supabase Storage upload URL |
| `netlify/edge-functions/confirm-upload.js` | Edge (Deno) | Marks job as uploaded, fires background function |
| `netlify/functions/process-plan-background.js` | Background (Node.js, 15 min) | Downloads PDF, uploads to Anthropic Files API, rasterizes pages, saves thumbnails |

---

## Rasterizer Choice: MuPDF WASM

The background function rasterizes with the **`mupdf` npm package (WebAssembly)**, not `pdf-to-img`.

Why: `pdf-to-img` hard-depends on `canvas`, a natively-compiled module that frequently fails at runtime on Netlify's Lambda environment (missing system libraries). MuPDF compiled to WASM has **zero native dependencies** — it runs anywhere Node 18+ runs, including Lambda, with no build-environment coupling. Render quality and speed are excellent (MuPDF is the same engine commercial PDF tools use).

Pages render at scale 1.5 (~108 DPI) to keep large-format plan sheets (Arch D/E) within Lambda memory limits. Netlify background functions get 15 minutes and 1 GB — sufficient for typical plan sets. If users start uploading 200+ page sets and hitting limits, the fallback plan is a small Railway/Fly.io worker consuming the same `processing_jobs` table; the schema already supports it (nothing in the DB is Netlify-specific).

## npm Changes

`pdfjs-dist` removed (no longer needed — rasterization moved to server).
`mupdf` added to the **root** `package.json` — Netlify functions resolve dependencies from the project root; a function-level `package.json` is NOT auto-installed (caused a failed deploy on the first attempt).

`netlify.toml` sets `included_files = ["node_modules/mupdf/**"]` under `[functions]` so the `.wasm` binary ships with the function (the dynamic `import('mupdf')` inside the CommonJS handler isn't statically traceable).

Note: `mupdf` lives in root `dependencies` but is never imported by client code, so Vite excludes it from the browser bundle entirely.

---

## Existing `jobs` Table

The original `jobs` table (used for job history in the sidebar) is **unchanged**. It still stores `{ user_id, plan_filename, screening_grade, result_json, ... }` and the dashboard history panel continues to use it as before.

The new `processing_jobs` table is a separate pipeline-tracking table, not a replacement.

---

## Local Development

Supabase Realtime subscriptions require a live Supabase connection. The new upload flow (signed URLs + background functions) will not work with `netlify dev` without the `URL` env var pointing to a deployed site.

For local testing of the upload UI without the backend: the dashboard handles errors gracefully — a failed upload shows an error banner and the "Uploading..." state clears.
