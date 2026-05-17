// POST /api/channel-delete
// Body: { secret, message_id: number, channel?: string }
// Authenticated by shared secret (must match CHANNEL_POST_SECRET env var on Vercel).
// Deletes a message in @uhod_mogil by default. Bot must be admin of that channel.

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
    const messageId = parseInt(body.message_id, 10)
    if (!messageId || isNaN(messageId)) {
      return res.status(400).json({ ok: false, error: 'message_id required' })
    }

    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'BOT_TOKEN missing on server' })
    }

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, message_id: messageId }),
    })

    const data = await response.json()
    if (!data.ok) {
      console.error('Telegram delete error:', data)
      return res.status(500).json({ ok: false, error: data.description || 'Telegram error' })
    }
    return res.status(200).json({ ok: true, channel, message_id: messageId })
  } catch (e) {
    console.error('channel-delete error:', e)
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
