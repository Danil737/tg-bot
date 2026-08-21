// GET /api/newsletter-check?secret=<NEWSLETTER_CRON_SECRET>
//
// Called daily by cron on KZ server. Checks if any memorial-day GROUP is
// coming up. Sends ONE notification per group (not per individual date).
//
// Email sending: uses Resend API (RESEND_API_KEY env var).
// If key not set — falls back to human-in-the-loop TG notification.

const { fetchWithTimeout } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const BOT_TOKEN = process.env.BOT_TOKEN
const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const CRON_SECRET = process.env.NEWSLETTER_CRON_SECRET
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'УходМогил <info@uhod-mogil.ru>'

const MEMORIAL_GROUPS = [
  // === 2026 ===
  {
    key: 'uspenie-2026',
    title: 'Успение Богородицы',
    events: [{ isoDate: '2026-08-28', name: 'Успение Пресвятой Богородицы' }],
    landingPath: '/seasonalniy/uborka-mogily-pered-uspeniem',
    daysBeforeFirst: 10,
    // Окно этой кампании (18.08) прошло ДО подключения Resend — тогда сработала
    // аварийная TG-ветка, письма не отправлялись. Без этого флага расширение условия
    // до окна отправило бы её задним числом на следующем же прогоне. Снять флаг,
    // если рассылку по Успению всё-таки решат отправить.
    skip: true,
    body: 'Через {N} дней — Успение Богородицы 28 августа 2026. Один из двенадцати главных православных праздников, традиционное время осеннего посещения могил.',
  },
  {
    key: 'pokrov-2026',
    title: 'Покровская суббота + Покров',
    events: [
      { isoDate: '2026-10-10', name: 'Покровская родительская суббота' },
      { isoDate: '2026-10-14', name: 'Покров Пресвятой Богородицы' },
    ],
    landingPath: '/uborka-mogily-pered-pokrovom',
    daysBeforeFirst: 10,
    body: 'Через {N} дней — Покровская родительская суббота 10 октября и Покров Богородицы 14 октября 2026. Время подготовки могилы к зиме.',
  },
  {
    key: 'dmitrievskaya-2026',
    title: 'Дмитриевская суббота',
    events: [{ isoDate: '2026-11-07', name: 'Дмитриевская родительская суббота' }],
    landingPath: '/uborka-mogily-pered-dmitrievskoy-subbotoy',
    daysBeforeFirst: 14,
    body: 'Через {N} дней — Дмитриевская родительская суббота 7 ноября 2026. Последний крупный осенний день поминовения перед зимой.',
  },
  // === 2027 ===
  {
    key: 'rozhdestvo-kreshchenie-2027',
    title: 'Рождество + Крещение',
    events: [
      { isoDate: '2027-01-07', name: 'Рождество Христово' },
      { isoDate: '2027-01-19', name: 'Крещение Господне' },
    ],
    landingPath: '/seasonalniy/uborka-mogily-pered-rozhdestvom',
    daysBeforeFirst: 14,
    body: 'Через {N} дней — Рождество 7 января и Крещение 19 января 2027. Зимний выезд (расчистка снега, контроль памятника) лучше планировать заранее.',
  },
  {
    key: 'paskha-radonitsa-2027',
    title: 'Пасха + Радоница 2027',
    events: [
      { isoDate: '2027-05-02', name: 'Пасха' },
      { isoDate: '2027-05-11', name: 'Радоница 2027' },
    ],
    landingPath: '/seasonalniy/uborka-mogily-pered-radonitsey-2027',
    daysBeforeFirst: 21,
    body: 'Через {N} дней — Пасха 2 мая и Радоница 11 мая 2027. Самый высокий спрос на уборку в году — бронируйте заранее.',
  },
  {
    key: 'troitsa-2027',
    title: 'Троицкая суббота + Троица 2027',
    events: [
      { isoDate: '2027-06-19', name: 'Троицкая родительская суббота' },
      { isoDate: '2027-06-20', name: 'Троица 2027' },
    ],
    landingPath: '/uborka-mogily-pered-troicej',
    daysBeforeFirst: 10,
    body: 'Через {N} дней — Троицкая суббота 19 июня и Троица 20 июня 2027.',
  },
]

