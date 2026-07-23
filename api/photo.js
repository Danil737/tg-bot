// POST /api/photo
// JSON: { photo: base64_string, filename, caption, service, cemetery }
// Sends photo directly to Telegram without session/database
// Used by: uhod-mogil.ru contact form for attaching photo to lead

const { fetchWithTimeout } = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const BOT_TOKEN = process.env.BOT_TOKEN

// Экранирование для parse_mode:'HTML' (audit uhod#2): '<' в имени/контакте/услуге
// ломал разбор entities → sendPhoto падал 500 → фото молча терялось.
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const ALLOWED_ORIGINS = ['https://uhod-mogil.ru', 'https://www.uhod-mogil.ru', 'http://localhost:3000']

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

async function sendPhotoToTelegram(chatId, photoBuffer, caption) {
  // Отправляем как документ через Telegram Bot API с base64
  const formData = new FormData()
  formData.append('chat_id', chatId)
  // Телеграм принимает фото как multipart или как URL
  // Используем file:// ссылку на буффер через Blob
  const blob = new Blob([photoBuffer], { type: 'image/jpeg' })
  formData.append('photo', blob, 'photo.jpg')
  if (caption) formData.append('caption', caption)
  formData.append('parse_mode', 'HTML')

  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
    {
      method: 'POST',
      body: formData,
    },
    10000,
  )
  const data = await res.json()
  return { ok: data.ok, messageId: data.result?.message_id }
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const { photo: base64Photo, filename = 'photo.jpg', caption = '', service = '', cemetery = '' } = req.body || {}

    if (!base64Photo) {
      return res.status(400).json({ ok: false, error: 'No photo provided' })
    }

    // Декодируем base64 в буффер
    let photoBuffer
    try {
      photoBuffer = Buffer.from(base64Photo, 'base64')
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid base64' })
    }

    if (photoBuffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'File too large (max 10 MB)' })
    }

    if (photoBuffer.length < 100) {
      return res.status(400).json({ ok: false, error: 'File too small' })
    }

    // Build caption for Telegram
    const tgCaption = [
      '<b>📸 Фото к заявке (uhod-mogil.ru)</b>',
      caption ? `\n💬 ${htmlEsc(caption)}` : '',
      service ? `\n🔧 Услуга: ${htmlEsc(service)}` : '',
      cemetery ? `\n🪦 Кладбище: ${htmlEsc(cemetery)}` : '',
    ].filter(Boolean).join('')

    // Send to Telegram
    const { ok, messageId } = await sendPhotoToTelegram(OWNER_CHAT_ID, photoBuffer, tgCaption)

    if (!ok) {
      console.error('Failed to send photo to Telegram')
      return res.status(500).json({ ok: false, error: 'Failed to send photo' })
    }

    return res.status(200).json({ ok: true, messageId })
  } catch (e) {
    console.error('photo.js error:', e.message)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
