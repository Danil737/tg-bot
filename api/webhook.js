const {
  fetchWithTimeout, safeLog,
  crmGraveSearch, crmGravePick, crmClients,
  htmlToPlain, graveOwnerText, graveClientText, graveKeyboard, graveClientLabel, graveShown,
  graveCopyText, graveConfirmKeyboard, graveRow, chatStore,
  looksLikeGraveText,
} = require('./_lib')

const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
// Второй аккаунт Daniil (@danil_msk_02) — полноправный владелец uhod-бота: заводит заказы,
// ищет могилы, отвечает клиентам. Список через env, дефолт = его id.
const EXTRA_OWNER_IDS = (process.env.EXTRA_OWNER_IDS || '5783316378')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
const DANIIL_IDS = [OWNER_CHAT_ID, ...EXTRA_OWNER_IDS]   // все аккаунты Daniil (ветка заказа — только они, без Сергея)
const KMH_EXTRA_OWNER_IDS = (process.env.KMH_EXTRA_OWNER_IDS || '1650405909')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
const ALL_OWNER_IDS = new Set([OWNER_CHAT_ID, ...EXTRA_OWNER_IDS, ...KMH_EXTRA_OWNER_IDS])
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

// Новый заказ из пересланного владельцем сообщения. Отдельная ручка, а не /api/ingest:
// там ключ склейки — чат клиента, которого при пересылке нет. Альбом (media_group_id)
// прилетает несколькими вызовами Vercel — склейку в одну карточку делает CRM (единый
// процесс), вебхук лишь помечает каждое фото группой. created=true придёт только тому
// вызову, что реально создал карточку, — по нему и шлём ссылку, иначе на альбом из 5 фото
// прилетело бы 5 ссылок.
async function crmCreateOrder(payload) {
  if (!CRM_URL || !CRM_SECRET) return null
  try {
    const ctrl = new AbortController()
    const kill = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(CRM_URL.replace(/\/+$/, '') + '/api/bot/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': CRM_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(kill)
    if (!r.ok) { safeLog('crm.order=' + r.status, { status: r.status }); return null }
    return await r.json()
  } catch (e) {
    safeLog('crm.order.fail', { error: String(e && e.message || e).slice(0, 120) })
    return null
  }
}

// Поиск захоронения и разбор выдачи — в api/_lib.js (crmGraveSearch/graveOwnerText):
// тот же код нужен и вебхуку, и чату на сайте.

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


async function answerCallback(callbackId, text, botToken = BOT_TOKEN, alert = false) {
  try {
    await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId, text: text || '', show_alert: !!alert }),
      },
      6000,
    )
  } catch (e) {
    safeLog('answerCallbackQuery failed', { err: e.message })
  }
}

async function editReplyMarkup(chatId, messageId, markup, botToken = BOT_TOKEN) {
  try {
    await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: markup }),
      },
      6000,
    )
  } catch (e) {
    safeLog('editMessageReplyMarkup failed', { err: e.message })
  }
}

