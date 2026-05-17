// GET /api/newsletter-check?secret=<NEWSLETTER_CRON_SECRET>
//
// Called daily by cron on KZ server. Checks if any major memorial day is
// coming up in 7 days. If yes — notifies owner in TG with subscriber list
// and template, so Daniil can send the actual newsletter via his email client.
//
// Why not send emails directly? — No ESP set up yet (no Resend/Mailgun API key).
// This is the MVP: human-in-the-loop. Replace with auto-send when ESP available.

const { fetchWithTimeout } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const BOT_TOKEN = process.env.BOT_TOKEN
const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const CRON_SECRET = process.env.NEWSLETTER_CRON_SECRET

// Hardcoded memorial days for 2026-2027. Keep in sync with lib/memorialDays.ts on site.
// Only "high priority" days get newsletters — Радоница, Троицкая суббота, Покров, Дмитриевская.
const MEMORIAL_DAYS = [
  { isoDate: '2026-05-30', name: 'Троицкая родительская суббота', landingPath: '/uborka-mogily-pered-troicej', daysBeforeNotify: 7 },
  { isoDate: '2026-05-31', name: 'Троица (Пятидесятница)', landingPath: '/uborka-mogily-pered-troicej', daysBeforeNotify: 7 },
  { isoDate: '2026-08-28', name: 'Успение Богородицы', landingPath: '/seasonalniy/uborka-mogily-pered-uspeniem', daysBeforeNotify: 10 },
  { isoDate: '2026-10-10', name: 'Покровская родительская суббота', landingPath: '/uborka-mogily-pered-pokrovom', daysBeforeNotify: 10 },
  { isoDate: '2026-10-14', name: 'Покров Пресвятой Богородицы', landingPath: '/uborka-mogily-pered-pokrovom', daysBeforeNotify: 7 },
  { isoDate: '2026-11-07', name: 'Дмитриевская родительская суббота', landingPath: '/uborka-mogily-pered-dmitrievskoy-subbotoy', daysBeforeNotify: 10 },
  // 2027
  { isoDate: '2027-01-07', name: 'Рождество Христово', landingPath: '/seasonalniy/uborka-mogily-pered-rozhdestvom', daysBeforeNotify: 14 },
  { isoDate: '2027-01-19', name: 'Крещение Господне', landingPath: '/seasonalniy/uborka-mogily-pered-kreshcheniem', daysBeforeNotify: 7 },
  { isoDate: '2027-05-02', name: 'Пасха', landingPath: '/seasonalniy/uborka-mogily-pered-paskhoy-2027', daysBeforeNotify: 14 },
  { isoDate: '2027-05-11', name: 'Радоница 2027', landingPath: '/seasonalniy/uborka-mogily-pered-radonitsey-2027', daysBeforeNotify: 21 },
  { isoDate: '2027-06-19', name: 'Троицкая родительская суббота 2027', landingPath: '/uborka-mogily-pered-troicej', daysBeforeNotify: 14 },
]

async function sb(path) {
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: SUPABASE_SECRET,
        Authorization: `Bearer ${SUPABASE_SECRET}`,
      },
    },
    5000,
  )
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : []
}

async function tgSendOwner(text) {
  return fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
    6000,
  )
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildEmailTemplate(day, daysLeft, unsubscribeBaseUrl) {
  const subject = `Уборка могилы к ${day.name} — осталось ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}`
  const ctaUrl = `https://uhod-mogil.ru${day.landingPath}`
  const bodyHtml = `
<p>Здравствуйте!</p>
<p>Через <strong>${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}</strong> — <strong>${day.name}</strong>.</p>
<p>Если планируете посетить могилу родных в этот день — закажите уборку заранее. К большим поминальным дням у всех исполнителей в Москве загруженность 80-100%, и в последнюю неделю свободных дат уже не остаётся.</p>
<p>Стандартная уборка — <strong>от 3 000 ₽</strong>. Включает: уборка мусора и листвы, прополка, мытьё памятника, свежие цветы (по запросу), фотоотчёт «до и после» в WhatsApp или Telegram. Оплата только после получения отчёта.</p>
<p><a href="${ctaUrl}" style="display:inline-block;background:#1e3a2f;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Заказать уборку →</a></p>
<p>Или напишите нам:<br>
Телефон: <a href="tel:+79304009236">+7 930 400-92-36</a><br>
Telegram: <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a><br>
WhatsApp: <a href="https://wa.me/79304009236">+7 930 400-92-36</a></p>
<p>С уважением,<br>команда УходМогил<br><a href="https://uhod-mogil.ru">uhod-mogil.ru</a></p>
<hr>
<p style="font-size:11px;color:#888">Это письмо отправлено потому что вы подписались на рассылку напоминаний о поминальных днях на сайте uhod-mogil.ru. Если больше не хотите получать такие письма — <a href="${unsubscribeBaseUrl}">отписаться</a>.</p>
`.trim()
  return { subject, bodyHtml }
}

module.exports = async (req, res) => {
  // Cron protection: require secret in query
  if (CRON_SECRET && req.query?.secret !== CRON_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming = []
    for (const day of MEMORIAL_DAYS) {
      const target = new Date(day.isoDate + 'T08:00:00+03:00')
      target.setHours(0, 0, 0, 0)
      const daysLeft = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      // Fire notification exactly on daysBeforeNotify (not earlier/later)
      if (daysLeft === day.daysBeforeNotify) {
        upcoming.push({ day, daysLeft })
      }
    }

    if (upcoming.length === 0) {
      return res.status(200).json({ ok: true, action: 'no-notifications-today' })
    }

    // Fetch active subscribers
    const subscribers = await sb(`email_subscriptions?unsubscribed_at=is.null&topic_memorial_days=eq.true&select=email,unsubscribe_token&order=subscribed_at.asc&limit=1000`)
    const total = subscribers.length

    // Send TG notification to owner with template + recipients
    for (const { day, daysLeft } of upcoming) {
      const sample = subscribers.slice(0, 20).map((s) => s.email).join('\n')
      const { subject } = buildEmailTemplate(day, daysLeft, 'https://uhod-mogil.ru')
      const text =
        `📢 <b>Пора отправить рассылку</b>\n\n` +
        `📅 Событие: <b>${htmlEsc(day.name)}</b>\n` +
        `⏰ Осталось: ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}\n` +
        `📧 Подписчиков: <b>${total}</b>\n\n` +
        `<b>Тема:</b> ${htmlEsc(subject)}\n\n` +
        `<b>Первые 20 email из ${total}:</b>\n<code>${htmlEsc(sample)}</code>\n\n` +
        `Полный список через API: <code>/api/newsletter-emails?secret=...</code>\n\n` +
        `<i>Шаблон письма готов в email_queue (см. БД). Отправлять можно через любой email-клиент с info@uhod-mogil.ru или через ESP.</i>`
      await tgSendOwner(text)
    }

    return res.status(200).json({
      ok: true,
      action: 'notified-owner',
      events: upcoming.map((u) => ({ name: u.day.name, daysLeft: u.daysLeft })),
      subscriberCount: total,
    })
  } catch (e) {
    console.error('newsletter-check error:', e.message)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
