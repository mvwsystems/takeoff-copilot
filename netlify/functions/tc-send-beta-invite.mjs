// TEMPORARY — delete after use. Sends the personalized free-beta invitation to
// the named testers via Resend (from the verified takeoffcopilot.com domain).
// Guarded by the fn secret.
const A = '#0057ff'
const row = (t) => `<tr><td valign="top" style="width:26px;padding:5px 0;color:${A};font-size:15px;font-weight:700;">&rarr;</td><td style="padding:5px 0;font-size:14px;line-height:1.55;color:#3a4250;">${t}</td></tr>`

const buildHtml = (firstName) => '<html><body style="margin:0;padding:0;background:#e7ebf2;">'
  + '<table role="presentation" align="center" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dde3ee;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;margin:24px auto;">'
  + '<tr><td bgcolor="#0a0a0a" style="background-color:#0a0a0a;padding:22px 30px;"><span style="color:#ffffff;font-size:19px;font-weight:800;letter-spacing:2px;">TAKEOFF COPILOT</span><span style="color:#4d8bff;font-size:19px;font-weight:800;margin:0 7px;">//</span><span style="color:#9aa4bb;font-size:11px;font-weight:700;letter-spacing:2px;">6 SIGNAL</span></td></tr>'
  + `<tr><td bgcolor="${A}" height="4" style="background-color:${A};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>`
  + '<tr><td style="padding:32px 34px 10px;">'
  + `<p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${A};">Free beta invitation</p>`
  + '<h1 style="margin:0 0 20px;font-size:23px;line-height:1.3;color:#12161d;font-weight:800;">You’re invited to test Takeoff Copilot — on the house</h1>'
  + `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a4250;">Hey ${firstName},</p>`
  + '<p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#3a4250;">I built a tool that turns utility plan sheets into a structured wet-utility takeoff — quantities, depths, trench-safety footage, engineer quantity-table comparison, priced estimates, and a supplier RFQ. I’d love your eyes on it before it goes wide.</p>'
  + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 26px;">'
  + row('<strong style="color:#12161d;">Depths, handled properly.</strong> It reads rim/invert off the profile and, when the rim isn’t called out, pulls the finished grade off the grading plan automatically.')
  + row('<strong style="color:#12161d;">It asks instead of guessing.</strong> Anything it can’t verify, it flags and asks you — so you know exactly what to check in the field.')
  + row('<strong style="color:#12161d;">Click any line item</strong> to see exactly where on the sheet it was read.')
  + row('<strong style="color:#12161d;">Priced estimates and a supplier RFQ</strong> built right in.')
  + '</table>'
  + `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 10px;"><tr><td bgcolor="${A}" style="background-color:${A};border-radius:7px;border:1px solid ${A};"><a href="https://takeoffcopilot.com" style="display:inline-block;padding:14px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.3px;">Create your free account &rarr;</a></td></tr></table>`
  + `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0 0;"><tr><td bgcolor="#eef3ff" style="background-color:#eef3ff;border-left:4px solid ${A};padding:14px 16px;border-radius:0 4px 4px 0;"><p style="margin:0;font-size:13.5px;line-height:1.6;color:#26324a;"><strong style="color:#12161d;">You’re comped during the beta.</strong> No card, no limits, nothing to pay. You’ll see subscription plans on the site — ignore them; they don’t apply to you.</p></td></tr></table>`
  + '<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid #eceff4;font-size:13px;line-height:1.6;color:#66707f;"><strong style="color:#12161d;">Best fit:</strong> single-level pad sites &amp; site-civil plans — storm, sanitary, water. Not built for multi-level building risers. It grades every plan A/B/C up front so you know what you’re getting.</p>'
  + '<p style="margin:24px 0 6px;font-size:15px;line-height:1.6;color:#3a4250;">All I want back is the honest read — what it nailed, what it missed, what would make it useful on a real bid.</p>'
  + '<p style="margin:0;font-size:15px;line-height:1.5;color:#3a4250;"><strong style="color:#12161d;">Matt Walker</strong><br><span style="color:#8a93a6;font-size:13px;">6 Signal &middot; takeoffcopilot.com</span></p>'
  + '</td></tr>'
  + '<tr><td bgcolor="#f5f7fb" style="background-color:#f5f7fb;border-top:1px solid #e6eaf1;padding:18px 34px;"><p style="margin:0;font-size:11px;line-height:1.6;color:#95a0b3;">Takeoff Copilot by 6&nbsp;Signal &middot; AI plan takeoffs for wet-utility contractors</p></td></tr>'
  + '</table></body></html>'

const RECIPIENTS = [
  { name: 'Gary',   email: 'gary@rumseyllc.com' },
  { name: 'Layton', email: 'layton@firelineservices.com' },
  { name: 'Oscar',  email: 'oem@oemcontracting.com' },
]

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }
  if (event.headers['x-fn-secret'] !== process.env.WEBHOOK_SECRET) return { statusCode: 401 }
  const results = []
  for (const r of RECIPIENTS) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Matt Walker <hello@takeoffcopilot.com>',
        reply_to: 'hello@6signal.co',
        to: [r.email],
        bcc: ['hello@6signal.co'],           // your own copy for the record
        subject: 'You’re invited: free beta access to Takeoff Copilot',
        html: buildHtml(r.name),
      }),
    })
    results.push({ to: r.email, name: r.name, status: res.status, body: (await res.text()).slice(0, 200) })
  }
  return { statusCode: 200, body: JSON.stringify(results, null, 1) }
}