// Выписка владельцу — из трёх мест: клиент написал в бота, клиент написал в чат на сайте,
// я сам принёс текст (переслал из вацапа/MAX) или позвал /mogila. Формат один.
async function sendGraveToOwner(toChatId, g, botToken, clientId, origin, customerChatId, quietIfNoFio) {
  // ФИО в тексте не разобрано (или CRM молчит) — на моё СВОБОДНОЕ сообщение отвечать
  // нечем и незачем: «кладбище» и «участок» я пишу в чат и по другим поводам, а лишний
  // ответ на каждый из них быстро приучает не читать бота. Явный /mogila — другое дело.
  if (!g || g.need === 'fio') {
    // Молчать нельзя: 05.08 запрос «Домодедовское кладбище. Бялясинский» остался без
    // единого слова в ответ, и со стороны это неотличимо от проглоченного сообщения.
    // Ответ короткий — если текст был не про поиск, одна строка не мешает.
    await sendMessage(toChatId,
      !g
        ? '⚠️ CRM не ответила — поиск по реестру сейчас недоступен.'
        : '🔎 Не понял, кого искать. Хватит одной фамилии от 4 букв:\n' +
          '<code>/mogila Фамилия, кладбище</code>',
      {}, botToken)
    return
  }
  const found = graveOwnerText(g, origin)
  if (!found) {
    const who = g && g.fio ? ` по «${htmlEsc(g.fio)}»` : ''
    // Пустой список значит две разные вещи. Реестр отдаёт ошибку молча — пустым
    // ответом с source «error:», — и раньше сбой сети выглядел как достоверное
    // «могилы в реестре нет». Для владельца это противоположные выводы.
    await sendMessage(toChatId,
      g.degraded
        ? `⚠️ Реестр захоронений не ответил${who} — поиск НЕ выполнен.\n\n` +
          '<i>Это сбой сайта реестра, а не отсутствие записи. Повторить: /mogila с тем же текстом.</i>'
        : `🔎 В реестре захоронений ничего не нашлось${who}.\n\n` +
          '<i>Реестр открытый и неполный: у части старых могил надпись в нём не заведена. ' +
          'Уточнить можно в конторе кладбища или на выезде.</i>',
      {}, botToken)
    return
  }
  const cardLink = g.client_id && CRM_URL
    ? `\n🗂 <a href="${CRM_URL.replace(/\/+$/, '')}/#c${g.client_id}">Карточка в CRM</a>` +
      (g.photos ? ` — там же ${g.photos} фото от клиента, есть с чем сверить` : '')
    : ''
  await sendMessage(toChatId,
    found +
    (g.cemetery ? '' : '\n\n⚠️ Кладбище не названо — это совпадения по всей Москве.') +
    (customerChatId ? `\n\nchatid: ${customerChatId}` : '') +
    cardLink +
    '\n\n↩️ <i>Клиенту не отправлено. «📋 Текст» — скопировать для MAX, вацапа или мастера; «📤 Клиенту» — отправить отсюда, спросит подтверждение.</i>',
    { disable_web_page_preview: true, ...graveKeyboard(g, clientId) },
    botToken)
}

