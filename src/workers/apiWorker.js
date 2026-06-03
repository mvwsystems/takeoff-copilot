// Runs in a Web Worker thread — not subject to background-tab throttling.
// Calls the /api/analyze proxy (Netlify Edge Function) instead of Anthropic directly,
// so the server-side API key is never exposed to the browser.
//
// Analyze mode: { id, file_id, prompt, accessToken, maxTokens }
//   → returns parsed JSON result
//
// Image mode:   { id, fileBlock, prompt, accessToken, maxTokens }
//   → returns parsed JSON result (base64 image fallback)
//
// Chat mode:    { id, systemPrompt, messages, accessToken, maxTokens }
//   → returns raw text response

self.onmessage = async ({ data }) => {
  const { id, accessToken, maxTokens } = data
  const isChatMode = Array.isArray(data.messages)

  try {
    const payload = isChatMode
      ? { systemPrompt: data.systemPrompt, messages: data.messages, maxTokens }
      : { file_id: data.file_id, specs_file_id: data.specs_file_id, fileBlock: data.fileBlock, prompt: data.prompt, maxTokens }

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`API ${response.status}: ${errBody.substring(0, 200)}`)
    }

    const responseData = await response.json()
    if (responseData.error) throw new Error(responseData.error.message || JSON.stringify(responseData.error))

    const text = responseData.content.map(b => (b.type === 'text' ? b.text : '')).join('')

    if (isChatMode) {
      self.postMessage({ id, success: true, result: text })
    } else {
      let parsed
      try {
        parsed = JSON.parse(text.replace(/```json\s?|```/g, '').trim())
      } catch {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) parsed = JSON.parse(m[0])
        else throw new Error('Could not parse response as JSON')
      }
      self.postMessage({ id, success: true, result: parsed })
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message })
  }
}
