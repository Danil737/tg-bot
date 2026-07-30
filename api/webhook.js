const { fetchWithTimeout, safeLog } = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const KMH_EXTRA_OWNER_IDS = (process.env.KMH_EXTRA_OWNER_IDS || '1650405909')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
const ALL_OWNER_IDS = new Set([OWNER_CHAT_ID, ...KMH_EXTRA_OWNER_IDS])
const BOT_TOKEN = process.env.BOT_TOKEN                         // @uhodmogil_bot
const BOT_TOKEN_KMH = process.env.BOT_TOKEN_KMH                 // @KissMyHandsBot
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET
// Тестовый ключ: пусто в норме, значение ставится только на время проверки цепочки.
const WEBHOOK_SECRET_ALT = process.env.TG_WEBHOOK_SECRET_ALT || ''
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

// Parse user_contact field that may encode extra-owner notification msg_ids.
// Format: "extra:<chat_id>:<msg_id>;<chat_id>:<msg_id>"
function parseExtraOwners(userContact) {
  if (!userContact || !userContact.startsWith('extra:')) return []
  return userContact.slice(6).split(';').map(part => {
    const [cid, mid] = part.split(':').map(Number)
    return { chat_id: cid, message_id: mid }
  }).filter(p => p.chat_id && p.message_id)
}

// Notify all owners about a forwarded site message. Used to broadcast Daniil's reply
// to Sergey (and vice versa) so both see the conversation.
async function broadcastToOtherOwners(text, fromChatId, botToken) {
  const recipients = [OWNER_CHAT_ID, ...KMH_EXTRA_OWNER_IDS].filter(cid => cid !== fromChatId)
  for (const cid of recipients) {
    try {
      await fetchWithTimeout(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cid, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        },
        6000,
      )
    } catch (e) {
      safeLog('broadcastToOtherOwners failed', { cid, err: e.message })
    }
  }
}

// CRM (РФ-сервер): складываем переписку в карточку клиента, чтобы история жила не в ленте
// уведомлений, а рядом с заказом. Пересылка владельцу при этом остаётся как была.
//
// Главное свойство: CRM НЕ должна ломать бота. Короткий таймаут, ошибки глушим —
// если CRM недоступна, сообщение клиента всё равно доедет до владельца. Обратный порядок
// (сначала CRM, потом уведомление) означал бы, что падение CRM = молча потерянный лид.
const CRM_URL = process.env.CRM_URL || ''
const CRM_SECRET = process.env.CRM_SECRET || ''

async function crmIngest(payload) {
  if (!CRM_URL || !CRM_SECRET) return
  try {
    const ctrl = new AbortController()
    const kill = setTimeout(() => ctrl.abort(), 3500)
    const r = await fetch(CRM_URL.replace(/\/+$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': CRM_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(kill)
    safeLog('crm.ingest=' + r.status, { status: r.status })
  } catch (e) {
    safeLog('crm.ingest.fail', { error: String(e && e.message || e).slice(0, 120) })
  }
}

// Поиск захоронения делает CRM: там уже есть разбор выдачи, кэш на 14 дней и пауза
// между запросами к чужому сайту. Дублировать это в боте значило бы завести второй
// источник правды и вдвое чаще стучаться к epoisk.ru.
async function crmGrave(payload) {
  if (!CRM_URL || !CRM_SECRET) return null
  try {
    const ctrl = new AbortController()
    const kill = setTimeout(() => ctrl.abort(), 12000)   // запрос уходит на внешний сайт
    const r = await fetch(CRM_URL.replace(/\/+$/, '') + '/api/bot/grave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': CRM_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(kill)
    if (!r.ok) return null
    return await r.json()
  } catch (e) {
    safeLog('crm.grave.fail', { error: String((e && e.message) || e).slice(0, 120) })
    return null
  }
}

// Выписка из ОТКРЫТОГО реестра — ДЛЯ ВЛАДЕЛЬЦА, не для клиента.
// Автомат не должен объявлять человеку, где лежит его дед: совпадение по ФИО это ещё
// не та могила, а цена ошибки тут несоизмерима с экономией одного сообщения. Владелец
// смотрит выписку, при необходимости уточняет год рождения или участок — и отвечает сам.
function graveReply(g) {
  if (!g || !g.ok || !g.results || !g.results.length) return null
  const rows = g.results.map((r) => {
    const links = []
    if (r.map_url) links.push(`<a href="${r.map_url}">план участка</a>`)
    if (r.lat) links.push(`<a href="https://yandex.ru/maps/?pt=${r.lon},${r.lat}&z=18&l=sat">на карте</a>`)
    const ins = (r.inscription || []).slice(0, 4).map((x) => htmlEsc(x)).join('\n     ')
    return `📍 <b>${htmlEsc(r.uchastok)}</b> — ${htmlEsc(r.cemetery)}` +
      (ins ? `\n     ${ins}` : '') +
      (links.length ? `\n     ${links.join(' · ')}` : '')
  })
  const more = g.total > g.results.length
    ? `\n\nВсего совпадений: ${g.total}, показаны первые ${g.results.length}.`
    : ''
  return `🔎 <b>Реестр захоронений — по сообщению клиента</b>\n\n${rows.join('\n\n')}${more}`
}

function crmProject(bot) {
  return bot === 'kmh' ? 'kissmyhands' : 'uhod-mogil'
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

// Подтверждение доставки реакцией, а не отдельным сообщением: каждый ответ владельца
// иначе плодит "✅ Ответ отправлен клиенту" и лента чата превращается в спам (30.07.2026).
// "✅" в список реакций Telegram не входит — используем 👌 из стандартного набора.
async function reactOk(chatId, messageId, botToken = BOT_TOKEN) {
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/setMessageReaction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👌' }],
        }),
      },
      6000,
    )
    const data = await res.json()
    safeLog('setMessageReaction.ok=' + data.ok, { ok: data.ok, description: data.description })
    return data.ok
  } catch (e) {
    safeLog('setMessageReaction failed', { err: e.message })
    return false
  }
}

