// Runs in a Web Worker thread — not subject to background-tab throttling.
//
// Analyze mode: { id, fileBlock, prompt, apiKey, maxTokens }
//   → returns parsed JSON result
//
// Chat mode:   { id, systemPrompt, messages, apiKey, maxTokens }
//   → returns raw text response

self.onmessage = async ({ data }) => {
  const { id, apiKey, maxTokens } = data
  const isChatMode = Array.isArray(data.messages)

  try {
    const body = isChatMode
      ? {
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          system: data.systemPrompt,
          messages: data.messages,
        }
      : {
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: data.prompt }, data.fileBlock],
          }],
        }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
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
