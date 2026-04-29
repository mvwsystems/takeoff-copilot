// Receives a Supabase database webhook on new profiles INSERT
// and sends a signup notification email via Resend.
// Required env vars (set in Netlify dashboard):
//   RESEND_API_KEY  — from resend.com
//   WEBHOOK_SECRET  — any random string, must match what you put in Supabase webhook headers

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  // Verify the request is from our Supabase webhook
  const secret = event.headers['x-webhook-secret']
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
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

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <div style="background:#E8372C;padding:20px 24px;border-radius:4px 4px 0 0">
        <span style="color:#fff;font-size:1.1rem;font-weight:700;letter-spacing:1px">TAKEOFF COPILOT</span>
        <span style="color:rgba(255,255,255,0.6);font-size:0.75rem;margin-left:12px">New Beta Signup</span>
      </div>
      <div style="background:#f9f9f7;padding:24px;border:1px solid #e0e0da;border-top:none;border-radius:0 0 4px 4px">
        <p style="margin:0 0 20px;font-size:0.95rem;color:#444">
          A new contractor just signed up for the beta.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
          <tr>
            <td style="padding:8px 12px;color:#888;width:100px;border-bottom:1px solid #e8e8e3">Name</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3;font-weight:600">${record.full_name || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Company</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3;font-weight:600">${record.company || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Email</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3">
              <a href="mailto:${record.email}" style="color:#E8372C">${record.email}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888;border-bottom:1px solid #e8e8e3">Phone</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8e8e3">${record.phone || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#888">Signed up</td>
            <td style="padding:8px 12px;color:#666">${signupTime}</td>
          </tr>
        </table>
        <div style="margin-top:24px">
          <a href="https://takeoffcopilot.com/admin"
             style="background:#E8372C;color:#fff;padding:10px 20px;border-radius:3px;text-decoration:none;font-size:0.82rem;font-weight:600;letter-spacing:0.5px;text-transform:uppercase">
            View Admin Dashboard →
          </a>
        </div>
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
        from: 'Takeoff Copilot <onboarding@resend.dev>',
        to: ['mvw@mattvincentwalker.com'],
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
