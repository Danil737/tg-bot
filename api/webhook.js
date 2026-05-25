const { fetchWithTimeout, safeLog } = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const BOT_TOKEN = process.env.BOT_TOKEN                         // @uhodmogil_bot
const BOT_TOKEN_KMH = process.env.BOT_TOKEN_KMH                 // @KissMyHandsBot
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET
const PHOTOS_BUCKET = 'chat-photos'      // создать вручную в Supabase Storage (public)

// Site detection from sourceUrl stored on the chat session.
function detectSite(sourceUrl) {
  const u = String(sourceUrl || '').toLowerCase()
  if (u.includes('kissmyhands.ru') || u.includes('kissmyhands.vercel.app')) return 'kissmyhands'
  return 'uhod-mogil'
}
function botTokenForSite(site) {
  return site === 'kissmyhands' ? BOT_TOKEN_KMH : BOT_TOKEN
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendMessage(chatId, text, options = {}, botToken = BOT_TOKEN) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options }),
    },
    8000,
  )
  const data = await res.json()
  safeLog('sendMessage.ok=' + data.ok, { ok: data.ok, error_code: data.error_code, description: data.description })
  return data
}

async function sendPhoto(chatId, photoUrl, caption = '', botToken = BOT_TOKEN) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/sendPhoto`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' }),
    },
    10000,
  )
  const data = await res.json()
  safeLog('sendPhoto.ok=' + data.ok, { ok: data.ok, error_code: data.error_code, description: data.description })
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

// Скачивает фото из Telegram и загружает в Supabase Storage.
// Возвращает public URL или null при ошибке.
async function downloadAndStorePhoto(fileId, sessionId, botToken = BOT_TOKEN) {
  try {
    // 1. Получить путь к файлу в TG
    const fileRes = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      {},
      6000,
    )
    const fileData = await fileRes.json()
    if (!fileData.ok) {
      console.error('getFile failed:', fileData.description)
      return null
    }
    const filePath = fileData.result.file_path  // 'photos/file_XX.jpg'
    const ext = filePath.split('.').pop() || 'jpg'

    // 2. Скачать файл
    const downloadRes = await fetchWithTimeout(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      {},
      15000,
    )
    if (!downloadRes.ok) {
      console.error('TG file download failed:', downloadRes.status)
      return null
    }
    const buffer = await downloadRes.arrayBuffer()

    // 3. Загрузить в Supabase Storage
    const storagePath = `${sessionId}/${Date.now()}.${ext}`
    const uploadRes = await fetchWithTimeout(
      `${SUPABASE_URL}/storage/v1/object/${PHOTOS_BUCKET}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SECRET,
          Authorization: `Bearer ${SUPABASE_SECRET}`,
          'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
        },
        body: buffer,
      },
      15000,
    )
    if (!uploadRes.ok) {
      const errText = await uploadRes.text()
      console.error('Supabase Storage upload failed:', uploadRes.status, errText.slice(0, 200))
      return null
    }

    // 4. Public URL (bucket должен быть public — см. миграцию 004)
    return `${SUPABASE_URL}/storage/v1/object/public/${PHOTOS_BUCKET}/${storagePath}`
  } catch (e) {
    console.error('downloadAndStorePhoto error:', e.message)
    return null
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK')

  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-telegram-bot-api-secret-token']
    if (provided !== WEBHOOK_SECRET) {
      console.warn('webhook: invalid secret_token header')
      return res.status(200).send('OK')
    }
  } else {
    console.warn('webhook: TG_WEBHOOK_SECRET not set — webhook is UNAUTHENTICATED. Set it ASAP.')
  }

  // Identify incoming bot: @KissMyHandsBot sets webhook with ?bot=kmh in URL,
  // @uhodmogil_bot sets webhook without query (default = uhod-mogil).
  // Used for: (a) direct customer /start replies (which bot greeted them);
  // (b) confirmations to owner (use same bot's chat thread).
  const incomingBot = (req.query?.bot || '').toString() === 'kmh' ? 'kmh' : 'uhod'
  const incomingBotToken = incomingBot === 'kmh' ? BOT_TOKEN_KMH : BOT_TOKEN
  if (!incomingBotToken) {
    safeLog('webhook: bot token not configured', { incomingBot })
    return res.status(200).send('OK')
  }

  const { message } = req.body || {}
  if (!message) return res.status(200).send('OK')

  const chatId = message.chat?.id
  const text = message.text || ''
  const caption = message.caption || ''
  const from = message.from || {}
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ')

  // === OWNER REPLY ===
  if (chatId === OWNER_CHAT_ID && message.reply_to_message) {
    const replyToId = message.reply_to_message.message_id
    // Фикс бага: при reply на фото-сообщение от бота, текст лежит в caption,
    // а не в text. Без || caption regex `chatid: NNN` ничего не находил
    // и бот молча игнорил ответ владельца. Также бывает text_html/caption_html
    // когда reply на html-форматированное сообщение.
    const original =
      message.reply_to_message.text ||
      message.reply_to_message.caption ||
      ''

    // Если в reply есть фото — это photo report от owner'a
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0
    // media_group_id — если фото часть альбома (несколько фото одной отправкой)
    const mediaGroupId = message.media_group_id || null

    // Path 1: web-chat session reply (find session by tg_root_message_id)
    if (SUPABASE_SECRET) {
      const sessions = await sb(
        `web_chat_sessions?tg_root_message_id=eq.${replyToId}&select=id,status,source_url`,
      )
      if (sessions && sessions.length > 0) {
        const session = sessions[0]
        // Use bot derived from session.source_url for confirmation messages.
        // This way owner sees ✅ in the same chat thread (KMH or uhod-mogil).
        const sessionSite = detectSite(session.source_url || '')
        const sessionBotToken = botTokenForSite(sessionSite) || incomingBotToken

        if (hasPhoto) {
          // Берём самое большое разрешение (последний элемент в массиве)
          const largestPhoto = message.photo[message.photo.length - 1]
          const photoUrl = await downloadAndStorePhoto(largestPhoto.file_id, session.id, sessionBotToken)

          if (!photoUrl) {
            await sendMessage(OWNER_CHAT_ID, '❌ Не удалось загрузить фото в Storage. Попробуй ещё раз.', {
              reply_to_message_id: message.message_id,
            }, sessionBotToken)
            return res.status(200).send('OK')
          }

          await sb(
            `web_chat_messages`,
            'POST',
            {
              session_id: session.id,
              role: 'admin',
              content: caption || '',          // для альбома caption есть только у первого фото
              tg_message_id: replyToId,
              media_url: photoUrl,
              media_type: 'photo',
              media_group_id: mediaGroupId,
            },
          )

          // Для альбома: проверяем сколько фото уже загружено, шлём только короткое подтверждение
          if (mediaGroupId) {
            const groupRows = await sb(
              `web_chat_messages?session_id=eq.${session.id}&media_group_id=eq.${mediaGroupId}&select=id`,
            )
            const groupCount = groupRows?.length || 1
            await sendMessage(OWNER_CHAT_ID, `📷 ${groupCount}`, {
              reply_to_message_id: message.message_id,
            }, sessionBotToken)
          } else {
            await sendMessage(OWNER_CHAT_ID, '✅ Фото отправлено клиенту в чат на сайте', {
              reply_to_message_id: message.message_id,
            }, sessionBotToken)
          }
          return res.status(200).send('OK')
        }

        // Текстовый reply
        await sb(
          `web_chat_messages`,
          'POST',
          { session_id: session.id, role: 'admin', content: text, tg_message_id: replyToId },
        )
        await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен в чат на сайте', {
          reply_to_message_id: message.message_id,
        }, sessionBotToken)
        return res.status(200).send('OK')
      }
    }

    // Path 2: legacy direct-TG-customer reply (chatid in message text).
    // Bot identity comes from incomingBot (which webhook URL received this update).
    const match = original.match(/chat_?id: (\d+)/)
    if (match) {
      const customerChatId = parseInt(match[1])
      const managerLabel = incomingBot === 'kmh' ? 'Сергей · Kiss My Hands' : 'Менеджер УходМогил'

      if (hasPhoto) {
        // Для TG-клиента используем file_id напрямую — TG умеет ресенд по file_id, не нужно скачивать
        const largestPhoto = message.photo[message.photo.length - 1]
        await sendPhoto(
          customerChatId,
          largestPhoto.file_id,
          caption ? `💬 <b>${managerLabel}:</b>\n${htmlEsc(caption)}` : '',
          incomingBotToken,
        )
        await sendMessage(OWNER_CHAT_ID, mediaGroupId ? '📷' : '✅ Фото отправлено клиенту', {
          reply_to_message_id: message.message_id,
        }, incomingBotToken)
        return res.status(200).send('OK')
      }

      await sendMessage(
        customerChatId,
        `💬 <b>${managerLabel}:</b>\n${htmlEsc(text)}`,
        {},
        incomingBotToken,
      )
      await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен клиенту', {}, incomingBotToken)
    }
    return res.status(200).send('OK')
  }

  // === CUSTOMER MESSAGE in direct TG ===
  if (chatId !== OWNER_CHAT_ID) {
    if (text === '/start') {
      if (incomingBot === 'kmh') {
        await sendMessage(chatId,
          '👋 <b>Kiss My Hands — премиум-ремонт ванных в Москве</b>\n\n' +
          'Я — Сергей Козлов, мастер с 23-летним опытом. Работаю один, без бригад. ' +
          '4.92★ из 168 отзывов на ПРОФИ.РУ.\n\n' +
          '💰 Раздельный туалет под ключ: 120–150 тыс ₽\n' +
          '💰 Раздельная ванная: 180–200 тыс ₽\n' +
          '💰 Совмещённый санузел: 300–350 тыс ₽\n' +
          '⏱ 12–15 рабочих дней\n' +
          '🛡 Гарантия 20+ лет\n\n' +
          'Опишите задачу — что нужно сделать, какой дом/серия. Можно прислать фото. Отвечу лично.\n\n' +
          '🌐 <a href="https://kissmyhands.ru">kissmyhands.ru</a>',
          {}, incomingBotToken,
        )
        return res.status(200).send('OK')
      }
      await sendMessage(chatId,
        '🌿 <b>Добро пожаловать в УходМогил!</b>\n\n' +
        'Мы занимаемся профессиональной уборкой и уходом за могилами на кладбищах Москвы.\n\n' +
        '✅ Фотоотчёт до и после\n' +
        '✅ Выезд 1–3 дня\n' +
        '✅ Цены от 3 000 ₽\n\n' +
        'Напишите нам — на каком кладбище нужна уборка и что сделать. Ответим быстро!\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru\n' +
        '📢 Наш канал с фотоотчётами и календарём поминальных дней: <a href="https://t.me/uhod_mogil">t.me/uhod_mogil</a>',
        {}, incomingBotToken,
      )
      return res.status(200).send('OK')
    }

    const usernameLine = from.username ? `📎 @${htmlEsc(from.username)}\n` : ''
    const botLabel = incomingBot === 'kmh' ? 'Kiss My Hands' : 'УходМогил'

    // Если клиент прислал фото — пересылаем тебе в TG как уведомление (через тот же бот)
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1]
      await sendPhoto(
        OWNER_CHAT_ID,
        largestPhoto.file_id,
        `📨 <b>Фото от клиента — ${botLabel}</b>\n\n` +
          `👤 ${htmlEsc(name)}\n` +
          usernameLine +
          (caption ? `💬 ${htmlEsc(caption)}\n\n` : '') +
          `chatid: ${chatId}\n\n` +
          `↩️ <i>Ответ на это сообщение (включая фото) — пересылается клиенту</i>`,
        incomingBotToken,
      )
      return res.status(200).send('OK')
    }

    // Текстовое сообщение
    await sendMessage(
      OWNER_CHAT_ID,
      `📨 <b>Новое сообщение от клиента — ${botLabel}</b>\n\n` +
        `👤 Имя: ${htmlEsc(name)}\n` +
        usernameLine +
        `💬 Сообщение: ${htmlEsc(text)}\n\n` +
        `chatid: ${chatId}\n\n` +
        `↩️ <i>Нажми "Ответить" на это сообщение чтобы написать клиенту</i>`,
      {}, incomingBotToken,
    )
  }

  res.status(200).send('OK')
}
