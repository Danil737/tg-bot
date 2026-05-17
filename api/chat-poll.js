// GET /api/chat/poll?session=UUID&token=UUID&since=ISO
// Returns: { messages: [{role, content, created_at}], status }
//
// Authorization: token must match web_chat_sessions.session_token (returned to
// the widget ONCE on session creation). UUID alone is not enough — UUIDs leak
// via screenshots, referrer headers, error logs.

const { isValidUuid, fetchWithTimeout } = require('./_lib')

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
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: SUPABASE_SECRET,
        Authorization: `Bearer ${SUPABASE_SECRET}`,
      },
    },
    5000,
  )
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
    const token = (req.query?.token || '').toString()
    const since = (req.query?.since || '').toString()

    // Strict UUID validation prevents PostgREST injection via ?id=eq.<garbage>
    if (!isValidUuid(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session' })
    }
    // Token is required for new sessions (post-migration). For backward
    // compatibility, sessions created before the migration won't have it —
    // we accept those, but new sessions are token-gated.
    if (token && !isValidUuid(token)) {
      return res.status(400).json({ ok: false, error: 'Invalid token' })
    }

    // ISO 8601 timestamp validation — narrow to digits, dash, colon, dot, T, Z, +
    const safeSince = /^[0-9:T.Z+-]{1,40}$/.test(since) ? since : ''
    const sinceFilter = safeSince ? `&created_at=gt.${encodeURIComponent(safeSince)}` : ''

    // Fetch session + verify token before returning messages.
    // select=* so the code keeps working before migration 002 is applied — the
    // session_token field will simply be undefined and we grandfather the session.
    const sessRows = await sb(`web_chat_sessions?id=eq.${sessionId}&select=*`)
    if (!sessRows || sessRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Session not found' })
    }
    const session = sessRows[0]
    // If session has a token, request must match. Legacy sessions (or pre-migration
    // sessions) without token are grandfathered.
    if (session.session_token && session.session_token !== token) {
      return res.status(403).json({ ok: false, error: 'Forbidden' })
    }

    const messages = await sb(
      `web_chat_messages?session_id=eq.${sessionId}${sinceFilter}` +
        `&order=created_at.asc&select=role,content,created_at`,
    )

    return res.status(200).json({ ok: true, messages, status: session.status || 'active' })
  } catch (e) {
    console.error('chat-poll error:', e.message)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
