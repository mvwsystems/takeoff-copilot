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
| `STRIPE_PRICE_SOLO` | ⚙️ | Stripe **recurring** Price ID for Solo ($197/mo). Required for the Solo plan. |
| `STRIPE_PRICE_GROWTH` | ⚙️ | Stripe recurring Price ID for Growth ($497/mo). Required for the Growth plan. |
| `STRIPE_PRICE_SOLO_ANNUAL` | 🔵 | Annual Solo Price ID (optional; enables the annual toggle). |
| `STRIPE_PRICE_GROWTH_ANNUAL` | 🔵 | Annual Growth Price ID (optional). |
| `STRIPE_PRICE_SINGLE` | 🔵 | Price ID for a single/overage takeoff; else an inline $25 one-off is used. |
| `SINGLE_TAKEOFF_CENTS` | 🔵 | Override the single-takeoff price in cents (default 2500 = $25). |
| `MAX_SHEETS_PER_TAKEOFF` | 🔵 | Per-takeoff fair-use analyzed-sheet cap (default 60). |
| `VITE_BILLING_ENABLED` | ⚙️ | Set to `true` when Stripe is live so the app shows plans/usage + onboarding pricing. Leave unset while free. Build-time flag (redeploy after changing). |

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

## 4. Stripe (to turn on subscription billing)
Billing is dormant until `STRIPE_SECRET_KEY` exists. To go live:

1. ⚙️ Get the **secret key** → set `STRIPE_SECRET_KEY` in Netlify.
2. ⚙️ Create two **recurring Products/Prices**: Solo ($197/mo) and Growth ($497/mo). Copy the **Price IDs** → `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_GROWTH`. (Optional: annual prices → the `_ANNUAL` vars; a single-takeoff price → `STRIPE_PRICE_SINGLE`, else a $25 one-off is created inline.)
3. ⚙️ **Developers → Webhooks → Add endpoint**:
   - URL: `https://takeoffcopilot.com/.netlify/functions/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`.
4. ⚙️ Set `VITE_BILLING_ENABLED=true` and redeploy (shows plans/usage in-app).
5. Test with Stripe test-mode keys first: subscribe → the plan + monthly quota activate within seconds; running a new plan set decrements the quota.

**How the money model works:** free account + free upload/triage/sheet-map. Metered in **takeoffs (plan sets), not sheets** — charged once per project (re-runs/edits/exports free). Coverage order per takeoff: **active-subscription monthly quota → pay-as-you-go credit (overage/$25) → 2 lifetime free-trial takeoffs → blocked** (opens the plans modal). Tiers: Solo $197/mo·20, Growth $497/mo·100, Enterprise custom. A **per-takeoff fair-use cap** (default 60 analyzed sheets) bounds COGS on giant sets. Admin emails and calibration runs never charge. If a run fails to launch, the charge auto-refunds. Quota resets each Stripe billing cycle automatically.

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
