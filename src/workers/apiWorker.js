// Runs in a Web Worker thread — not subject to background-tab throttling.
// Receives: { id, fileBlock, prompt, apiKey, maxTokens }
// Posts back: { id, success, result } | { id, success: false, error }

self.onmessage = async ({ data }) => {
  const { id, fileBlock, prompt, apiKey, maxTokens } = data
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, fileBlock] }],
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`API ${response.status}: ${errBody.substring(0, 200)}`)
    }

    const data = await response.json()
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))

    const text = data.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    let parsed
    try {
      parsed = JSON.parse(text.replace(/```json\s?|```/g, '').trim())
    } catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (m) parsed = JSON.parse(m[0])
      else throw new Error('Could not parse response as JSON')
    }

    self.postMessage({ id, success: true, result: parsed })
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message })
  }
}
