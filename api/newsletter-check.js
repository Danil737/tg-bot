// GET /api/newsletter-check?secret=<NEWSLETTER_CRON_SECRET>
//
// Called daily by cron on KZ server. Checks if any memorial-day GROUP is
// coming up. Sends ONE notification per group (not per individual date),
// so subscribers don't get 2-3 emails in same week.
//
// Why not send emails directly? — No ESP set up yet (no Resend/Mailgun API key).
// MVP: human-in-the-loop. Daniil sees TG notification and sends actual email.

const { fetchWithTimeout } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY
const BOT_TOKEN = process.env.BOT_TOKEN
const OWNER_CHAT_ID = parseInt(process.env.OWNER_CHAT_ID || '696698928', 10)
const CRON_SECRET = process.env.NEWSLETTER_CRON_SECRET

// Группы близких событий — каждая = ОДНО письмо.
// Это критично для UX: подписчик не должен получать 2 email с разницей в день
// (например, Троицкая суббота 30 мая + Троица 31 мая).
//
// `daysBeforeFirst` — за сколько дней до САМОГО РАННЕГО события в группе шлём.
// Это и есть «дата нотификации» в TG.
//
// Целевая частота: 5-7 писем в год.
const MEMORIAL_GROUPS = [
  // === 2026 ===
  {
    key: 'troitsa-2026',
    title: 'Троицкая суббота + Троица',
    events: [
      { isoDate: '2026-05-30', name: 'Троицкая родительская суббота' },
      { isoDate: '2026-05-31', name: 'Троица (Пятидесятница)' },
    ],
    landingPath: '/uborka-mogily-pered-troicej',
    daysBeforeFirst: 7,    // нотификация 23 мая 2026
    body: 'Через {N} дней — Троицкая родительская суббота 30 мая и Троица 31 мая 2026. Главный летний день поминовения, спрос на уборку максимальный.',
  },
  {
    key: 'uspenie-2026',
    title: 'Успение Богородицы',
    events: [{ isoDate: '2026-08-28', name: 'Успение Пресвятой Богородицы' }],
    landingPath: '/seasonalniy/uborka-mogily-pered-uspeniem',
    daysBeforeFirst: 10,   // нотификация 18 августа 2026
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
    daysBeforeFirst: 10,   // нотификация 30 сентября 2026
    body: 'Через {N} дней — Покровская родительская суббота 10 октября и Покров Богородицы 14 октября 2026. Время подготовки могилы к зиме.',
  },
  {
    key: 'dmitrievskaya-2026',
    title: 'Дмитриевская суббота',
    events: [{ isoDate: '2026-11-07', name: 'Дмитриевская родительская суббота' }],
    landingPath: '/uborka-mogily-pered-dmitrievskoy-subbotoy',
    daysBeforeFirst: 14,   // нотификация 24 октября 2026
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
    daysBeforeFirst: 14,   // нотификация 24 декабря 2026
    body: 'Через {N} дней — Рождество 7 января и Крещение 19 января 2027. Зимний выезд (расчистка снега, контроль памятника после первых морозов) лучше планировать заранее.',
  },
  {
    key: 'paskha-radonitsa-2027',
    title: 'Пасха + Радоница 2027',
    events: [
      { isoDate: '2027-05-02', name: 'Пасха' },
      { isoDate: '2027-05-11', name: 'Радоница 2027' },
    ],
    landingPath: '/seasonalniy/uborka-mogily-pered-radonitsey-2027',
    daysBeforeFirst: 21,   // нотификация 11 апреля 2027
    body: 'Через {N} дней — Пасха 2 мая и Радоница 11 мая 2027. Самый высокий спрос на уборку в году — бронируйте заранее, в последнюю неделю свободных слотов не остаётся.',
  },
  {
    key: 'troitsa-2027',
    title: 'Троицкая суббота + Троица 2027',
    events: [
      { isoDate: '2027-06-19', name: 'Троицкая родительская суббота' },
      { isoDate: '2027-06-20', name: 'Троица 2027' },
    ],
    landingPath: '/uborka-mogily-pered-troicej',
    daysBeforeFirst: 10,   // нотификация 9 июня 2027
    body: 'Через {N} дней — Троицкая суббота 19 июня и Троица 20 июня 2027.',
  },
]

// Hard limit: один подписчик получает максимум 1 письмо за MIN_DAYS_BETWEEN дней.
// Если события идут плотно (что не должно случаться в нашем расписании, но
// страховка) — кампания пропускается для тех кому недавно слали.
const MIN_DAYS_BETWEEN_EMAILS = 21

