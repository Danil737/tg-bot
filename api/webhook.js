const OWNER_CHAT_ID = 696698928
const BOT_TOKEN = process.env.BOT_TOKEN
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendMessage(chatId, text, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...options }),
  })
  const data = await res.json()
  console.log('sendMessage result:', JSON.stringify(data))
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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) {
    console.error(`Supabase ${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
    return null
  }
  return text ? JSON.parse(text) : null
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK')

  const { message } = req.body || {}
  if (!message) return res.status(200).send('OK')

  const chatId = message.chat.id
  const text = message.text || ''
  const from = message.from
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ')

  // Владелец отвечает на пересланное сообщение → отправляем клиенту
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

    // Path 2: legacy direct-TG-customer reply (chatid in message text).
    // Underscore-less form: Telegram parses `chat_id` as markdown italic start
    // and strips the `_`, so the .text we get back reads "chatid: NNN".
    // Regex tolerates both forms in case old escalation messages still exist.
    const match = original.match(/chat_?id: (\d+)/)
    if (match) {
      const customerChatId = parseInt(match[1])
      // Use HTML so user-typed text with stray *, _, [ ] won't break parsing
      await sendMessage(
        customerChatId,
        `💬 <b>Менеджер УходМогил:</b>\n${htmlEsc(text)}`,
        { parse_mode: 'HTML' },
      )
      await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен клиенту')
    }
    return res.status(200).send('OK')
  }

  // Сообщение от клиента
  if (chatId !== OWNER_CHAT_ID) {
    // Команда /start — только приветствие клиенту, владельца НЕ дёргаем
    // (это не лид, человек просто открыл бота кнопкой Start)
    if (text === '/start') {
      await sendMessage(chatId,
        '🌿 *Добро пожаловать в УходМогил!*\n\n' +
        'Мы занимаемся профессиональной уборкой и уходом за могилами на кладбищах Москвы.\n\n' +
        '✅ Фотоотчёт до и после\n' +
        '✅ Выезд 1–3 дня\n' +
        '✅ Цены от 3 500 ₽\n\n' +
        'Напишите нам — на каком кладбище нужна уборка и что сделать. Ответим быстро!\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru'
      )
      return res.status(200).send('OK')
    }

    // НИКАКОГО автоответа клиенту: владелец сам отвечает через TG reply
    // в течение 5 минут (это и есть «настоящий» ответ).
    //
    // Уведомление владельцу — HTML-режим: имя/username/текст приходят от
    // пользователя и могут содержать *, _, [, ], которые ломали Markdown-парсер
    // (например, username `AJ_171` отбивал ошибку «can't parse entities»).
    // HTML escape всех пользовательских полей решает проблему раз и навсегда.
    const usernameLine = from.username ? `📎 @${htmlEsc(from.username)}\n` : ''
    await sendMessage(
      OWNER_CHAT_ID,
      `📨 <b>Новое сообщение от клиента</b>\n\n` +
        `👤 Имя: ${htmlEsc(name)}\n` +
        usernameLine +
        `💬 Сообщение: ${htmlEsc(text)}\n\n` +
        `chatid: ${chatId}\n\n` +
        `↩️ <i>Нажми "Ответить" на это сообщение чтобы написать клиенту</i>`,
      { parse_mode: 'HTML' },
    )
  }

  res.status(200).send('OK')
}
