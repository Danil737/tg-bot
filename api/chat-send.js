// POST /api/chat/send
// Body: { sessionId?, message, sourceUrl?, userAgent? }
// Returns: { sessionId, aiReply?, escalated }
//
// Flow:
//   1. Find or create chat session
//   2. Save user message
//   3. Get conversation history → ask Groq (llama-3.3-70b-versatile) for next reply
//   4. Save AI reply
//   5. If AI message contains escalation marker → notify owner in TG, mark session escalated
//   6. Always send a copy/notification to TG (silent for active sessions, loud for escalations)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const BOT_TOKEN = process.env.BOT_TOKEN
const OWNER_CHAT_ID = 696698928

const ESCALATION_MARKER = 'Передаю менеджеру'

const ALLOWED_ORIGINS = [
  'https://uhod-mogil.ru',
  'https://www.uhod-mogil.ru',
  'http://localhost:3000',
]

const SYSTEM_PROMPT = `Ты — ассистент-секретарь компании УходМогил (uhod-mogil.ru), сервис уборки и ухода за могилами на кладбищах Москвы и Подмосковья.

ТВОЯ ЕДИНСТВЕННАЯ ЗАДАЧА: за 2-3 коротких сообщения собрать минимальную информацию о запросе клиента и передать менеджеру. Не пытайся продать, не давай длинных консультаций.

КЛЮЧЕВЫЕ ВОПРОСЫ (задавай по одному, начиная с того, что ещё не выяснено):
1. Что нужно сделать? (уборка / покраска ограды / чистка памятника / другое)
2. На каком кладбище?
3. Контакт для связи (телефон, WhatsApp или Telegram)

ЦЕНЫ — отвечай только если спрашивают:
- Разовая уборка: от 3 500 ₽
- Сезонный уход (4 раза в год): 12 000 ₽
- Годовое обслуживание (12 уборок): 30 000 ₽
- Дополнительные услуги (покраска ограды, чистка мрамора, посадка цветов, мраморная крошка): рассчитываем индивидуально по фото

ПРАВИЛА:
- Каждый ответ — 1-3 коротких предложения
- НЕ используй эмодзи в каждом сообщении (максимум 1 эмодзи на 3-4 ответа)
- Не обещай конкретных дат и точных цен на доп.услуги — это решает менеджер
- Если клиент просит «человека», «менеджера», «специалиста» — сразу передавай менеджеру
- Если клиент пишет что-то вне темы (погода, философия, оскорбления) — мягко вернись к делу

ЗАВЕРШЕНИЕ: когда у тебя есть {услуга + кладбище + контакт}, ИЛИ клиент явно просит человека, ИЛИ клиент уже описал ситуацию и попросил перезвонить — заверши ответ ровно фразой:

✓ Передаю менеджеру. Свяжемся с вами в течение 5 минут.

После этой фразы НЕ задавай больше вопросов — менеджер подключится сам.`

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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function getSession(sessionId) {
  const rows = await sb(`web_chat_sessions?id=eq.${sessionId}&select=*`)
  return rows?.[0] || null
}

async function createSession(meta) {
  const rows = await sb(
    `web_chat_sessions`,
    'POST',
    {
      source_url: meta.sourceUrl?.slice(0, 500) || null,
      user_agent: meta.userAgent?.slice(0, 500) || null,
    },
    'return=representation',
  )
  return rows[0]
}

async function getRecentMessages(sessionId, limit = 30) {
  return await sb(
    `web_chat_messages?session_id=eq.${sessionId}&order=created_at.asc&limit=${limit}&select=role,content,created_at,tg_message_id`,
  )
}

async function saveMessage(sessionId, role, content, tgMessageId = null) {
  const rows = await sb(
    `web_chat_messages`,
    'POST',
    { session_id: sessionId, role, content, tg_message_id: tgMessageId },
    'return=representation',
  )
  return rows[0]
}

async function setSessionEscalated(sessionId, tgRootMessageId) {
  await sb(
    `web_chat_sessions?id=eq.${sessionId}`,
    'PATCH',
    { status: 'escalated', tg_root_message_id: tgRootMessageId },
  )
}