async function sb(path, method = 'GET', body = null) {
  const headers = {
    apikey: SUPABASE_SECRET,
    Authorization: `Bearer ${SUPABASE_SECRET}`,
    'Content-Type': 'application/json',
    Prefer: method === 'POST' ? 'return=representation' : undefined,
  }
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${path}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    8000,
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
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    },
    6000,
  )
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pluralDays(n) {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня'
  return 'дней'
}

function formatRu(iso) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
  const d = new Date(iso + 'T08:00:00+03:00')
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

function buildEmail(group, daysLeft, unsubToken) {
  const eventsList = group.events.map(e => `• ${e.name} — ${formatRu(e.isoDate)}`).join('<br>')
  const subject = `Напоминание: ${group.title} — через ${daysLeft} ${pluralDays(daysLeft)}`
  const ctaUrl = `https://uhod-mogil.ru${group.landingPath}`
  const intro = group.body.replace('{N}', String(daysLeft))
  const unsubUrl = `https://tg-bot-two-self.vercel.app/api/unsubscribe?token=${unsubToken}`

  const bodyHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
<p>Здравствуйте!</p>
<p>${intro}</p>
<p><strong>Ближайшие даты:</strong><br>${eventsList}</p>
<p>Если планируете посетить могилу — закажите уборку заранее. К большим поминальным дням у всех исполнителей загруженность 80–100%, в последнюю неделю свободных дат не остаётся.</p>
<p>Стандартная уборка — <strong>от 3 000 ₽</strong>. Включает уборку мусора, прополку, мытьё памятника и фотоотчёт «до и после». Оплата только после получения отчёта.</p>
<p style="text-align:center;margin:24px 0"><a href="${ctaUrl}" style="display:inline-block;background:#1e3a2f;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px">Заказать уборку →</a></p>
<p>Или напишите напрямую:<br>
📞 <a href="tel:+79304009236">+7 930 400-92-36</a><br>
✈ Telegram: <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a><br>
💬 WhatsApp: <a href="https://wa.me/79304009236">+7 930 400-92-36</a></p>
<p>С уважением,<br><strong>Команда УходМогил</strong><br><a href="https://uhod-mogil.ru">uhod-mogil.ru</a></p>
<hr style="margin-top:32px;border:0;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Вы получили это письмо, потому что подписались на напоминания о поминальных днях на uhod-mogil.ru. Шлём максимум 5–6 писем в год. <a href="${unsubUrl}" style="color:#999">Отписаться в один клик</a>.</p>
</body></html>`

  return { subject, bodyHtml }
}

async function sendViaResend(to, subject, bodyHtml) {
  const r = await fetchWithTimeout(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html: bodyHtml }),
    },
    10000,
  )
  const text = await r.text()
  if (!r.ok) throw new Error(`Resend ${r.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

module.exports = async (req, res) => {
  if (CRON_SECRET && req.query?.secret !== CRON_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming = []
    for (const group of MEMORIAL_GROUPS) {
      const firstEvent = group.events[0]
      const target = new Date(firstEvent.isoDate + 'T08:00:00+03:00')
      target.setHours(0, 0, 0, 0)
      const daysLeft = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      // Окно, а не один календарный день. С `===` кампания уходила ровно в одну дату,
      // и сутки простоя таймера (или сетевой флап KZ) убивали её целиком. Повтор при
      // этом не грозит: ниже стоит проверка email_queue по campaign_key.
      // Нижняя граница обязательна — без неё письмо «через N дней» ушло бы и ПОСЛЕ
      // праздника, когда daysLeft уже отрицательный.
      if (!group.skip && daysLeft >= 0 && daysLeft <= group.daysBeforeFirst) {
        upcoming.push({ group, daysLeft })
      }
    }

    if (upcoming.length === 0) {
      return res.status(200).json({ ok: true, action: 'no-notifications-today' })
    }

    const subscribers = await sb(
      `email_subscriptions?unsubscribed_at=is.null&topic_memorial_days=eq.true&select=email,unsubscribe_token&order=subscribed_at.asc&limit=2000`,
    )
    const total = subscribers.length
    const results = []

    for (const { group, daysLeft } of upcoming) {
      // Check if already sent this campaign (avoid duplicates on re-runs)
      const existing = await sb(`email_queue?campaign_key=eq.${group.key}&select=id&limit=1`)
      if (existing.length > 0) {
        results.push({ group: group.key, skipped: true, reason: 'already-queued' })
        continue
      }

      if (!RESEND_API_KEY) {
        // Fallback: TG notification (human-in-the-loop)
        const sample = subscribers.slice(0, 20).map(s => s.email).join('\n')
        const { subject } = buildEmail(group, daysLeft, 'TOKEN')
        await tgSendOwner(
          `📢 <b>Пора отправить рассылку</b> (RESEND_API_KEY не задан)\n\n` +
          `📅 <b>${htmlEsc(group.title)}</b>\n` +
          `⏰ Через ${daysLeft} ${pluralDays(daysLeft)}\n` +
          `📧 Подписчиков: <b>${total}</b>\n\n` +
          `<b>Тема:</b> ${htmlEsc(subject)}\n\n` +
          `Добавь RESEND_API_KEY в Vercel env → рассылка пойдёт сама.`
        )
        // Метка в очередь — иначе кампания, обработанная этой веткой, считается
        // неотправленной, и как только появится RESEND_API_KEY, она уйдёт письмами
        // задним числом. Именно так и вышло с Успением-2026.
        await sb('email_queue', 'POST', [{
          recipient_email: 'tg-fallback@uhod-mogil.ru',
          subject: `[TG fallback] ${group.title}`,
          body_html: '',
          campaign_key: group.key,
          sent_at: null,
          send_error: 'RESEND_API_KEY не задан — владелец уведомлён в Telegram',
          attempts: 0,
        }]).catch(e => console.error('fallback queue mark error:', e.message))
        results.push({ group: group.key, action: 'tg-notified', subscriberCount: total })
        continue
      }

      // Send via Resend
      let sent = 0, errors = 0
      const queueRows = []

      for (const sub of subscribers) {
        const { subject, bodyHtml } = buildEmail(group, daysLeft, sub.unsubscribe_token)
        let sendError = null
        try {
          await sendViaResend(sub.email, subject, bodyHtml)
          sent++
        } catch (e) {
          sendError = e.message
          errors++
        }
        queueRows.push({
          recipient_email: sub.email,
          subject,
          body_html: bodyHtml.slice(0, 50), // save truncated to avoid huge DB rows
          campaign_key: group.key,
          sent_at: sendError ? null : new Date().toISOString(),
          send_error: sendError,
          attempts: 1,
        })
      }

      // Log to email_queue
      if (queueRows.length > 0) {
        await sb('email_queue', 'POST', queueRows).catch(e => console.error('queue log error:', e.message))
      }

      await tgSendOwner(
        `✅ <b>Рассылка отправлена</b>\n\n` +
        `📅 <b>${htmlEsc(group.title)}</b>\n` +
        `📧 Отправлено: ${sent} из ${total}${errors > 0 ? ` (ошибок: ${errors})` : ''}`
      )
      results.push({ group: group.key, sent, errors, total })
    }

    return res.status(200).json({ ok: true, results })
  } catch (e) {
    console.error('newsletter-check error:', e.message)
    return res.status(500).json({ ok: false, error: e.message })
  }
}