async function sb(path, method = 'GET', body = null) {
  const headers = {
    apikey: SUPABASE_SECRET,
    Authorization: `Bearer ${SUPABASE_SECRET}`,
    'Content-Type': 'application/json',
  }
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${path}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
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

function pluralDays(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня'
  return 'дней'
}

function buildEmailTemplate(group, daysLeft) {
  const eventsList = group.events.map((e) => `• ${e.name} — ${formatRu(e.isoDate)}`).join('\n')
  const subject = `Уборка могилы — ${group.title} через ${daysLeft} ${pluralDays(daysLeft)}`
  const ctaUrl = `https://uhod-mogil.ru${group.landingPath}`
  const intro = group.body.replace('{N}', String(daysLeft))

  const bodyHtml = `
<p>Здравствуйте!</p>
<p>${intro}</p>
<p><strong>Ближайшие даты:</strong><br>
${eventsList.replace(/\n/g, '<br>')}</p>
<p>Если планируете посетить могилу — закажите уборку заранее. К большим поминальным дням у всех исполнителей в Москве загруженность 80-100%, в последнюю неделю свободных дат не остаётся.</p>
<p>Стандартная уборка — <strong>от 3 000 ₽</strong>. Включает: уборка мусора, прополка, мытьё памятника, свежие цветы по запросу, фотоотчёт «до и после» в WhatsApp или Telegram. Оплата только после получения отчёта.</p>
<p><a href="${ctaUrl}" style="display:inline-block;background:#1e3a2f;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Заказать уборку →</a></p>
<p>Или напишите:<br>
📞 <a href="tel:+79304009236">+7 930 400-92-36</a><br>
✈ Telegram: <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a><br>
💬 WhatsApp: <a href="https://wa.me/79304009236">+7 930 400-92-36</a></p>
<p>С уважением,<br>команда УходМогил<br><a href="https://uhod-mogil.ru">uhod-mogil.ru</a></p>
<hr style="margin-top:24px;border:0;border-top:1px solid #ddd">
<p style="font-size:11px;color:#888">Это письмо отправлено потому что вы подписались на рассылку напоминаний о поминальных днях на uhod-mogil.ru. Шлём максимум 5-6 писем в год, только перед крупными праздниками. Не хотите получать — <a href="https://tg-bot-two-self.vercel.app/api/unsubscribe?token={UNSUBSCRIBE_TOKEN}">отписаться в один клик</a>.</p>
`.trim()
  return { subject, bodyHtml }
}

function formatRu(iso) {
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
  const d = new Date(iso + 'T08:00:00+03:00')
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
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
      // Самая ранняя дата в группе
      const firstEvent = group.events[0]
      const target = new Date(firstEvent.isoDate + 'T08:00:00+03:00')
      target.setHours(0, 0, 0, 0)
      const daysLeft = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      if (daysLeft === group.daysBeforeFirst) {
        upcoming.push({ group, daysLeft })
      }
    }

    if (upcoming.length === 0) {
      return res.status(200).json({ ok: true, action: 'no-notifications-today' })
    }

    // Подписчиков считаем с фильтром «не получали письмо за последние MIN_DAYS_BETWEEN_EMAILS дней».
    // Пока что у нас нет колонки `last_sent_at` в подписчиках — добавлю в миграцию 004 если понадобится.
    // Для MVP: считаем всех активных подписчиков.
    const subscribers = await sb(
      `email_subscriptions?unsubscribed_at=is.null&topic_memorial_days=eq.true&select=email,unsubscribe_token&order=subscribed_at.asc&limit=2000`,
    )
    const total = subscribers.length

    for (const { group, daysLeft } of upcoming) {
      const sample = subscribers.slice(0, 20).map((s) => s.email).join('\n')
      const { subject } = buildEmailTemplate(group, daysLeft)
      const text =
        `📢 <b>Пора отправить рассылку</b>\n\n` +
        `📅 Группа: <b>${htmlEsc(group.title)}</b>\n` +
        `⏰ Осталось до ближайшего: ${daysLeft} ${pluralDays(daysLeft)}\n` +
        `📧 Подписчиков: <b>${total}</b>\n\n` +
        `<b>Тема:</b> ${htmlEsc(subject)}\n\n` +
        `<b>Первые 20 email из ${total}:</b>\n<code>${htmlEsc(sample)}</code>\n\n` +
        `<i>Шаблон письма с unsubscribe-ссылкой готов. Ссылку для каждого подписчика подставить из БД: SELECT email, unsubscribe_token FROM email_subscriptions WHERE unsubscribed_at IS NULL.</i>`
      await tgSendOwner(text)
    }

    return res.status(200).json({
      ok: true,
      action: 'notified-owner',
      groups: upcoming.map((u) => ({ key: u.group.key, title: u.group.title, daysLeft: u.daysLeft })),
      subscriberCount: total,
    })
  } catch (e) {
    console.error('newsletter-check error:', e.message)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
