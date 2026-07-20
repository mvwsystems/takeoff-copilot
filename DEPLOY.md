# Deploy & Go-Live Checklist

Deploys are automatic: **push to `main` → Netlify builds and publishes** to
takeoffcopilot.com. Everything below is one-time configuration in the Netlify,
Supabase, and Stripe dashboards. Nothing here is done from code.

Status legend: ✅ already in place · ⚙️ you must set it · 🔵 optional.

---

## 1. Netlify environment variables
`Netlify → Site settings → Environment variables`

| Var | Status | Purpose |
|-----|--------|---------|
| `ANTHROPIC_API_KEY` | ✅ | All Claude calls (server-side only) |
| `VITE_SUPABASE_URL` | ✅ | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | ✅ | Supabase public key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Background functions + billing RPCs (secret) |
| `WEBHOOK_SECRET` | ✅ | **Critical.** Signup webhook auth AND edge→background function auth. If this is ever unset, all analysis 401s. It's already `tc-beta-2026-secret`. |
| `RESEND_API_KEY` | ✅ | Signup notification emails |
| `QUOTA_AI_CALLS_PER_DAY` | 🔵 | Per-user daily single-call/chat cap (default 300) |
| `QUOTA_ANALYSES_PER_DAY` | 🔵 | Per-user daily pipeline-run cap (default 10) |
| `STRIPE_SECRET_KEY` | ⚙️ | **Turns billing ON.** Until set, everything runs free. |
| `STRIPE_WEBHOOK_SECRET` | ⚙️ | Verifies Stripe webhook calls (see §4) |
| `STRIPE_PRICE_ID` | 🔵 | Use a Stripe Price instead of the inline $97 |
| `TAKEOFF_PRICE_CENTS` | 🔵 | Override the price in cents (default 9700 = $97) |
| `VITE_BILLING_ENABLED` | ⚙️ | Set to `true` when Stripe is live so the onboarding shows the "$97 per plan set" line. Leave unset while free. Build-time flag (redeploy after changing). |

---

## 2. Supabase — Auth
`Supabase → Authentication`

- ⚙️ **Providers → Google**: add Client ID + secret (Google Cloud OAuth consent + credentials). Authorized redirect: `https://<project-ref>.supabase.co/auth/v1/callback`.
- ⚙️ **Providers → Microsoft (Azure)**: same. (Apple is wired in code but needs a paid Apple Developer account — safe to leave off; the button just won't work until configured. Consider hiding it.)
- ⚙️ **Policies → enable Leaked Password Protection** (flagged by the security advisor).
- ✅ Email/password + password reset already work in-app (`/reset`).
- ⚙️ Confirm **Site URL** and **Redirect URLs** include `https://takeoffcopilot.com` (OAuth/reset redirects use the current origin).

## 3. Supabase — schema & webhook
- ✅ Migrations `001`–`007` are all applied to the live DB (schema is reproducible from `supabase/migrations/`).
- ✅ Storage bucket `plan-uploads` (private) + RLS in place.
- ✅ Realtime enabled on `processing_jobs`.
- ✅ Signup webhook (`Database → Webhooks`) posts to `/.netlify/functions/notify-signup` with the `x-webhook-secret` header = `WEBHOOK_SECRET`.

## 4. Stripe (to turn on the $97 paywall)
Billing is dormant until `STRIPE_SECRET_KEY` exists. To go live:

1. ⚙️ Create the account / get the **secret key** → set `STRIPE_SECRET_KEY` in Netlify.
2. ⚙️ (Optional) Create a **Product + Price** at $97 → set `STRIPE_PRICE_ID`. Otherwise the code creates the $97 line inline.
3. ⚙️ **Developers → Webhooks → Add endpoint**:
   - URL: `https://takeoffcopilot.com/.netlify/functions/stripe-webhook`
   - Event: `checkout.session.completed`
   - Copy the endpoint's **Signing secret** → set `STRIPE_WEBHOOK_SECRET` in Netlify.
4. Test with a real card (or Stripe test mode keys first). On success the buyer's credit appears within a few seconds; starting a new plan set's analysis consumes it. Re-runs of the same plan set are free.

**How the money model works:** free account + free upload/triage/sheet-map + free history. $97 is charged once, atomically, the first time a *project* (plan set) runs the multi-pass analysis. Admin emails and calibration runs never charge. If a run fails to launch, the credit auto-refunds.

## 5. Post-deploy smoke test
1. Sign up with a fresh email → confirm the profile row + signup email fire.
2. Upload a PDF → triage classifies sheets → sheet map appears.
3. Run analysis → (with Stripe on) paywall → pay → analysis runs → takeoff, depths, clarifications, measured-geometry section.
4. Edit a line item, answer a clarification → check the row appears in the Admin → House Accuracy → corrections feed.
5. Enter unit costs in the Bid Estimate → export Priced Excel.
6. Admin page (`/admin`) loads House Accuracy + Calibration.

## 6. Known follow-ups (not blockers)
- Fake landing-page stats ("JOB-DFW-2461", "13/17 matched") should be swapped for real numbers from House Accuracy once the sample is large enough.
- Data retention: uploaded PDFs, page images, and Anthropic file_ids currently persist indefinitely; add a retention/cleanup policy and a privacy page before broad launch.
- ToS + privacy policy (plans are confidential; they transit Anthropic's API — disclose it).
- Apple OAuth button: hide or configure.
