// POST /api/chat-upload-photo
// Body: { sessionId, token, filename, contentType, data (base64 без data:image префикса), caption? }
// Returns: { ok: true, mediaUrl }
//
// Клиент загружает фото из виджета на сайте. Поток:
//   1. Валидация UUID + token (защита от подделки)
//   2. Декодирование base64 → Buffer
//   3. Валидация MIME + размера
//   4. Upload в Supabase Storage bucket `chat-photos/{session_id}/{ts}.{ext}`
//   5. Insert row в web_chat_messages с role='user', media_url, media_type='photo'
//   6. Notify owner в TG (sendPhoto с публичным URL + chat session context)
//   7. Return public URL — виджет уже видит свою картинку в чате

const { isValidUuid, fetchWithTimeout, safeLog } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const BOT_TOKEN = process.env.BOT_TOKEN                  // @uhodmogil_bot
const BOT_TOKEN_KMH = process.env.BOT_TOKEN_KMH          // @KissMyHandsBot
const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const PHOTOS_BUCKET = 'chat-photos'

function detectSite(sourceUrl) {
  const u = String(sourceUrl || '').toLowerCase()
  if (u.includes('kissmyhands.ru') || u.includes('kissmyhands.vercel.app')) return 'kissmyhands'
  return 'uhod-mogil'
}
function botTokenForSite(site) {
  return site === 'kissmyhands' ? BOT_TOKEN_KMH : BOT_TOKEN
}
function siteLabel(site) {
  return site === 'kissmyhands' ? 'Kiss My Hands' : 'УходМогил'
}

const MAX_BYTES = 5 * 1024 * 1024            // 5 MB после base64-декодирования
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']

const ALLOWED_ORIGINS = [
  'https://uhod-mogil.ru',
  'https://www.uhod-mogil.ru',
  'https://kissmyhands.ru',
  'https://www.kissmyhands.ru',
  'http://localhost:3000',
]

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

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
  if (!r.ok) throw new Error(`Supabase ${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function notifyOwnerPhoto(session, photoUrl, caption, site = 'uhod-mogil') {
  const token = botTokenForSite(site)
  if (!token) return null
  const sessionShort = session.id.slice(0, 8)
  const captionText =
    `📨 <b>Клиент прислал фото — ${htmlEsc(siteLabel(site))}</b>\n` +
    `🔗 Сессия: <code>${sessionShort}</code>\n` +
    (caption ? `💬 ${htmlEsc(caption)}\n` : '') +
    `\n↩️ <i>Reply на это сообщение (текст или фото) → попадёт клиенту в чат на сайте</i>`

  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        photo: photoUrl,
        caption: captionText,
        parse_mode: 'HTML',
      }),
    },
    10000,
  )
  const data = await res.json()
  safeLog('notifyOwnerPhoto.ok=' + data.ok, { error_code: data.error_code, description: data.description })

  // Если сессия ещё не escalated — обновляем tg_root_message_id, чтобы reply работал
  if (data.ok && data.result?.message_id && !session.tg_root_message_id) {
    try {
      await sb(`web_chat_sessions?id=eq.${session.id}`, 'PATCH', {
        tg_root_message_id: data.result.message_id,
      })
    } catch (e) {
      console.error('failed to update tg_root_message_id:', e.message)
    }
  }
  return data.result?.message_id || null
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const { sessionId, token, filename, contentType, data: base64Data, caption } = req.body || {}

    // Валидация sessionId
    if (!isValidUuid(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid sessionId' })
    }
    if (token && !isValidUuid(token)) {
      return res.status(400).json({ ok: false, error: 'Invalid token' })
    }

    // Получаем сессию + проверяем токен
    const sessRows = await sb(`web_chat_sessions?id=eq.${sessionId}&select=*`)
    if (!sessRows || sessRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Session not found' })
    }
    const session = sessRows[0]
    if (session.session_token && session.session_token !== token) {
      return res.status(403).json({ ok: false, error: 'Forbidden' })
    }

    // Валидация контента
    if (!base64Data || typeof base64Data !== 'string') {
      return res.status(400).json({ ok: false, error: 'Empty data' })
    }
    if (!ALLOWED_MIMES.includes(contentType)) {
      return res.status(400).json({ ok: false, error: 'Only JPEG/PNG/WebP/HEIC allowed' })
    }

    // Декодируем base64
    let buffer
    try {
      buffer = Buffer.from(base64Data, 'base64')
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid base64' })
    }
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'File too large (max 5 MB)' })
    }
    if (buffer.length < 100) {
      return res.status(400).json({ ok: false, error: 'File too small' })
    }

    // Расширение для имени файла в Storage
    const extMap = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
    }
    const ext = extMap[contentType] || 'jpg'
    const storagePath = `${session.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`

    // Upload в Supabase Storage
    const uploadRes = await fetchWithTimeout(
      `${SUPABASE_URL}/storage/v1/object/${PHOTOS_BUCKET}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SECRET,
          Authorization: `Bearer ${SUPABASE_SECRET}`,
          'Content-Type': contentType,
        },
        body: buffer,
      },
      15000,
    )
    if (!uploadRes.ok) {
      const errText = await uploadRes.text()
      console.error('Storage upload failed:', uploadRes.status, errText.slice(0, 200))
      return res.status(500).json({ ok: false, error: 'Upload failed' })
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${PHOTOS_BUCKET}/${storagePath}`

    // Сохраняем в web_chat_messages
    const trimmedCaption = (caption || '').toString().slice(0, 500).trim()
    await sb(
      `web_chat_messages`,
      'POST',
      {
        session_id: session.id,
        role: 'user',
        content: trimmedCaption,
        media_url: publicUrl,
        media_type: 'photo',
      },
    )

    // Уведомляем владельца в TG (это «тихая» эскалация если её ещё не было)
    // Site выводим либо из source_url сессии, либо из текущего Origin.
    const site = detectSite(session.source_url || req.headers.origin || '')
    await notifyOwnerPhoto(session, publicUrl, trimmedCaption, site)

    return res.status(200).json({ ok: true, mediaUrl: publicUrl })
  } catch (e) {
    console.error('chat-upload-photo error:', e.message)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
