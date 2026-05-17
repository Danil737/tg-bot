const { fetchWithTimeout, safeLog } = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const BOT_TOKEN = process.env.BOT_TOKEN
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
// Set this when registering the webhook: ?secret_token=<TG_WEBHOOK_SECRET>
// Telegram echoes it as X-Telegram-Bot-Api-Secret-Token. Without this, anyone
// can POST forged updates to /api/webhook and spoof owner-reply messages.
const WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendMessage(chatId, text, options = {}) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options }),
    },
    8000,
  )
  const data = await res.json()
  // Don't log full payload — TG echoes back the request URL on errors which
  // can contain the bot token. safeLog strips that.
  safeLog('sendMessage.ok=' + data.ok, { ok: data.ok, error_code: data.error_code, description: data.description })
  return data
}

async function sb(path, method = 'GET', body = null, prefer = '') {
  if (!SUPABASE_SECRET) return null
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
    console.error(`Supabase ${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
    return null
  }
  return text ? JSON.parse(text) : null
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK')

  // CRITICAL: verify the secret token Telegram sends in headers.
  // Without this check, anyone can forge updates and spoof OWNER_CHAT_ID
  // reply_to_message → bot will send arbitrary text to any customer.
  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-telegram-bot-api-secret-token']
    if (provided !== WEBHOOK_SECRET) {
      console.warn('webhook: invalid secret_token header')
      // Always 200 so attackers can't differentiate "wrong secret" from "no message".
      return res.status(200).send('OK')
    }
  } else {
    console.warn('webhook: TG_WEBHOOK_SECRET not set — webhook is UNAUTHENTICATED. Set it ASAP.')
  }

  const { message } = req.body || {}
  if (!message) return res.status(200).send('OK')

  const chatId = message.chat?.id
  const text = message.text || ''
  const from = message.from || {}
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ')

  // Owner replies to a forwarded escalation message → forward back to the customer
  if (chatId === OWNER_CHAT_ID && message.reply_to_message) {
    const replyToId = message.reply_to_message.message_id
    const original = message.reply_to_message.text || ''

    // Path 1: web-chat session reply (find session by tg_root_message_id)
    if (SUPABASE_SECRET) {
      const sessions = await sb(
        `web_chat_sessions?tg_root_message_id=eq.${replyToId}&select=id,status`,
      )
      if (sessions && sessions.length > 0) {
        const session = sessions[0]
        await sb(
          `web_chat_messages`,
          'POST',
          { session_id: session.id, role: 'admin', content: text, tg_message_id: replyToId },
        )
        await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен в чат на сайте', {
          reply_to_message_id: message.message_id,
        })
        return res.status(200).send('OK')
      }
    }

    // Path 2: legacy direct-TG-customer reply (chatid in message text)
    const match = original.match(/chat_?id: (\d+)/)
    if (match) {
      const customerChatId = parseInt(match[1])
      await sendMessage(
        customerChatId,
        `💬 <b>Менеджер УходМогил:</b>\n${htmlEsc(text)}`,
      )
      await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен клиенту')
    }
    return res.status(200).send('OK')
  }

  // Message from a TG customer (not owner-reply)
  if (chatId !== OWNER_CHAT_ID) {
    if (text === '/start') {
      await sendMessage(chatId,
        '🌿 <b>Добро пожаловать в УходМогил!</b>\n\n' +
        'Мы занимаемся профессиональной уборкой и уходом за могилами на кладбищах Москвы.\n\n' +
        '✅ Фотоотчёт до и после\n' +
        '✅ Выезд 1–3 дня\n' +
        '✅ Цены от 3 000 ₽\n\n' +
        'Напишите нам — на каком кладбище нужна уборка и что сделать. Ответим быстро!\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru'
      )
      return res.status(200).send('OK')
    }

    const usernameLine = from.username ? `📎 @${htmlEsc(from.username)}\n` : ''
    await sendMessage(
      OWNER_CHAT_ID,
      `📨 <b>Новое сообщение от клиента</b>\n\n` +
        `👤 Имя: ${htmlEsc(name)}\n` +
        usernameLine +
        `💬 Сообщение: ${htmlEsc(text)}\n\n` +
        `chatid: ${chatId}\n\n` +
        `↩️ <i>Нажми "Ответить" на это сообщение чтобы написать клиенту</i>`,
    )
  }

  res.status(200).send('OK')
}
