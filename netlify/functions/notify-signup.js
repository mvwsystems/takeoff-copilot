// Receives a Supabase database webhook on new profiles INSERT
// and sends a signup notification email via Resend.
// Required env vars (set in Netlify dashboard):
//   RESEND_API_KEY  — from resend.com
//   WEBHOOK_SECRET  — any random string, must match what you put in Supabase webhook headers

const crypto = require('crypto')

// Constant-time secret comparison — a plain !== leaks timing information.
function secretMatches(provided, expected) {
  if (!provided || !expected) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Profile fields are user-supplied — escape before interpolating into HTML.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  // Verify the request is from our Supabase webhook
  if (!secretMatches(event.headers['x-webhook-secret'], process.env.WEBHOOK_SECRET)) {
    return { statusCode: 401, body: 'Unauthorized' }
  }

  let record
  try {
    const payload = JSON.parse(event.body)
    record = payload.record
    if (!record) throw new Error('No record in payload')
  } catch (e) {
    return { statusCode: 400, body: `Bad payload: ${e.message}` }
  }

  const signupTime = record.created_at
    ? new Date(record.created_at).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      })
    : 'Unknown'

  const subject = [
    'New beta signup:',
    record.full_name || record.email || 'Unknown',
    record.company ? `— ${record.company}` : ''
  ].filter(Boolean).join(' ')

  // Brand accent is blue (#0057FF). Backgrounds use the bgcolor ATTRIBUTE on
  // table cells — Gmail strips CSS `background` and white-on-white would vanish.
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
        <tr>
          <td bgcolor="#0A0A0A" style="background-color:#0A0A0A;padding:20px 24px;border-radius:4px 4px 0 0">
            <span style="color:#ffffff;font-size:17px;font-weight:800;letter-spacing:1.5px">TAKEOFF COPILOT</span><span style="color:#4d8bff;font-size:17px;font-weight:800;margin:0 6px">//</span><span style="color:#9aa4bb;font-size:11px;letter-spacing:1px">NEW BETA SIGNUP</span>
          </td>
        </tr>
        <tr><td bgcolor="#0057FF" height="3" style="background-color:#0057FF;height:3px;line-height:3px;font-size:0">&nbsp;</td></tr>
      </table>
      <div style="background:#f9f9f7;padding:24px;border:1px solid #e0e0da;border-top:none;border-radius:0 0 4px 4px">
        <p style="margin:0 0 20px;font-size:0.95rem;color:#444">
          A new contractor just signed up for the beta.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
          <tr>
            <td style="padding:8px 12px;color:#888;width:100px;border-bottom:1px solid #e8e8e3">Name</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3;font-weight:600">${esc(record.full_name) || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Company</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3;font-weight:600">${esc(record.company) || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Email</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3">
              <a href="mailto:${esc(record.email)}" style="color:#0057FF">${esc(record.email)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Phone</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3">${esc(record.phone) || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888">Signed up</td>
            <td style="padding:8px 12px;color:#666">${signupTime}</td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px">
          <tr>
            <td bgcolor="#0057FF" style="background-color:#0057FF;border-radius:3px">
              <a href="https://takeoffcopilot.com/admin"
                 style="display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase">
                View Admin Dashboard &rarr;
              </a>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        // Send from the verified takeoffcopilot.com domain (NOT the resend.dev
        // sandbox, which only delivers to the account owner). Sending works as
        // soon as the domain is verified — no mailbox required.
        from: 'Takeoff Copilot <hello@takeoffcopilot.com>',
        reply_to: 'hello@6signal.co',
        // Signup alerts go to both addresses so one is never missed.
        to: ['hello@6signal.co', 'mvw@mattvincentwalker.com'],
        subject,
        html
      })
    })

    const data = await res.json()

    if (!res.ok) {
      console.error('Resend error:', data)
      return { statusCode: 500, body: JSON.stringify(data) }
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true, id: data.id }) }
  } catch (err) {
    console.error('Notify function error:', err)
    return { statusCode: 500, body: err.message }
  }
}
