-- Add session_token to web_chat_sessions for per-session authorization.
-- Apply once in Supabase SQL Editor.
--
-- Purpose: prevent PII leak when sessionId is exposed (referrer, screenshots).
-- The widget receives session_token only ONCE on session creation, stores it in
-- localStorage and includes in every chat-poll/chat-send request. Backend rejects
-- requests without matching token. UUID alone is no longer sufficient to read
-- somebody else's chat history.

alter table web_chat_sessions
  add column if not exists session_token uuid not null default uuid_generate_v4();

create index if not exists idx_web_chat_sessions_token on web_chat_sessions (session_token);
