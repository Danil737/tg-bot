// Receives POST { type, name, contact, service, cemetery, message } from uhod-mogil.ru
// Forwards a formatted message to OWNER_CHAT_ID in Telegram.
// Used by:
//   • main contact form (type='lead') — заявка на услугу
//   • review form         (type='review') — пользовательский отзыв на модерацию

const { fetchWithTimeout, getClientMeta, clientMetaBlockMd, attributionLineMd } = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const BOT_TOKEN = process.env.BOT_TOKEN

const ALLOWED_ORIGINS = ['https://uhod-mogil.ru', 'https://www.uhod-mogil.ru', 'http://localhost:3000']

// In-memory soft throttle by IP. Resets on cold start, which is fine — this
// stops obvious spammers, not a determined attacker (use Vercel WAF for that).
const ipRate = new Map()
const IP_RATE_MAX = 5         // requests per window
const IP_RATE_WINDOW_MS = 60_000

function checkIpRate(ip) {
  if (!ip) return false
  const now = Date.now()
  const entry = ipRate.get(ip) || { count: 0, resetAt: now + IP_RATE_WINDOW_MS }
  if (now >= entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + IP_RATE_WINDOW_MS
  }
  entry.count++
  ipRate.set(ip, entry)
  return entry.count > IP_RATE_MAX
}

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

// Parse a contact string and produce inline-keyboard buttons for instant reply
function buildContactButtons(contact, name) {
  const trimmed = (contact || '').trim()
  const buttons = []

  // Telegram username — @username, t.me/username, or bare username (no digits)
  const tgMatch =
    trimmed.match(/(?:^|[\s/])@([a-zA-Z0-9_]{4,32})\b/) ||
    trimmed.match(/t\.me\/([a-zA-Z0-9_]{4,32})/i) ||
    (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(trimmed) ? [, trimmed] : null)
  if (tgMatch) {
    buttons.push({ text: '✈️ Написать в Telegram', url: `https://t.me/${tgMatch[1]}` })
  }

  // Phone: extract digits, normalize to E.164 (+7… for Russia)
  // Note: Telegram inline-buttons do NOT support tel: URLs (only http/https/tg).
  // The phone number itself is auto-linked in the message text — long-press in TG
  // gives a "Call / Copy" menu. So we only add a WhatsApp button here.
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length >= 10 && digits.length <= 15) {
    let e164
    if (digits.length === 11 && digits.startsWith('8')) e164 = '+7' + digits.slice(1)
    else if (digits.length === 10) e164 = '+7' + digits
    else e164 = (trimmed.startsWith('+') ? '+' : '+') + digits
    const greeting = `Здравствуйте, ${name || 'это'}! УходМогил по вашей заявке с сайта.`
    buttons.push({
      text: '💬 WhatsApp',
      url: `https://wa.me/${e164.replace('+', '')}?text=${encodeURIComponent(greeting)}`,
    })
  }

  if (buttons.length === 0) return null
  return [buttons] // single row
}

async function sendToOwner(text, replyMarkup) {
  const body = {
    chat_id: OWNER_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  }
  if (replyMarkup) body.reply_markup = { inline_keyboard: replyMarkup }
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    6000,
  )
  const data = await res.json()
  if (!data.ok) console.error('Telegram sendMessage failed:', data)
  return data.ok
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  // Spam protection: limit per IP. Vercel forwards real IP in x-forwarded-for.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress
  if (checkIpRate(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много заявок. Попробуйте через минуту.' })
  }

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

    // Geo/device/IP + источник трафика клиента (всё авто, без вопросов клиенту).
    const metaBlock = clientMetaBlockMd(getClientMeta(req), { page: true })
    const attribLine = attributionLineMd(body.attribution)
    const infoBlock = [metaBlock, attribLine].filter(Boolean).join('\n')

    let text = ''
    if (type === 'lead') {
      text =
        `🆕 *Новая заявка с сайта uhod\\-mogil\\.ru*\n\n` +
        `📝 *Источник:* форма заявки на сайте\n` +
        `👤 *Имя:* ${escapeMd(name)}\n` +
        `📞 *Контакт:* ${escapeMd(contact)}\n` +
        (service ? `🛠 *Услуга:* ${escapeMd(service)}\n` : '') +
        (cemetery ? `📍 *Кладбище:* ${escapeMd(cemetery)}\n` : '') +
        (message ? `\n💬 *Комментарий:*\n${escapeMd(message)}\n` : '') +
        (infoBlock ? `\n${infoBlock}\n` : '') +
        `\n_тех\\. источник: ${escapeMd(source)}_`
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

    // Build inline-keyboard buttons (only for leads — reviews don't need contact action)
    const replyMarkup = type === 'lead' ? buildContactButtons(contact, name) : null

    const ok = await sendToOwner(text, replyMarkup)
    if (!ok) return res.status(500).json({ ok: false, error: 'Telegram delivery failed' })

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('lead endpoint error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
