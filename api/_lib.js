// Shared helpers for chat endpoints. CommonJS, no deps.
// Used by chat-send.js, chat-poll.js, webhook.js.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s)
}

// Wrap fetch with a timeout — Vercel kills requests at maxDuration anyway, but
// we want predictable behavior so a stuck upstream doesn't burn the whole budget.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Log without leaking BOT_TOKEN. Pass the URL/payload but never include the token.
function safeLog(label, payload) {
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload)
    // Strip any /bot<token>/ leak. TG bot tokens are colon-separated, ~46 chars.
    const sanitized = s.replace(/\/bot\d+:[A-Za-z0-9_-]+\//g, '/bot[REDACTED]/')
    console.log(label, sanitized.slice(0, 2000))
  } catch {
    console.log(label, '[unserializable]')
  }
}

// --- Client metadata from Vercel + request headers ---
// Geo/device/IP determined server-side WITHOUT asking the client. The site fetches
// hit tg-bot-two-self.vercel.app DIRECTLY (not via Cloudflare), so Vercel sees the real
// client IP and its x-vercel-ip-* geo headers are accurate.
function _hdr(req, name) {
  const v = req && req.headers ? req.headers[name] : ''
  return (Array.isArray(v) ? v[0] : v) || ''
}

const _COUNTRY_RU = {
  RU: 'Россия', KZ: 'Казахстан', BY: 'Беларусь', UA: 'Украина', US: 'США',
  DE: 'Германия', KG: 'Киргизия', AM: 'Армения', AZ: 'Азербайджан',
  UZ: 'Узбекистан', GE: 'Грузия', IL: 'Израиль', TR: 'Турция', GB: 'Британия',
}

