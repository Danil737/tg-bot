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

module.exports = { isValidUuid, fetchWithTimeout, safeLog, UUID_RE }
