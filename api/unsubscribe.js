// GET /api/unsubscribe?token=<uuid>
//
// Returns a tiny HTML page confirming unsubscription. Token is a UUID stored
// alongside the email. After unsubscribe we keep the row (for "reactivate"
// flow) but set unsubscribed_at and stop sending newsletters.

const { isValidUuid, fetchWithTimeout } = require('./_lib')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fxxmhnmvttvfatdlxpxk.supabase.co'
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY

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
  return text ? JSON.parse(text) : null
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #333; background: #f9f5f0; }
  .card { background: #fff; padding: 32px 24px; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); text-align: center; }
  h1 { color: #1e3a2f; font-size: 22px; margin-bottom: 16px; }
  p { color: #555; line-height: 1.6; }
  a { color: #1e3a2f; }
  .btn { display: inline-block; margin-top: 16px; background: #1e3a2f; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`
}

module.exports = async (req, res) => {
  const token = (req.query?.token || '').toString().trim()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')

  if (!isValidUuid(token)) {
    res.status(400).send(htmlPage(
      'Ошибка отписки',
      `<h1>Некорректная ссылка отписки</h1>
       <p>Ссылка повреждена или просрочена. Если вы хотите отписаться от рассылки, напишите нам в Telegram <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a> или на info@uhod-mogil.ru — отпишем вручную.</p>
       <a href="https://uhod-mogil.ru" class="btn">На главную</a>`,
    ))
    return
  }

  try {
    const rows = await sb(`email_subscriptions?unsubscribe_token=eq.${token}&select=id,email,unsubscribed_at`)
    if (!rows || rows.length === 0) {
      res.status(404).send(htmlPage(
        'Подписка не найдена',
        `<h1>Подписка не найдена</h1>
         <p>Похоже, эта ссылка уже не действует или была удалена.</p>
         <a href="https://uhod-mogil.ru" class="btn">На главную</a>`,
      ))
      return
    }
    const row = rows[0]
    if (row.unsubscribed_at) {
      res.status(200).send(htmlPage(
        'Вы уже отписаны',
        `<h1>Вы уже отписаны</h1>
         <p>Email <strong>${row.email}</strong> больше не получает наши письма.</p>
         <p>Если хотите вернуться — напишите нам в Telegram <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a>.</p>
         <a href="https://uhod-mogil.ru" class="btn">На главную</a>`,
      ))
      return
    }
    await sb(`email_subscriptions?id=eq.${row.id}`, 'PATCH', { unsubscribed_at: new Date().toISOString() })

    res.status(200).send(htmlPage(
      'Вы отписаны',
      `<h1>Вы успешно отписаны</h1>
       <p>Email <strong>${row.email}</strong> больше не будет получать наши письма с напоминаниями о поминальных днях.</p>
       <p>Если передумаете — можно подписаться снова через форму на сайте или просто написать нам в Telegram.</p>
       <a href="https://uhod-mogil.ru" class="btn">На главную</a>`,
    ))
  } catch (e) {
    console.error('unsubscribe error:', e.message)
    res.status(500).send(htmlPage(
      'Ошибка',
      `<h1>Произошла ошибка</h1>
       <p>Попробуйте позже или напишите нам в Telegram <a href="https://t.me/uhodmogil_bot">@uhodmogil_bot</a> — отпишем вручную.</p>`,
    ))
  }
}