// Lightweight UA parse (no deps): device class + OS + browser, в человекочитаемом виде.
function parseUserAgent(ua) {
  const u = String(ua || '')
  let os = '', m
  if (/Windows NT 10/.test(u)) os = 'Windows 10/11'
  else if ((m = u.match(/Windows NT ([\d.]+)/))) os = 'Windows ' + m[1]
  else if (/(iPhone|iPad|iPod)/.test(u)) { m = u.match(/OS (\d+)[._](\d+)/); os = 'iOS' + (m ? ` ${m[1]}.${m[2]}` : '') }
  else if ((m = u.match(/Android ([\d.]+)/))) os = 'Android ' + m[1]
  else if (/Android/.test(u)) os = 'Android'
  else if (/Mac OS X/.test(u)) os = 'macOS'
  else if (/CrOS/.test(u)) os = 'ChromeOS'
  else if (/Linux/.test(u)) os = 'Linux'
  let browser = ''
  if (/Edg\//.test(u)) browser = 'Edge'
  else if (/YaBrowser/.test(u)) browser = 'Яндекс.Браузер'
  else if (/OPR\/|\bOPiOS\b/.test(u)) browser = 'Opera'
  else if (/SamsungBrowser/.test(u)) browser = 'Samsung Internet'
  else if (/CriOS/.test(u)) browser = 'Chrome'
  else if (/FxiOS|Firefox\//.test(u)) browser = 'Firefox'
  else if (/Chrome\//.test(u)) browser = 'Chrome'
  else if (/Safari\//.test(u)) browser = 'Safari'
  let device = 'Компьютер'
  if (/iPad|Tablet/.test(u)) device = 'Планшет'
  else if (/Mobi|iPhone|Android/.test(u)) device = 'Телефон'
  return { device, os, browser }
}

function getClientMeta(req) {
  const ip =
    _hdr(req, 'x-real-ip') ||
    _hdr(req, 'x-forwarded-for').split(',')[0].trim() ||
    _hdr(req, 'x-vercel-forwarded-for').split(',')[0].trim() ||
    ''
  let city = _hdr(req, 'x-vercel-ip-city')
  try { city = decodeURIComponent(city) } catch { /* keep raw */ }
  const country = _hdr(req, 'x-vercel-ip-country')
  const tz = _hdr(req, 'x-vercel-ip-timezone')
  const lang = _hdr(req, 'accept-language').split(',')[0].trim()
  const referer = _hdr(req, 'referer') || _hdr(req, 'referrer')
  const { device, os, browser } = parseUserAgent(_hdr(req, 'user-agent'))
  return { ip, city, country, tz, lang, referer, device, os, browser }
}

function _geoStr(meta) {
  const parts = []
  if (meta.city) parts.push(meta.city)
  if (meta.country) parts.push(_COUNTRY_RU[meta.country] || meta.country)
  return parts.join(', ')
}

// MarkdownV2-escaped client-info block for owner notifications (web chat + form).
// opts.page=true → include the referer page line (для формы; в чате страница уже показана отдельно).
function clientMetaBlockMd(meta, opts = {}) {
  if (!meta) return ''
  const esc = (s) => String(s || '').replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')
  const lines = []
  const geo = _geoStr(meta)
  if (geo) lines.push(`📍 *Гео \\(по IP\\):* ${esc(geo)}`)
  const dev = [meta.device, meta.os, meta.browser].filter(Boolean).join(' · ')
  if (dev) lines.push(`📱 *Устройство:* ${esc(dev)}`)
  if (opts.page && meta.referer) {
    lines.push(`🌐 *Страница:* ${esc(meta.referer.replace(/^https?:\/\//, '').slice(0, 120))}`)
  }
  if (meta.ip) lines.push(`🔢 *IP:* ${esc(meta.ip)}`)
  return lines.join('\n')
}

// --- Traffic-source attribution (first-touch) ---
// Frontend (lib/attribution.ts) присылает СЫРЬЁ {referrer, utm_*, landing}. Классификация — здесь,
// одна точка правды: можно улучшать без передеплоя сайта.
function _host(u) {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' }
}
const _UTM_SRC = {
  google: 'Google Ads', yandex: 'Яндекс Директ', vk: 'ВКонтакте', vkontakte: 'ВКонтакте',
  telegram: 'Telegram', tg: 'Telegram', facebook: 'Facebook', fb: 'Facebook',
  instagram: 'Instagram', ig: 'Instagram', mytarget: 'myTarget', email: 'Email-рассылка',
  newsletter: 'Email-рассылка', avito: 'Avito', '2gis': '2ГИС',
}
const _UTM_MED = {
  cpc: 'реклама', ppc: 'реклама', paid: 'реклама', cpm: 'реклама', banner: 'баннер',
  email: 'рассылка', social: 'соцсети', organic: 'органика', referral: 'переход',
}

// Возвращает человекочитаемую строку источника привлечения (или null).
function classifyAttribution(attr) {
  if (!attr || typeof attr !== 'object') return null
  const utmSource = String(attr.utm_source || '').toLowerCase().trim()
  const utmMedium = String(attr.utm_medium || '').toLowerCase().trim()
  const utmCampaign = String(attr.utm_campaign || '').trim().slice(0, 60)
  if (utmSource) {
    const srcLabel = _UTM_SRC[utmSource] || (utmSource.charAt(0).toUpperCase() + utmSource.slice(1))
    const medLabel = _UTM_MED[utmMedium] || utmMedium
    let s = '🎯 Реклама: ' + srcLabel
    if (medLabel) s += ` (${medLabel})`
    if (utmCampaign) s += ` · кампания «${utmCampaign}»`
    return s
  }
  const ref = String(attr.referrer || '')
  if (ref) {
    const h = _host(ref)
    let label
    if (/google\./.test(h)) label = 'Google (поиск)'
    else if (/yandex\.|ya\.ru/.test(h)) label = 'Яндекс (поиск)'
    else if (/bing\./.test(h)) label = 'Bing (поиск)'
    else if (/duckduckgo/.test(h)) label = 'DuckDuckGo'
    else if (/mail\.ru/.test(h)) label = 'Mail.ru (поиск)'
    else if (/rambler/.test(h)) label = 'Rambler'
    else if (/(^|\.)t\.me$|telegram/.test(h)) label = 'Telegram'
    else if (/vk\.com|vk\.ru/.test(h)) label = 'ВКонтакте'
    else if (/dzen\.|zen\.yandex/.test(h)) label = 'Дзен'
    else if (/(youtube|youtu\.be)/.test(h)) label = 'YouTube'
    else if (/pinterest/.test(h)) label = 'Pinterest'
    else if (/2gis/.test(h)) label = '2ГИС'
    else if (/avito/.test(h)) label = 'Avito'
    else label = 'переход с ' + (h || 'др. сайта')
    return '🔎 Пришёл с: ' + label
  }
  return '🔗 Пришёл напрямую (закладка / прямой ввод адреса)'
}

// MarkdownV2-блок: строка источника + страница первого захода (intent).
function attributionLineMd(attr) {
  const label = classifyAttribution(attr)
  if (!label) return ''
  const esc = (s) => String(s || '').replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')
  let out = esc(label)
  const landing = attr && attr.landing ? String(attr.landing) : ''
  if (landing && landing !== '/') out += `\n↳ зашёл на: ${esc(landing.slice(0, 120))}`
  return out
}


// --- Реестр захоронений (epoisk.ru через CRM) --------------------------------
// Сам поиск живёт в CRM: там кэш на 14 дней, пауза между запросами к чужому сайту и
// разбор выдачи. Бот только спрашивает и показывает — второй копии парсера нет.
const CRM_URL = process.env.CRM_URL || ''
const CRM_SECRET = process.env.CRM_SECRET || ''

async function crmPost(path, payload, timeoutMs = 6000) {
  if (!CRM_URL || !CRM_SECRET) return null
  try {
    const r = await fetchWithTimeout(
      CRM_URL.replace(/\/+$/, '') + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': CRM_SECRET },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    )
    if (!r.ok) {
      safeLog('crm.post.status', { path, status: r.status })
      return null
    }
    return await r.json()
  } catch (e) {
    safeLog('crm.post.fail', { path, error: String((e && e.message) || e).slice(0, 120) })
    return null
  }
}

// Запрос уходит на внешний сайт — таймаут больше, чем у остальных вызовов CRM.
function crmGraveSearch(payload) {
  return crmPost('/api/bot/grave', payload, 12000)
}

// В callback_data телеграма влезает 64 байта, поэтому кнопка несёт только gid,
// а карточка захоронения достаётся заново — из кэша CRM, без похода на epoisk.ru.
function crmGravePick(gid) {
  return crmPost('/api/bot/pick', { gid })
}

async function crmClients(projectId, opts = {}) {
  const r = await crmPost('/api/bot/clients', { project_id: projectId, ...opts })
  return (r && r.clients) || []
}

function htmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Виджет на сайте показывает текст как есть — теги там были бы видны буквально.
function htmlToPlain(s) {
  return String(s ?? '')
    .replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// «ЗИ/037/23/0996» — это код реестра, а спрашивают всегда про участок и могилу.
// Показываем словами, код оставляем мелким: по нему потом ищут в конторе кладбища.
function uchastokLabel(u) {
  const p = String(u || '').split('/')
  return p.length >= 4 ? `участок ${p[2]}, могила ${p[3]}` : String(u || '')
}

// В выдаче попадаются строки вроде «Данные не читаются» — в ответе они занимают место
// и ничего не говорят. Оставляем то, что похоже на имя человека.
function graveNames(r) {
  return (r.inscription || []).filter((s) => /[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+/.test(s))
}

function uchastokShort(u) {
  const p = String(u || '').split('/')
  return p.length >= 4 ? `уч. ${p[2]}, мог. ${p[3]}` : String(u || '')
}

// Ссылки к одному захоронению. Карточка в реестре — единственное место, где бывает
// фото памятника; тянуть её автоматом нельзя (robots.txt epoisk закрывает /burmsk/?gid=),
// поэтому даём ссылку: открывается руками — и мной, и клиентом.
function graveLinks(r, full) {
  const out = []
  if (r.map_url) out.push(`<a href="${r.map_url}">план участка</a>`)
  if (r.lat) out.push(`<a href="https://yandex.ru/maps/?pt=${r.lon},${r.lat}&z=18&l=sat">спутник</a>`)
  if (r.lat && full) {
    out.push(`<a href="https://yandex.ru/maps/?rtext=~${r.lat},${r.lon}&rtt=auto">маршрут</a>`)
  }
  if (r.card_url && full) out.push(`<a href="${r.card_url}">карточка в реестре</a>`)
  return out
}

const GRAVE_NUM = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3',
                   '5\uFE0F\u20E3', '6\uFE0F\u20E3', '7\uFE0F\u20E3', '8\uFE0F\u20E3']
// Восемь — потолок и по читаемости, и по кнопкам. Однофамильцев бывает и сотня:
// без потолка одно сообщение вырастет за лимит телеграма и не уйдёт вообще.
const GRAVE_MAX = 8

// Полная карточка одного захоронения.
function graveRow(r, full) {
  const names = graveNames(r).slice(0, full ? 4 : 2).map((x) => `   ${htmlEscape(x)}`)
  const links = graveLinks(r, full)
  return `📍 <b>${htmlEscape(uchastokLabel(r.uchastok))}</b>  <code>${htmlEscape(r.uchastok)}</code>` +
    (names.length ? `\n${names.join('\n')}` : '') +
    ((r.why || []).length ? `\n   ✅ ${htmlEscape(r.why.join(' · '))}` : '') +
    (links.length ? `\n   ${links.join(' · ')}` : '')
}

// Строка списка: номер, участок, кто лежит. Раскрывается кнопкой с тем же номером.
function graveLine(r, i) {
  const who = graveNames(r).slice(0, 2).join(' · ').slice(0, 90)
  return `${GRAVE_NUM[i] || `${i + 1}.`} <b>${htmlEscape(uchastokShort(r.uchastok))}</b>` +
    (who ? ` — ${htmlEscape(who)}` : '') +
    ((r.why || []).length ? ' ✅' : '')
}

// Показываем ВСЕ найденное (до потолка), но первым — то, что сошлось с текстом клиента.
function graveShown(g) {
  if (!g || !g.ok || !g.results || !g.results.length) return []
  return g.results.slice(0, GRAVE_MAX)
}

// Выписка ДЛЯ ВЛАДЕЛЬЦА. Клиенту сама не уходит: совпадение по ФИО — ещё не та могила,
// а цена ошибки несоизмерима с экономией одного сообщения. Отправляет человек кнопкой.
function graveOwnerText(g, origin = 'по сообщению клиента') {
  const shown = graveShown(g)
  if (!shown.length) return null
  const best = shown[0]
  const sure = (best.score || 0) > 0
  const head = `🔎 <b>${htmlEscape(g.cemetery || 'Реестр захоронений')}</b> · <i>${htmlEscape(origin)}</i>`
  const rest = shown.slice(1)
  const restBlock = rest.length
    ? `\n\n<i>${sure ? 'Остальные по фамилии' : 'Другие варианты'}:</i>\n` +
      rest.map((r, i) => graveLine(r, i + 1)).join('\n') +
      '\n\n<i>Кнопка с номером — раскрыть вариант.</i>'
    : ''
  const cut = (g.total || shown.length) > shown.length
    ? `\n\n⚠️ <i>Всего совпадений ${g.total} — показаны первые ${shown.length}. ` +
      'Уточните отчество, год или кладбище.</i>'
    : ''
  return `${head}\n\n${graveRow(best, true)}${restBlock}${cut}`
}

// Текст, который уходит КЛИЕНТУ. Формулировка намеренно вопросительная: подтвердить
// участок может только тот, кто знает свою могилу.
function graveClientText(r) {
  const ins = graveNames(r).slice(0, 6).map((x) => `• ${htmlEscape(x)}`).join('\n')
  const links = graveLinks(r, true)
  return '🕯 Нашли в открытом реестре захоронений:\n\n' +
    `📍 <b>${htmlEscape(r.cemetery)} кладбище, ${htmlEscape(uchastokLabel(r.uchastok))}</b>\n` +
    (ins ? `\nНадпись на памятнике:\n${ins}\n` : '') +
    (links.length ? `\n${links.join(' · ')}\n` : '') +
    '\nПодскажите, пожалуйста, это тот самый участок? Совпадение по фамилии и имени — ещё не ' +
    'подтверждение, поэтому перед работами мы сверим место на выезде и пришлём фото.'
}

// «Отправить в другом мессенджере» — значит скопировать. В телеграме нажатие по <code>
// копирует блок целиком, поэтому текст идёт именно так, а не обычным абзацем.
// Два блока: клиенту — с вопросом и оговоркой, мастеру — только место.
function graveCopyText(r) {
  const forClient = htmlToPlain(graveClientText(r))
  const short = `${r.cemetery} кладбище, ${uchastokLabel(r.uchastok)} (${r.uchastok})` +
    (r.lat ? `, координаты ${r.lat}, ${r.lon}` : '')
  return '📋 <b>Клиенту</b> — нажми на текст, скопируется целиком:\n\n' +
    `<code>${htmlEscape(forClient)}</code>\n\n` +
    '🔧 <b>Мастеру</b> — только место:\n\n' +
    `<code>${htmlEscape(short)}</code>`
}

// Первая строка кнопок — что делать с показанной карточкой, вторая и дальше — номера
// остальных вариантов. clientId известен — отправка спросит подтверждение; не известен
// (выписку я поднял своим сообщением) — сначала спросим кому, подтверждение всё равно будет.
function graveKeyboard(g, clientId) {
  const shown = Array.isArray(g) ? g : graveShown(g)
  const best = shown[0]
  if (!best || !best.gid) return {}
  const rows = [[
    { text: '📋 Текст для отправки', callback_data: `gt:${best.gid}` },
    {
      text: '📤 Отправить клиенту',
      callback_data: clientId ? `gs:${best.gid}:${clientId}` : `gc:${best.gid}`,
    },
  ]]
  const nums = shown.slice(1).filter((r) => r.gid).map((r, i) => ({
    text: GRAVE_NUM[i + 1] || `${i + 2}`,
    callback_data: clientId ? `gp:${r.gid}:${clientId}` : `gp:${r.gid}`,
  }))
  for (let i = 0; i < nums.length; i += 4) rows.push(nums.slice(i, i + 4))
  return { reply_markup: { inline_keyboard: rows } }
}

// Отправка клиенту необратима, поэтому в два нажатия: первое показывает, ЧТО и КОМУ
// уйдёт, и только второе отправляет. Промахнуться по соседней кнопке в списке
// из шести карточек иначе слишком легко.
function graveConfirmKeyboard(r, client) {
  return {
    inline_keyboard: [
      [{ text: `⚠️ ${uchastokShort(r.uchastok)} → ${graveClientLabel(client)}`.slice(0, 60),
         callback_data: 'noop' }],
      [{ text: '✅ Да, отправить', callback_data: `gy:${r.gid}:${client.id}` },
       { text: '✖️ Отмена', callback_data: `gx:${r.gid}:${client.id}` }],
    ],
  }
}

// Стоит ли вообще идти в реестр по СВОБОДНОМУ тексту владельца. Название кладбища —
// сигнал не хуже слова «кладбище»: люди пишут «Троекуровское, Иванов Иван Иванович».
// Конец слова ловим отрицательным просмотром, а не \b: для \b кириллица не буква,
// и «Троекуровское,» границей не считалось — условие молчало на самом частом случае.
function looksLikeGraveText(text) {
  const t = String(text || '')
  if (t.length < 12) return false
  return /кладбищ|могил|участок|захорон|похорон/i.test(t) ||
    /[А-ЯЁ][а-яё-]+ск(?:ое|ом|ого|ому|им)(?![а-яё])/.test(t)
}

// Карточки из веб-чата заводятся без имени — по одному id их не различить,
// поэтому в подписи кнопки идёт последняя фраза клиента.
function graveClientLabel(c) {
  const who = c.name || c.contact || (c.last_text || '').trim() ||
    (c.web_session ? 'чат сайта ' + String(c.web_session).slice(0, 8) : 'карточка ' + c.id)
  const tail = c.cemetery ? ' · ' + c.cemetery : ''
  return (String(who).replace(/\s+/g, ' ').slice(0, 40) + tail).slice(0, 60)
}

module.exports = {
  isValidUuid, fetchWithTimeout, safeLog, UUID_RE,
  getClientMeta, clientMetaBlockMd, parseUserAgent,
  classifyAttribution, attributionLineMd,
  crmPost, crmGraveSearch, crmGravePick, crmClients,
  htmlEscape, htmlToPlain,
  graveOwnerText, graveClientText, graveKeyboard, graveClientLabel, graveShown,
  graveCopyText, graveConfirmKeyboard, uchastokShort, uchastokLabel, graveRow,
  looksLikeGraveText,
}
