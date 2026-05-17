// POST /api/subscribe
// Body: { email, source?, sourceUrl? }
// Returns: { ok: true, unsubscribeToken? }
//
// Saves email to web_chat_sessions's neighbor table email_subscriptions.
// Also notifies owner in TG (low-priority, no escalation).
// Idempotent — re-subscribing the same email returns ok without duplicate.

const { fetchWithTimeout, safeLog } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const BOT_TOKEN = process.env.BOT_TOKEN
const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)

const ALLOWED_ORIGINS = [
  'https://uhod-mogil.ru',
  'https://www.uhod-mogil.ru',
  'http://localhost:3000',
]

// Soft per-IP rate-limit. In-memory, resets on cold start. Enough for casual spam.
const ipRate = new Map()
const IP_MAX = 5
const IP_WINDOW_MS = 60_000

function checkIpRate(ip) {
  if (!ip) return false
  const now = Date.now()
  const entry = ipRate.get(ip) || { count: 0, resetAt: now + IP_WINDOW_MS }
  if (now >= entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + IP_WINDOW_MS
  }
  entry.count++
  ipRate.set(ip, entry)
  return entry.count > IP_MAX
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

// Basic email validation. Not RFC-perfect, but good enough.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

async function sb(path, method = 'GET', body = null, prefer = '') {
  const headers = {
    apikey: SUPABASE_SECRET,
    Authorization: `Bearer ${SUPABASE_SECRET}`,
    'Content-Type': 'application/json',
  }
  if (prefer) headers['Prefer'] = prefer
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${path}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    6000,
  )
  const text = await r.text()
  if (!r.ok) {
    // 409 conflict (duplicate email) is expected on re-subscribe — return null gracefully
    if (r.status === 409) return null
    throw new Error(`Supabase ${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
  }
  return text ? JSON.parse(text) : null
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function notifyOwner(email, source, isNew) {
  if (!BOT_TOKEN) return
  const text = isNew
    ? `📬 <b>Новый подписчик на рассылку</b>\n\n📧 ${htmlEsc(email)}\n🔗 Источник: ${htmlEsc(source || 'неизвестно')}`
    : `📬 <i>Повторная подписка</i>: ${htmlEsc(email)} (уже был в базе)`
  try {
    await fetchWithTimeout(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML' }),
      },
      4000,
    )
  } catch (e) {
    safeLog('subscribe: notifyOwner failed', e.message)
  }
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress
  if (checkIpRate(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много запросов. Попробуйте через минуту.' })
  }

  try {
    const { email: rawEmail, source, sourceUrl } = req.body || {}
    const email = String(rawEmail || '').trim().toLowerCase()

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email обязателен' })
    }
    if (email.length > 200 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Некорректный email' })
    }

    // Check if already exists
    const existing = await sb(`email_subscriptions?email=eq.${encodeURIComponent(email)}&select=id,unsubscribed_at,unsubscribe_token`)
    if (existing && existing.length > 0) {
      const row = existing[0]
      if (row.unsubscribed_at) {
        // Re-activate previously unsubscribed user
        await sb(`email_subscriptions?id=eq.${row.id}`, 'PATCH', { unsubscribed_at: null })
        await notifyOwner(email, source, false)
        return res.status(200).json({ ok: true, unsubscribeToken: row.unsubscribe_token, status: 'reactivated' })
      }
      // Already active — silently OK, do not duplicate
      await notifyOwner(email, source, false)
      return res.status(200).json({ ok: true, unsubscribeToken: row.unsubscribe_token, status: 'already-active' })
    }

    // New subscription
    const inserted = await sb(
      `email_subscriptions`,
      'POST',
      {
        email,
        source: String(source || 'site').slice(0, 100),
        source_url: String(sourceUrl || '').slice(0, 500) || null,
      },
      'return=representation',
    )

    const created = inserted?.[0]
    await notifyOwner(email, source, true)

    return res.status(200).json({
      ok: true,
      unsubscribeToken: created?.unsubscribe_token,
      status: 'subscribed',
    })
  } catch (e) {
    console.error('subscribe error:', e.message)
    return res.status(500).json({ ok: false, error: 'Не удалось подписать. Попробуйте позже.' })
  }
}
