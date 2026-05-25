// Temporary diagnostic endpoint. Returns presence of env vars (no values).
// DELETE after troubleshooting.
module.exports = (req, res) => {
  const adminKey = req.headers['x-admin'] || req.query?.k
  if (adminKey !== 'kmh-diag-2026') {
    return res.status(401).json({ ok: false })
  }
  res.status(200).json({
    ok: true,
    env: {
      BOT_TOKEN: !!process.env.BOT_TOKEN,
      BOT_TOKEN_KMH: !!process.env.BOT_TOKEN_KMH,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: !!process.env.SUPABASE_SECRET_KEY,
      TG_WEBHOOK_SECRET: !!process.env.TG_WEBHOOK_SECRET,
      OWNER_CHAT_ID: process.env.OWNER_CHAT_ID || null,
      // Length only — never leak values
      BOT_TOKEN_len: (process.env.BOT_TOKEN || '').length,
      BOT_TOKEN_KMH_len: (process.env.BOT_TOKEN_KMH || '').length,
      TG_WEBHOOK_SECRET_len: (process.env.TG_WEBHOOK_SECRET || '').length,
    },
    query: req.query,
    method: req.method,
  })
}
