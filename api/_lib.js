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
    return '🔎 Источник: ' + label
  }
  return '🔗 Источник: прямой заход (закладка / прямой ввод адреса)'
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

module.exports = {
  isValidUuid, fetchWithTimeout, safeLog, UUID_RE,
  getClientMeta, clientMetaBlockMd, parseUserAgent,
  classifyAttribution, attributionLineMd,
}
