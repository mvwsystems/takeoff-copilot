// TEMPORARY — delete after use. Sends the branded invite emails to the operator's
// inbox (via Resend) so they can forward them. Guarded by the fn secret.
const SHELL_OPEN = '<html><body style="margin:0;padding:0;background:#e7ebf2;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dde3ee;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;margin:24px auto;"><tr><td style="background:#0a0a0a;padding:22px 30px;"><span style="color:#ffffff;font-size:19px;font-weight:800;letter-spacing:2px;">TAKEOFF COPILOT</span><span style="color:#1a6bff;font-size:19px;font-weight:800;margin:0 7px;">//</span><span style="color:#7f8aa3;font-size:11px;font-weight:700;letter-spacing:2px;">6 SIGNAL</span></td></tr><tr><td style="height:3px;line-height:3px;font-size:0;background:#0057ff;">&nbsp;</td></tr><tr><td style="padding:32px 34px 10px;">'
const SHELL_CLOSE = '</td></tr><tr><td style="background:#f5f7fb;border-top:1px solid #e6eaf1;padding:18px 34px;"><p style="margin:0;font-size:11px;line-height:1.6;color:#95a0b3;">Takeoff Copilot by 6&nbsp;Signal &middot; AI plan takeoffs for wet-utility contractors<br>You&rsquo;re receiving this because you asked to try the beta.</p></td></tr></table></body></html>'

const CTA = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr><td style="background:#0057ff;border-radius:7px;"><a href="https://takeoffcopilot.com" style="display:inline-block;padding:14px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.3px;">Start a takeoff &rarr;</a></td></tr></table>'
const row = (t) => `<tr><td valign="top" style="width:26px;padding:5px 0;color:#0057ff;font-size:15px;font-weight:700;">&rarr;</td><td style="padding:5px 0;font-size:14px;line-height:1.55;color:#3a4250;">${t}</td></tr>`

const trevorHtml = SHELL_OPEN +
  '<p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0057ff;">Beta invite // your feedback shaped this</p>' +
  '<h1 style="margin:0 0 20px;font-size:23px;line-height:1.3;color:#12161d;font-weight:800;">Take the new Takeoff Copilot for a spin</h1>' +
  '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a4250;">Hey Trevor,</p>' +
  '<p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#3a4250;">Thanks again for the feedback on depths a while back &mdash; it shaped a real rebuild. It&rsquo;s a lot stronger now, and I&rsquo;d love for you to run a plan set through it fresh. A few of the things that changed:</p>' +
  '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 26px;">' +
  row('<strong style="color:#12161d;">Depths off the grading plan.</strong> When the rim isn&rsquo;t called out on the profile, it now pulls the finished grade automatically &mdash; the exact move you described. When it still can&rsquo;t pin one down, it flags the manhole and asks you.') +
  row('<strong style="color:#12161d;">It asks you</strong> on anything it can&rsquo;t 100% verify &mdash; and your answers tighten the takeoff.') +
  row('<strong style="color:#12161d;">Click any line item</strong> to see exactly where on the sheet it was read.') +
  row('<strong style="color:#12161d;">Depth buckets, trench-safety footage, engineer-table comparison, priced estimates, and a supplier RFQ</strong> &mdash; all built in.') +
  '</table>' + CTA +
  '<p style="margin:0 0 4px;font-size:13px;line-height:1.6;color:#66707f;">I wiped the old test accounts so you&rsquo;d get the full experience from the beginning &mdash; just sign up fresh with your email at <a href="https://takeoffcopilot.com" style="color:#0057ff;text-decoration:none;font-weight:600;">takeoffcopilot.com</a>.</p>' +
  '<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #eceff4;font-size:13px;line-height:1.6;color:#66707f;"><strong style="color:#12161d;">Best fit:</strong> single-level pad sites &amp; site-civil plans &mdash; storm, sanitary, water. Right in your wheelhouse (not built for multi-level building risers). It grades every plan A/B/C before you commit.</p>' +
  '<p style="margin:26px 0 6px;font-size:15px;line-height:1.6;color:#3a4250;">Appreciate you &mdash; let me know what you think, good or bad.</p>' +
  '<p style="margin:0;font-size:15px;line-height:1.5;color:#3a4250;"><strong style="color:#12161d;">Matt Walker</strong><br><span style="color:#8a93a6;font-size:13px;">6 Signal &middot; takeoffcopilot.com</span></p>' +
  SHELL_CLOSE

const johnHtml = SHELL_OPEN +
  '<p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0057ff;">Beta invite</p>' +
  '<h1 style="margin:0 0 20px;font-size:23px;line-height:1.3;color:#12161d;font-weight:800;">Take the new Takeoff Copilot for a spin</h1>' +
  '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a4250;">Hey John,</p>' +
  '<p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#3a4250;">Takeoff Copilot has come a long way and I&rsquo;d love for you to put a plan set through it. It turns utility plan sheets into a structured wet-utility takeoff &mdash; quantities, depths, trench-safety footage, engineer-table comparison, priced estimates, and a supplier RFQ. A few highlights:</p>' +
  '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 26px;">' +
  row('<strong style="color:#12161d;">Depths from the profile</strong> &mdash; and when the rim isn&rsquo;t there, off the grading plan automatically. When it can&rsquo;t verify something, it asks you instead of guessing.') +
  row('<strong style="color:#12161d;">Click any line item</strong> to see exactly where on the sheet it came from.') +
  row('<strong style="color:#12161d;">Priced estimates and a supplier RFQ</strong> built right in.') +
  '</table>' + CTA +
  '<p style="margin:0 0 4px;font-size:13px;line-height:1.6;color:#66707f;">I cleared the old test accounts so you&rsquo;d get the full experience from signup &mdash; just sign up fresh with your email at <a href="https://takeoffcopilot.com" style="color:#0057ff;text-decoration:none;font-weight:600;">takeoffcopilot.com</a>.</p>' +
  '<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #eceff4;font-size:13px;line-height:1.6;color:#66707f;"><strong style="color:#12161d;">Best fit:</strong> single-level pad sites &amp; site-civil plans &mdash; storm, sanitary, water. Not built for multi-level building risers. It grades every plan A/B/C before you commit.</p>' +
  '<p style="margin:26px 0 6px;font-size:15px;line-height:1.6;color:#3a4250;">Would really value your feedback &mdash; anything that feels off, tell me.</p>' +
  '<p style="margin:0;font-size:15px;line-height:1.5;color:#3a4250;"><strong style="color:#12161d;">Matt Walker</strong><br><span style="color:#8a93a6;font-size:13px;">6 Signal &middot; takeoffcopilot.com</span></p>' +
  SHELL_CLOSE

async function sendOne(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'Takeoff Copilot <onboarding@resend.dev>', to: [to], subject, html }),
  })
  return { status: res.status, body: (await res.text()).slice(0, 300) }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }
  if (event.headers['x-fn-secret'] !== process.env.WEBHOOK_SECRET) return { statusCode: 401 }
  const to = (JSON.parse(event.body || '{}').to) || 'mvw@mattvincentwalker.com'
  const a = await sendOne(to, 'FORWARD TO TREVOR — Take the new Takeoff Copilot for a spin', trevorHtml)
  const b = await sendOne(to, 'FORWARD TO JOHN — Take the new Takeoff Copilot for a spin', johnHtml)
  return { statusCode: 200, body: JSON.stringify({ to, trevor: a, john: b }) }
}
