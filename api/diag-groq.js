// TEMP diagnostic: check GROQ_API_KEY presence at runtime + live Groq ping.
// Protected by secret. DELETE after debugging.
const { fetchWithTimeout } = require('./_lib')

const SECRET = 'dg-7f3a9c1e'

module.exports = async (req, res) => {
  if ((req.query?.s || '') !== SECRET) return res.status(404).json({ ok: false })
  const key = process.env.GROQ_API_KEY || ''
  const out = {
    hasKey: Boolean(key),
    keyLen: key.length,
    keySuffix: key ? key.slice(-6) : null,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile (default)',
  }
  if (key) {
    try {
      const r = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
          }),
        },
        8000,
      )
      const data = await r.json().catch(() => null)
      out.groqStatus = r.status
      out.groqReply = data?.choices?.[0]?.message?.content || JSON.stringify(data).slice(0, 200)
    } catch (e) {
      out.groqError = e.message
    }
  }
  return res.status(200).json(out)
}
