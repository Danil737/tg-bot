// POST /api/channel-post
// Body: { secret, text, photo?: string, parse_mode?: string, channel?: string }
// Authenticated by shared secret (must match POST_SECRET env var on Vercel).
// Posts to @uhod_mogil by default. Bot must be admin of that channel.

const BOT_TOKEN = process.env.BOT_TOKEN
const POST_SECRET = process.env.CHANNEL_POST_SECRET
const DEFAULT_CHANNEL = '@uhod_mogil'

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })

  try {
    const body = req.body || {}
    if (!POST_SECRET || body.secret !== POST_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }

    const channel = body.channel || DEFAULT_CHANNEL
    const text = (body.text || '').toString()
    const photo = (body.photo || '').toString().trim() || null
    const parseMode = body.parse_mode || 'Markdown'

    if (!text || text.length < 1) {
      return res.status(400).json({ ok: false, error: 'Empty text' })
    }
    if (text.length > 4000) {
      return res.status(400).json({ ok: false, error: 'Text too long (max 4000)' })
    }

    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'BOT_TOKEN missing on server' })
    }

    let response
    if (photo) {
      // sendPhoto with caption (caption max 1024 chars; if longer, send photo + separate text)
      if (text.length <= 1024) {
        response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channel,
            photo,
            caption: text,
            parse_mode: parseMode,
          }),
        })
      } else {
        // Photo + extended text as separate message
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channel,
            photo,
          }),
        })
        response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channel,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: false,
          }),
        })
      }
    } else {
      response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channel,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: false,
        }),
      })
    }

    const data = await response.json()
    if (!data.ok) {
      console.error('Telegram error:', data)
      return res.status(500).json({ ok: false, error: data.description || 'Telegram error' })
    }
    return res.status(200).json({
      ok: true,
      message_id: data.result.message_id,
      channel,
    })
  } catch (e) {
    console.error('channel-post error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