// Ресенд любого вложения по file_id — внутри TG файл качать не нужно.
async function sendMediaByFileId(chatId, method, field, fileId, caption = '', botToken = BOT_TOKEN) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, [field]: fileId, caption, parse_mode: 'HTML' }),
    },
    10000,
  )
  const data = await res.json()
  safeLog(`${method}.ok=` + data.ok, { ok: data.ok, error_code: data.error_code, description: data.description })
  return data
}

// Для типов без caption (кружок, стикер, гео) — копия сообщения как есть.
async function copyMessage(toChatId, fromChatId, messageId, botToken = BOT_TOKEN) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/copyMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
    },
    10000,
  )
  const data = await res.json()
  safeLog('copyMessage.ok=' + data.ok, { ok: data.ok, error_code: data.error_code, description: data.description })
  return data
}

// Клиент присылает вложение не только как сжатое фото: вставка картинки из буфера
// в Telegram Desktop/Web уходит как document image.png. Раньше ловился только
// message.photo — document проваливался в текстовую ветку, где text пустой,
// и владелец получал уведомление с пустым "Сообщение:" вместо файла (30.07.2026).
function detectAttachment(m) {
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    return { method: 'sendPhoto', field: 'photo', fileId: m.photo[m.photo.length - 1].file_id, label: 'Фото' }
  }
  if (m.document) {
    const nm = m.document.file_name ? ` (${m.document.file_name})` : ''
    return { method: 'sendDocument', field: 'document', fileId: m.document.file_id, label: `Файл${nm}` }
  }
  if (m.video) return { method: 'sendVideo', field: 'video', fileId: m.video.file_id, label: 'Видео' }
  if (m.voice) return { method: 'sendVoice', field: 'voice', fileId: m.voice.file_id, label: 'Голосовое' }
  if (m.audio) return { method: 'sendAudio', field: 'audio', fileId: m.audio.file_id, label: 'Аудио' }
  if (m.video_note) return { method: null, label: 'Видео-кружок' }
  if (m.sticker) return { method: null, label: 'Стикер' }
  if (m.location) return { method: null, label: 'Геолокация' }
  if (m.contact) return { method: null, label: 'Контакт' }
  return null
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
    // Второй ключ — только для проверки цепочки «вебхук -> CRM» своим запросом.
    // Рабочий секрет при этом не меняется: если менять его, между обновлением Vercel и
    // setWebhook возникает окно, в котором сообщения живых клиентов молча отбрасываются.
    // Пустой ALT не должен пускать никого, поэтому сравниваем только при непустом значении.
    const okSecret = provided === WEBHOOK_SECRET ||
      (WEBHOOK_SECRET_ALT && provided === WEBHOOK_SECRET_ALT)
    if (!okSecret) {
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

  // === OWNER: /crm ===
  // Ссылка на пульт под рукой, чтобы не искать её в переписке. Заодно короткая
  // памятка — что именно в CRM делать, если открыл её с телефона на кладбище.
  if (ALL_OWNER_IDS.has(chatId) && /^\/crm/i.test(text)) {
    await sendMessage(chatId,
      '🗂 <b>CRM — заявки, переписка, работы</b>\n\n' +
      `${CRM_URL || 'https://crm.85-198-102-246.sslip.io'}\n\n` +
      '• <b>Инбокс</b> — кто написал и кто ждёт ответа\n' +
      '• <b>Календарь</b> — что делать сегодня и что просрочено\n' +
      '• <b>Доска</b> — заказы по статусам\n' +
      '• <b>Люди</b> — добавить мастера и выдать ему проекты\n\n' +
      'Вся переписка из бота и с сайта попадает туда сама. Отвечать можно и оттуда, ' +
      'и здесь ответом на уведомление — в карточке будет и то, и другое.',
      {}, incomingBotToken)
    return res.status(200).send('OK')
  }

  // === OWNER REPLY ===
  // Either Daniil OR Сергей (any of ALL_OWNER_IDS) replying counts.
  if (ALL_OWNER_IDS.has(chatId) && message.reply_to_message) {
    const replyToId = message.reply_to_message.message_id
    const replierChatId = chatId  // who's replying (for broadcasting to the other owner)
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

    // Path 1: web-chat session reply (find session by tg_root_message_id OR by
    // user_contact-encoded extra-owner msg_id).
    if (SUPABASE_SECRET) {
      let sessions = await sb(
        `web_chat_sessions?tg_root_message_id=eq.${replyToId}&select=id,status,source_url,user_contact`,
      )
      // If not found by primary tg_root_message_id, look up via extra-owner mapping.
      // Сергей's reply has reply_to_message.message_id = его копии notification,
      // которая записана в user_contact как "extra:<chat_id>:<msg_id>;..."
      if (!sessions || sessions.length === 0) {
        const pattern = `extra:%${replierChatId}:${replyToId}%`
        sessions = await sb(
          `web_chat_sessions?user_contact=ilike.${encodeURIComponent(pattern)}&select=id,status,source_url,user_contact`,
        )
      }
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
            await sendMessage(replierChatId, '❌ Не удалось загрузить фото в Storage. Попробуй ещё раз.', {
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

          await crmIngest({
            project_id: crmProject(sessionSite === 'kmh' ? 'kmh' : 'uhod'),
            web_session: session.id,
            direction: 'out',
            text: caption || '',
            media_kind: 'photo',
            media_ref: largestPhoto.file_id,
            author_label: replierChatId === OWNER_CHAT_ID ? 'Менеджер УходМогил' : 'Сергей',
            landing: session.source_url || null,
            source: 'чат на сайте',
          })
          // Подтверждение — реакцией на само сообщение владельца (и для альбома тоже:
          // иначе каждое фото из альбома отвечало отдельной строкой)
          await reactOk(replierChatId, message.message_id, sessionBotToken)
          // Broadcast photo notification to the other owner (без файла — у них уже было уведомление)
          const replierLabel = replierChatId === OWNER_CHAT_ID ? 'Daniil' : 'Сергей'
          await broadcastToOtherOwners(
            `📷 <b>${replierLabel} отправил фото клиенту</b> (сессия ${session.id.slice(0, 8)})`,
            replierChatId,
            sessionBotToken,
          )
          return res.status(200).send('OK')
        }

        // Текстовый reply
        await sb(
          `web_chat_messages`,
          'POST',
          { session_id: session.id, role: 'admin', content: text, tg_message_id: replyToId },
        )
        // И в CRM: разговор с сайта до сих пор жил только в Supabase, поэтому в карточке
        // была видна половина истории клиента — телеграм есть, чат с сайта нет.
        await crmIngest({
          project_id: crmProject(sessionSite === 'kmh' ? 'kmh' : 'uhod'),
          web_session: session.id,
          direction: 'out',
          text: text || '',
          author_label: replierChatId === OWNER_CHAT_ID ? 'Менеджер УходМогил' : 'Сергей',
          landing: session.source_url || null,
          source: 'чат на сайте',
        })
        await reactOk(replierChatId, message.message_id, sessionBotToken)
        // Broadcast to the OTHER owner so both Daniil and Sergey see the conversation.
        const replierLabel = replierChatId === OWNER_CHAT_ID ? 'Daniil' : 'Сергей'
        await broadcastToOtherOwners(
          `💬 <b>${replierLabel} ответил клиенту</b> (сессия ${session.id.slice(0, 8)}):\n\n${htmlEsc(text)}`,
          replierChatId,
          sessionBotToken,
        )
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
        const sent = await sendPhoto(
          customerChatId,
          largestPhoto.file_id,
          caption ? `💬 <b>${managerLabel}:</b>\n${htmlEsc(caption)}` : '',
          incomingBotToken,
        )
        // Отдельной строки "отправлено" больше нет — только реакция. Текстом отвечаем
        // лишь на провал: раньше подтверждение слалось безусловно и врало при ошибке.
        if (sent.ok) {
          await reactOk(replierChatId, message.message_id, incomingBotToken)
          // Ответ владельца из телеграма тоже должен попасть в карточку, иначе в CRM
          // будет видна только половина разговора.
          await crmIngest({
            project_id: crmProject(incomingBot),
            tg_chat_id: customerChatId,
            direction: 'out',
            text: caption || '',
            media_kind: 'photo',
            media_ref: largestPhoto.file_id,
            author_label: managerLabel,
            source: 'telegram',
          })
        } else {
          await sendMessage(replierChatId, `⚠️ Фото не доставлено: ${htmlEsc(sent.description || 'ошибка Telegram')}`, {
            reply_to_message_id: message.message_id,
          }, incomingBotToken)
        }
        return res.status(200).send('OK')
      }

      const sentText = await sendMessage(
        customerChatId,
        `💬 <b>${managerLabel}:</b>\n${htmlEsc(text)}`,
        {},
        incomingBotToken,
      )
      if (sentText.ok) {
        await reactOk(replierChatId, message.message_id, incomingBotToken)
        await crmIngest({
          project_id: crmProject(incomingBot),
          tg_chat_id: customerChatId,
          direction: 'out',
          text: text || '',
          author_label: managerLabel,
          source: 'telegram',
        })
      } else {
        await sendMessage(replierChatId, `⚠️ Ответ не доставлен: ${htmlEsc(sentText.description || 'ошибка Telegram')}`, {
          reply_to_message_id: message.message_id,
        }, incomingBotToken)
      }
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
        '🔎 Не знаете, где похоронен близкий? Напишите ФИО и кладбище — поищем и ответим.\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru\n' +
        '📢 Наш канал с фотоотчётами и календарём поминальных дней: <a href="https://t.me/uhod_mogil">t.me/uhod_mogil</a>',
        {}, incomingBotToken,
      )
      // Карточку заводим уже на /start. Человек, открывший бота и замолчавший, — это
      // всё равно лид: раньше он не оставлял следа нигде, и вспомнить о нём было нечем.
      await crmIngest({
        project_id: crmProject(incomingBot),
        tg_chat_id: chatId,
        tg_username: from.username || null,
        name: name || null,
        text: 'Открыл бота (/start)',
        tg_msg_id: message.message_id,
        source: 'telegram',
      })
      return res.status(200).send('OK')
    }


    const usernameLine = from.username ? `📎 @${htmlEsc(from.username)}\n` : ''
    const langLine = from.language_code ? `🗣 Язык: ${htmlEsc(from.language_code)}\n` : ''
    const tgSourceLine = `✈️ Источник: Telegram-бот (напрямую)\n`
    const botLabel = incomingBot === 'kmh' ? 'Kiss My Hands' : 'УходМогил'

    // Если клиент прислал вложение (фото / файл / видео / голосовое) — пересылаем
    // тебе в TG как уведомление (через тот же бот)
    const att = detectAttachment(message)
    if (att) {
      const info =
        `📨 <b>${htmlEsc(att.label)} от клиента — ${botLabel}</b>\n\n` +
        tgSourceLine +
        `👤 ${htmlEsc(name)}\n` +
        usernameLine + langLine +
        (caption ? `💬 ${htmlEsc(caption)}\n\n` : '') +
        `chatid: ${chatId}\n\n` +
        `↩️ <i>Ответ на это сообщение (включая фото) — пересылается клиенту</i>`

      let delivered = false
      if (att.method) {
        const r = await sendMediaByFileId(OWNER_CHAT_ID, att.method, att.field, att.fileId, info, incomingBotToken)
        delivered = !!r.ok
      } else {
        // кружок/стикер/гео: caption не поддерживается — копия + отдельная карточка с chatid
        const r = await copyMessage(OWNER_CHAT_ID, chatId, message.message_id, incomingBotToken)
        delivered = !!r.ok
        if (delivered) await sendMessage(OWNER_CHAT_ID, info, {}, incomingBotToken)
      }

      // Вложение не доехало — владелец обязан узнать о сообщении, иначе лид теряется молча.
      if (!delivered) {
        await sendMessage(
          OWNER_CHAT_ID,
          info + `\n\n⚠️ <i>Вложение переслать не удалось — открой чат клиента вручную</i>`,
          {}, incomingBotToken,
        )
      }
      await crmIngest({
        project_id: crmProject(incomingBot),
        tg_chat_id: chatId,
        tg_username: from.username || null,
        name: name || null,
        // Клиент нажал «поделиться контактом» — номер должен оказаться в карточке,
        // а не только в тексте уведомления. Без этого оператор ищет телефон глазами
        // по переписке, а звонить надо сейчас.
        contact: message.contact ? (message.contact.phone_number || null) : null,
        text: caption || (message.contact
          ? `Прислал контакт: ${message.contact.phone_number || ''}`.trim()
          : ''),
        media_kind: att.label || 'attachment',
        media_ref: att.fileId || null,
        tg_msg_id: message.message_id,
        source: 'telegram',
      })
      return res.status(200).send('OK')
    }

    // Текстовое сообщение
    await sendMessage(
      OWNER_CHAT_ID,
      `📨 <b>Новое сообщение от клиента — ${botLabel}</b>\n\n` +
        tgSourceLine +
        `👤 Имя: ${htmlEsc(name)}\n` +
        usernameLine + langLine +
        `💬 Сообщение: ${htmlEsc(text) || '<i>(без текста)</i>'}\n\n` +
        `chatid: ${chatId}\n\n` +
        `↩️ <i>Нажми "Ответить" на это сообщение чтобы написать клиенту</i>`,
      {}, incomingBotToken,
    )
    await crmIngest({
      project_id: crmProject(incomingBot),
      tg_chat_id: chatId,
      tg_username: from.username || null,
      name: name || null,
      text: text || '',
      tg_msg_id: message.message_id,
      source: 'telegram',
    })

    // В сообщении клиента есть ФИО (и, если повезло, кладбище) — заранее поднимаем
    // выписку из реестра и кладём ЕЁ ТЕБЕ, следом за уведомлением. Клиенту не уходит
    // ничего: совпадение по ФИО это ещё не та могила, а сверять её с присланным фото
    // памятника всё равно человеку. Ты решаешь, писать клиенту или сначала уточнить.
    // quiet: не разобрали или не нашли — молчим совсем, в том числе в карточке.
    if (incomingBot !== 'kmh' && text && text.length >= 12) {
      const g = await crmGrave({
        project_id: crmProject(incomingBot),
        tg_chat_id: chatId,
        tg_username: from.username || null,
        name: name || null,
        text,
        quiet: true,
      })
      const found = graveReply(g)
      if (found) {
        const cardLink = g.client_id && CRM_URL
          ? `\n\n🗂 <a href="${CRM_URL.replace(/\/+$/, '')}/#c${g.client_id}">Карточка в CRM</a>` +
            (g.photos ? ` — там же ${g.photos} фото от клиента, есть с чем сверить` : '')
          : ''
        await sendMessage(OWNER_CHAT_ID,
          `${found}\n\n` +
          (g.cemetery ? '' : '⚠️ Кладбище в сообщении не названо — это совпадения по всей Москве.\n') +
          `chatid: ${chatId}${cardLink}\n\n` +
          '↩️ <i>Клиенту это НЕ отправлено. Ответьте на это сообщение, если хотите переслать ' +
          'или уточнить — уйдёт клиенту.</i>',
          {}, incomingBotToken)
      }
    }
  }

  res.status(200).send('OK')
}
