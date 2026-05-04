// GET /api/chat/poll?session=UUID&since=ISO
// Returns: { messages: [{role, content, created_at}], status }
// Used by the site widget to fetch new messages (long-poll-ish; we keep it simple — short poll every 3s).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY

const ALLOWED_ORIGINS = [
  'https://uhod-mogil.ru',
  'https://www.uhod-mogil.ru',
  'http://localhost:3000',
]

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
}

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : []
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ ok: false })

  try {
    const sessionId = (req.query?.session || '').toString()
    const since = (req.query?.since || '').toString()
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session' })
    }

    const sinceFilter = since ? `&created_at=gt.${encodeURIComponent(since)}` : ''
    const messages = await sb(
      `web_chat_messages?session_id=eq.${sessionId}${sinceFilter}` +
        `&order=created_at.asc&select=role,content,created_at`,
    )
    const sessRows = await sb(`web_chat_sessions?id=eq.${sessionId}&select=status`)
    const status = sessRows?.[0]?.status || 'active'

    return res.status(200).json({ ok: true, messages, status })
  } catch (e) {
    console.error('chat-poll error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
