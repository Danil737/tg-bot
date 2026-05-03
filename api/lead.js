// Receives POST { type, name, contact, service, cemetery, message } from uhod-mogil.ru
// Forwards a formatted message to OWNER_CHAT_ID in Telegram.
// Used by:
//   • main contact form (type='lead') — заявка на услугу
//   • review form         (type='review') — пользовательский отзыв на модерацию

const OWNER_CHAT_ID = 696698928
const BOT_TOKEN = process.env.BOT_TOKEN

const ALLOWED_ORIGINS = ['https://uhod-mogil.ru', 'https://www.uhod-mogil.ru', 'http://localhost:3000']

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function escapeMd(s) {
  if (!s) return ''
  return String(s).replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')
}

async function sendToOwner(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: OWNER_CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  })
  const data = await res.json()
  if (!data.ok) console.error('Telegram sendMessage failed:', data)
  return data.ok
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const type = body.type || 'lead'
    const name = (body.name || '').toString().slice(0, 200).trim()
    const contact = (body.contact || '').toString().slice(0, 200).trim()
    const service = (body.service || '').toString().slice(0, 200).trim()
    const cemetery = (body.cemetery || '').toString().slice(0, 200).trim()
    const message = (body.message || '').toString().slice(0, 4000).trim()
    const rating = parseInt(body.rating, 10) || 0
    const source = (body.source || 'site').toString().slice(0, 100)

    // Minimal sanity: name + contact (or just message for review)
    if (type === 'lead' && (!name || !contact)) {
      return res.status(400).json({ ok: false, error: 'Имя и контакт обязательны' })
    }
    if (type === 'review' && (!name || !message)) {
      return res.status(400).json({ ok: false, error: 'Имя и текст отзыва обязательны' })
    }

    let text = ''
    if (type === 'lead') {
      text =
        `🆕 *Новая заявка с сайта uhod\\-mogil\\.ru*\n\n` +
        `👤 *Имя:* ${escapeMd(name)}\n` +
        `📞 *Контакт:* ${escapeMd(contact)}\n` +
        (service ? `🛠 *Услуга:* ${escapeMd(service)}\n` : '') +
        (cemetery ? `📍 *Кладбище:* ${escapeMd(cemetery)}\n` : '') +
        (message ? `\n💬 *Комментарий:*\n${escapeMd(message)}\n` : '') +
        `\n_источник: ${escapeMd(source)}_`
    } else if (type === 'review') {
      const stars = '⭐'.repeat(Math.max(1, Math.min(5, rating)))
      text =
        `📝 *НОВЫЙ ОТЗЫВ НА МОДЕРАЦИИ*\n\n` +
        `👤 *Автор:* ${escapeMd(name)}\n` +
        (rating ? `${stars} *${rating}/5*\n` : '') +
        (service ? `🛠 *Услуга:* ${escapeMd(service)}\n` : '') +
        (cemetery ? `📍 *Кладбище:* ${escapeMd(cemetery)}\n` : '') +
        `\n💬 *Текст:*\n${escapeMd(message)}\n\n` +
        `_Если ОК — добавь в \`lib/reviews\\.ts\` и задеплой\\._`
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown type' })
    }

    if (!BOT_TOKEN) {
      console.error('BOT_TOKEN env var is missing')
      return res.status(500).json({ ok: false, error: 'Server misconfigured' })
    }

    const ok = await sendToOwner(text)
    if (!ok) return res.status(500).json({ ok: false, error: 'Telegram delivery failed' })

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('lead endpoint error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
