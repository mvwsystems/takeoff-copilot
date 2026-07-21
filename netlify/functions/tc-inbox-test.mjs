// TEMPORARY — delete after use. Sends a branded inbox-check email via Resend.
// Guarded by the fn secret.
const html = '<html><body style="margin:0;padding:0;background:#e7ebf2;">'
  + '<table role="presentation" align="center" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dde3ee;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;margin:24px auto;">'
  + '<tr><td bgcolor="#0a0a0a" style="background-color:#0a0a0a;padding:22px 30px;"><span style="color:#ffffff;font-size:19px;font-weight:800;letter-spacing:2px;">TAKEOFF COPILOT</span><span style="color:#4d8bff;font-size:19px;font-weight:800;margin:0 7px;">//</span><span style="color:#9aa4bb;font-size:11px;font-weight:700;letter-spacing:2px;">6 SIGNAL</span></td></tr>'
  + '<tr><td bgcolor="#0057ff" height="4" style="background-color:#0057ff;height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>'
  + '<tr><td style="padding:32px 34px;">'
  + '<p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0057ff;">Inbox check</p>'
  + '<h1 style="margin:0 0 18px;font-size:23px;line-height:1.3;color:#12161d;font-weight:800;">hello@takeoffcopilot.com is live</h1>'
  + '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a4250;">If you’re reading this, your new inbox receives mail and the dark header + blue accent are rendering correctly in your client.</p>'
  + '<p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#3a4250;">This is also the verified address Takeoff Copilot now sends from — signup alerts and any future transactional email go out through it.</p>'
  + '<p style="margin:0;font-size:15px;line-height:1.5;color:#3a4250;"><strong style="color:#12161d;">Takeoff Copilot</strong><br><span style="color:#8a93a6;font-size:13px;">6 Signal &middot; takeoffcopilot.com</span></p>'
  + '</td></tr>'
  + '<tr><td bgcolor="#f5f7fb" style="background-color:#f5f7fb;border-top:1px solid #e6eaf1;padding:18px 34px;"><p style="margin:0;font-size:11px;line-height:1.6;color:#95a0b3;">Automated inbox check &middot; Takeoff Copilot by 6&nbsp;Signal</p></td></tr>'
  + '</table></body></html>'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 }
  if (event.headers['x-fn-secret'] !== process.env.WEBHOOK_SECRET) return { statusCode: 401 }
  const to = (JSON.parse(event.body || '{}').to) || 'hello@takeoffcopilot.com'
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Takeoff Copilot <hello@takeoffcopilot.com>',
      reply_to: 'hello@6signal.co',
      to: [to],
      subject: 'Inbox check — hello@takeoffcopilot.com is live',
      html,
    }),
  })
  return { statusCode: 200, body: JSON.stringify({ to, status: res.status, body: (await res.text()).slice(0, 300) }) }
}