async function aiReply(history, userMessage) {
  // Groq использует OpenAI-совместимый формат. Admin-сообщения исключаем —
  // это реплики менеджера через TG, AI не должен делать вид что их помнит.
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const m of history) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content })
    else if (m.role === 'ai') messages.push({ role: 'assistant', content: m.content })
  }
  messages.push({ role: 'user', content: userMessage })

  const body = {
    model: GROQ_MODEL,
    messages,
    // temperature 0.2: бот должен следовать жёсткому скрипту (сбор лида),
    // а не творчески импровизировать цены/услуги
    temperature: 0.2,
    max_tokens: 300,
    top_p: 0.9,
  }

  // Retry с exponential backoff: 0ms → 600ms → 1500ms. Groq иногда отдаёт 5xx/429,
  // но обычно следующая попытка проходит. Если все 3 попытки упали — бросаем,
  // вызывающий код переведёт чат на менеджера (escalation fallback).
  const delays = [0, 600, 1500]
  let lastErr = null
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) {
        console.error(`Groq error (delay=${delay}):`, JSON.stringify(data).slice(0, 400))
        // 4xx (кроме 429) — не retry'им, это наша ошибка запроса
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          throw new Error(`Groq ${r.status} (no retry)`)
        }
        lastErr = new Error(`Groq ${r.status}`)
        continue
      }
      const text = data?.choices?.[0]?.message?.content?.trim()
      if (!text) {
        lastErr = new Error('Groq: empty response')
        continue
      }
      return text
    } catch (err) {
      lastErr = err
      console.error(`Groq fetch err (delay=${delay}):`, err.message)
    }
  }
  throw lastErr || new Error('Groq: all retries failed')
}

function escapeMd(s) {
  return String(s || '').replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')
}

async function tgSendOwner(text, replyMarkup = null) {
  const body = {
    chat_id: OWNER_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  }
  if (replyMarkup) body.reply_markup = replyMarkup
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json()
  if (!data.ok) console.error('TG sendMessage failed:', data)
  return data.result?.message_id || null
}

async function notifyOwnerEscalation(session, history) {
  // Build summary for owner
  const dialogue = history
    .map((m) => {
      const tag = m.role === 'user' ? '👤' : m.role === 'ai' ? '🤖' : '👨‍💼'
      return `${tag} ${m.content}`
    })
    .join('\n\n')
  const text =
    `🆕 *НОВЫЙ ЧАТ С САЙТА*  \\(${escapeMd(session.id.slice(0, 8))}\\)\n\n` +
    `_Источник:_ ${escapeMd(session.source_url || 'uhod-mogil.ru')}\n\n` +
    `*Диалог:*\n${escapeMd(dialogue).slice(0, 3500)}\n\n` +
    `_Ответь на это сообщение \\(reply\\) — клиент увидит на сайте\\._`
  const messageId = await tgSendOwner(text)
  if (messageId) {
    await setSessionEscalated(session.id, messageId)
  }
  return messageId
}

module.exports = async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const { sessionId: incomingSessionId, message, sourceUrl, userAgent } = req.body || {}
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Empty message' })
    }
    if (message.length > 4000) {
      return res.status(400).json({ ok: false, error: 'Message too long' })
    }

    let session
    if (incomingSessionId) {
      session = await getSession(incomingSessionId)
    }
    if (!session) {
      session = await createSession({ sourceUrl, userAgent })
    }

    // Save user message
    await saveMessage(session.id, 'user', message.trim())

    // Don't AI-reply if session is escalated — admin handles it now
    if (session.status === 'escalated') {
      // Notify owner about new follow-up message
      if (BOT_TOKEN) {
        const text =
          `💬 *Новое сообщение в чате* \\(${escapeMd(session.id.slice(0, 8))}\\)\n\n` +
          `👤 ${escapeMd(message.slice(0, 1000))}\n\n` +
          `_Reply на это сообщение → клиент увидит\\._`
        const tgMessageId = await tgSendOwner(text)
        // Update session's tg_root_message_id so latest message becomes the new reply target
        if (tgMessageId) {
          await sb(`web_chat_sessions?id=eq.${session.id}`, 'PATCH', {
            tg_root_message_id: tgMessageId,
          })
        }
      }
      return res.status(200).json({ ok: true, sessionId: session.id, escalated: true })
    }

    // AI reply path
    const history = await getRecentMessages(session.id, 30)
    // history includes the just-saved user message (last); send to AI WITHOUT it (it's 'userMessage' separately)
    const historyForAI = history.slice(0, -1).filter((m) => m.role === 'user' || m.role === 'ai')

    let aiText = ''
    let escalate = false
    try {
      aiText = await aiReply(historyForAI, message.trim())
    } catch (err) {
      console.error('AI failed, fallback escalation:', err.message)
      aiText = '✓ Передаю менеджеру. Свяжемся с вами в течение 5 минут.'
      escalate = true
    }

    await saveMessage(session.id, 'ai', aiText)

    // Detect escalation marker
    if (aiText.includes(ESCALATION_MARKER) || aiText.startsWith('✓')) {
      escalate = true
    }

    if (escalate && BOT_TOKEN) {
      const fullHistory = await getRecentMessages(session.id, 30)
      await notifyOwnerEscalation(session, fullHistory)
    }

    return res.status(200).json({
      ok: true,
      sessionId: session.id,
      aiReply: aiText,
      escalated: escalate,
    })
  } catch (e) {
    console.error('chat-send error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