// Кнопки под выпиской. В callback_data влезает 64 байта, поэтому в них только gid
// захоронения и id карточки — текст клиенту собирается заново в момент нажатия.
async function handleGraveCallback(cq, incomingBot, botToken) {
  const data = String(cq.data || '')
  const chatId = cq.message?.chat?.id
  const msgId = cq.message?.message_id
  if (!ALL_OWNER_IDS.has(cq.from?.id)) {
    await answerCallback(cq.id, 'Кнопка только для владельца', botToken, true)
    return
  }
  if (data === 'noop') {
    await answerCallback(cq.id, '', botToken)
    return
  }

  // Шаг 1: выписку я поднял своим сообщением — бот не знает, о каком клиенте речь.
  if (data.startsWith('gc:')) {
    const gid = data.slice(3)
    const clients = await crmClients(crmProject(incomingBot), { limit: 6 })
    if (!clients.length) {
      await answerCallback(cq.id, 'В CRM нет карточек — некому отправить', botToken, true)
      return
    }
    const rows = clients.map((c) => [{
      text: `👤 ${graveClientLabel(c)}`,
      callback_data: `gs:${gid}:${c.id}`,
    }])
    rows.push([{ text: '⬅️ Не отправлять', callback_data: 'noop' }])
    await editReplyMarkup(chatId, msgId, { inline_keyboard: rows }, botToken)
    await answerCallback(cq.id, 'Кому отправить?', botToken)
    return
  }

  // Текст для копирования: клиент может сидеть в MAX или вацапе, куда бот не пишет,
  // да и мастеру место отправляется руками.
  if (data.startsWith('gt:')) {
    const pick = await crmGravePick(data.slice(3))
    if (!pick || !pick.ok) {
      await answerCallback(cq.id, 'Не нашёл данные — открой карточку в CRM', botToken, true)
      return
    }
    await sendMessage(chatId, graveCopyText(pick.result), { disable_web_page_preview: true }, botToken)
    await answerCallback(cq.id, 'Ниже — нажми на текст, скопируется', botToken)
    return
  }

  // Раскрыть вариант из списка: отдельная карточка со своими кнопками.
  if (data.startsWith('gp:')) {
    const [, gid, cid] = data.split(':')
    const pick = await crmGravePick(gid)
    if (!pick || !pick.ok) {
      await answerCallback(cq.id, 'Не нашёл данные — открой карточку в CRM', botToken, true)
      return
    }
    await sendMessage(chatId, `🔎 <b>Вариант из списка</b>\n\n${graveRow(pick.result, true)}`,
      { disable_web_page_preview: true, ...graveKeyboard([pick.result], cid ? Number(cid) : null) },
      botToken)
    await answerCallback(cq.id, '', botToken)
    return
  }

  // Отмена подтверждения — возвращаем обычные кнопки.
  if (data.startsWith('gx:')) {
    const [, gid, cid] = data.split(':')
    const pick = await crmGravePick(gid)
    if (pick && pick.ok) {
      const kb = graveKeyboard([pick.result], Number(cid))
      await editReplyMarkup(chatId, msgId, kb.reply_markup, botToken)
    }
    await answerCallback(cq.id, 'Отменено, клиенту ничего не ушло', botToken)
    return
  }

  // Шаг 2: показываем, ЧТО и КОМУ уйдёт. Сама отправка — только по «Да».
  if (data.startsWith('gs:')) {
    const [, gid, cid] = data.split(':')
    const pick = await crmGravePick(gid)
    const r = pick && pick.ok ? pick.result : null
    const client = (await crmClients(crmProject(incomingBot), { id: Number(cid) }))[0]
    if (!r || !client) {
      await answerCallback(cq.id, 'Не нашёл данные — открой карточку в CRM', botToken, true)
      return
    }
    await editReplyMarkup(chatId, msgId, graveConfirmKeyboard(r, client), botToken)
    await answerCallback(cq.id, 'Проверьте кому — и подтвердите', botToken)
    return
  }

  // Шаг 3: подтверждено — отправка тем же каналом, которым клиент пишет сам.
  if (data.startsWith('gy:')) {
    const [, gid, cid] = data.split(':')
    const pick = await crmGravePick(gid)
    const r = pick && pick.ok ? pick.result : null
    const found = await crmClients(crmProject(incomingBot), { id: Number(cid) })
    const client = found[0]
    if (!r || !client) {
      await answerCallback(cq.id, 'Не нашёл данные — открой карточку в CRM', botToken, true)
      return
    }
    const body = graveClientText(r)
    let ok = false
    if (client.tg_chat_id) {
      const sent = await sendMessage(client.tg_chat_id, body, { disable_web_page_preview: true }, botToken)
      ok = !!sent.ok
    } else if (client.web_session) {
      // return=representation обязателен: на обычной вставке Supabase отвечает пустым
      // телом, sb() отдаёт null — и успешная отправка была бы прочитана как отказ.
      const w = await chatStore.message({
        session_id: client.web_session, role: 'admin', text: htmlToPlain(body),
      })
      ok = !!(w && w.ok)
      if (ok) {
        await sb('web_chat_messages', 'POST', {
          session_id: client.web_session, role: 'admin', content: htmlToPlain(body),
        }).catch(() => {})
      }
    }
    if (!ok) {
      await answerCallback(cq.id, 'Отправить не удалось — открой карточку в CRM', botToken, true)
      return
    }
    // Веб-клиенту выписка уже записана chatStore.message; телеграм-клиенту пишем ingest'ом.
    if (client.tg_chat_id) {
      await crmIngest({
        project_id: client.project_id || crmProject(incomingBot),
        tg_chat_id: client.tg_chat_id,
        direction: 'out',
        text: htmlToPlain(body),
        author_label: 'Выписка из реестра · отправлена клиенту',
        source: 'telegram',
      })
    }
    await editReplyMarkup(chatId, msgId, {
      inline_keyboard: [[{ text: `✅ Отправлено — ${graveClientLabel(client)}`, callback_data: 'noop' }]],
    }, botToken)
    await answerCallback(cq.id, '✅ Отправлено клиенту', botToken)
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

  // Нажатие кнопки под выпиской. allowed_updates вебхука callback_query уже включает.
  const { message, callback_query: callbackQuery } = req.body || {}
  if (callbackQuery) {
    await handleGraveCallback(callbackQuery, incomingBot, incomingBotToken)
    return res.status(200).send('OK')
  }
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
    // Сессию ищем в CRM — она основное хранилище чата с сайта. Supabase остаётся
    // запасным путём и единственным местом, где живёт раскладка уведомлений Сергея.
    {
      const viaCrm = await chatStore.byRoot(replyToId)
      let sessions = viaCrm && viaCrm.ok
        ? [{ id: viaCrm.session_id, status: viaCrm.status, source_url: viaCrm.landing, user_contact: null }]
        : null
      if (!sessions && SUPABASE_SECRET) {
        sessions = await sb(
          `web_chat_sessions?tg_root_message_id=eq.${replyToId}&select=id,status,source_url,user_contact`,
        )
      }
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

          await chatStore.message({
            session_id: session.id, role: 'admin', text: caption || '',
            tg_msg_id: replyToId, media_kind: 'photo', media_ref: photoUrl,
          })
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
          ).catch(() => {})

          // в CRM это уже записано выше через chatStore.message — второй раз не надо
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
        const saved = await chatStore.message({
          session_id: session.id, role: 'admin', text, tg_msg_id: replyToId,
        })
        // chatStore.message при любом сбое возвращает null, а не бросает исключение.
        // Раньше следом безусловно ставилась ✅, и владелец был уверен, что клиент
        // получил ответ, — хотя записать его было некуда и клиент не увидит ничего.
        if (!saved || !saved.ok) {
          await sendMessage(
            replierChatId,
            '❌ <b>Ответ НЕ сохранился</b> — клиент его не увидит.\n\n' +
            `<i>CRM не приняла запись. Текст цел, повтори отправку:</i>\n<code>${htmlEsc(text)}</code>`,
            { reply_to_message_id: message.message_id },
            sessionBotToken,
          )
          return res.status(200).send('OK')
        }
        await sb(
          `web_chat_messages`,
          'POST',
          { session_id: session.id, role: 'admin', content: text, tg_message_id: replyToId },
        ).catch(() => {})
        // в CRM это уже записано выше через chatStore.message — второй раз не надо
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

  // === OWNER: пересланное сообщение / фото / «/zakaz» → новый заказ в CRM ===
  // Daniil переслал переписку из вацапа/MAX/TG (текст+фото) — заводим карточку заказа и
  // отвечаем ссылкой #c<id>. Кладбище и вид работ CRM определит из текста сама. Триггеры:
  //   • пересылка (forward_*) — основной, ловит и альбом (склейка по media_group_id в CRM);
  //   • любое вложение вне ответа (одиночное фото или элемент альбома без подписи);
  //   • «/zakaz …» — для текста, скопированного из вацапа (там метки пересылки нет).
  // Гейт по OWNER_CHAT_ID, чтобы не менять поток Сергея. Reply-ветка уже вернула ответ
  // выше — сюда доходит только не-ответ. Grave-поиск владельца остаётся на /mogila и на
  // текстовой ветке ниже: простой текст (без пересылки/вложения/zakaz) сюда не попадает.
  const isForward = !!(message.forward_origin || message.forward_from ||
    message.forward_sender_name || message.forward_date)
  const zakazText = /^\/zakaz(@\w+)?\b/i.test(text) ? text.replace(/^\/zakaz(@\w+)?\s*/i, '')
    : /^\/zakaz(@\w+)?\b/i.test(caption) ? caption.replace(/^\/zakaz(@\w+)?\s*/i, '') : null
  const orderAtt = (!message.reply_to_message) ? detectAttachment(message) : null
  if (DANIIL_IDS.includes(chatId) && !message.reply_to_message &&
      (isForward || orderAtt || zakazText !== null) && CRM_URL && CRM_SECRET) {
    const body = (zakazText !== null ? zakazText : (text || caption || '')).trim()
    // Медиа кладём только у пересылаемых типов с file_id (фото/файл/видео/голос/аудио);
    // у кружка/стикера/гео method=null — карточку заведём по тексту, вложение пропустим.
    const mediaRef = orderAtt && orderAtt.method ? orderAtt.fileId : null
    const created = await crmCreateOrder({
      project_id: crmProject(incomingBot),
      text: body,
      media_group_id: message.media_group_id || null,
      media_ref: mediaRef,
      media_kind: orderAtt ? orderAtt.label : null,
      tg_msg_id: message.message_id,
      author_label: 'Переслал Daniil',
      source: isForward ? 'forward' : zakazText !== null ? 'zakaz' : 'forward',
    })
    if (created && created.created && created.client_id) {
      const link = CRM_URL.replace(/\/+$/, '') + '/#c' + created.client_id
      await sendMessage(chatId,
        `🗂 <b>Заказ создан</b> — <a href="${link}">#${created.client_id} в CRM</a>\n\n` +
        'Кладбище и вид работ определятся из текста, фото уже в карточке. ' +
        'Ссылку можно переслать мастеру. Поиск могилы по этому заказу — <code>/mogila Фамилия, кладбище</code>.',
        { disable_web_page_preview: true }, incomingBotToken)
    } else if (!created) {
      // Только когда карточку реально не завели. Для второго+ фото альбома created=false —
      // это не ошибка, молчим (карточка уже есть, фото добавилось).
      await sendMessage(chatId,
        '⚠️ CRM не приняла заказ — карточка не создана. Проверь CRM или повтори.',
        {}, incomingBotToken)
    }
    return res.status(200).send('OK')
  }

  // === OWNER: /mogila ===
  // Явный поиск: «/mogila Морозов Дмитрий Иванович, Домодедовское».
  if (ALL_OWNER_IDS.has(chatId) && /^\/mogila/i.test(text)) {
    const q = text.replace(/^\/mogila(@\w+)?/i, '').trim()
    if (!q) {
      await sendMessage(chatId,
        '🔎 <b>Поиск захоронения</b>\n\n' +
        '<code>/mogila Фамилия Имя Отчество, кладбище</code>\n\n' +
        'Кладбище можно не писать — тогда ищу по всей Москве и области. ' +
        'Найденное отправляется клиенту кнопкой, вручную набирать ничего не нужно.',
        {}, incomingBotToken)
      return res.status(200).send('OK')
    }
    const parts = q.split(',').map((s) => s.trim()).filter(Boolean)
    const payload = { project_id: crmProject(incomingBot) }
    if (parts.length >= 2) {
      payload.fio = parts[0]
      payload.cemetery = parts[1]
    } else {
      payload.text = q
    }
    const g = await crmGraveSearch(payload)
    await sendGraveToOwner(chatId, g, incomingBotToken, null, 'по запросу /mogila')
    return res.status(200).send('OK')
  }

  // === OWNER: данные покойного, присланные мной ===
  // Клиент часто пишет не в бота, а в вацап, MAX или звонит — я переношу его текст сюда.
  // 01.08.2026 такое сообщение (участок 23, две ФИО, Домодедовское) осталось без ответа
  // именно потому, что поиск стоял только на клиентской ветке.
  if (ALL_OWNER_IDS.has(chatId) && incomingBot !== 'kmh' && text && !text.startsWith('/') &&
      looksLikeGraveText(text)) {
    const g = await crmGraveSearch({ project_id: crmProject(incomingBot), text })
    // false: на свой запрос владелец получает ответ всегда, даже «не понял, кого искать».
    await sendGraveToOwner(chatId, g, incomingBotToken, null, 'по вашему сообщению', null, false)
    return res.status(200).send('OK')
  }

  // === CUSTOMER MESSAGE in direct TG ===
  // Гейт по ВСЕМ владельцам, а не только основному: со вторым аккаунтом Daniil
  // (@danil_msk_02) или Сергеем (KMH) обычное сообщение владельца иначе заводит
  // ложную клиентскую карточку и шлёт «лид» самому себе.
  if (!ALL_OWNER_IDS.has(chatId)) {
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
        'Убираем и ухаживаем за могилами на кладбищах Москвы и области.\n\n' +
        '📸 <b>Начните с фото могилы</b> — пришлите его прямо сюда. По фото сразу видно объём работ, поэтому цену назовём в первом же ответе — и заодно найдём сам участок.\n\n' +
        'Если фото нет — напишите кладбище, а если знаете, то участок, ФИО усопшего и даты рождения и смерти. По ним постараемся найти захоронение в нашей базе реестров — точные даты помогают больше всего.\n\n' +
        '✅ Фотоотчёт до и после\n' +
        '✅ Выезд 1–3 дня\n' +
        '✅ Цены от 3 000 ₽\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru\n' +
        '💬 Можно писать и в WhatsApp или MAX: +7 930 400 92 36 — удобно слать фото.',
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
      const g = await crmGraveSearch({
        project_id: crmProject(incomingBot),
        tg_chat_id: chatId,
        tg_username: from.username || null,
        name: name || null,
        text,
        quiet: true,
      })
      if (graveOwnerText(g)) {
        await sendGraveToOwner(OWNER_CHAT_ID, g, incomingBotToken, g.client_id,
          'по сообщению клиента', chatId)
      }
    }
  }

  res.status(200).send('OK')
}
