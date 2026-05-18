-- Media columns for photo/video reports in web chat.
-- Apply once in Supabase SQL Editor.
--
-- Photo flow: owner replies to escalation message in TG with a photo,
-- bot uploads to Supabase Storage bucket `chat-photos`, saves public URL
-- in web_chat_messages.media_url. Widget renders <img>.

alter table web_chat_messages
  add column if not exists media_url text,
  add column if not exists media_type text;     -- 'photo' | 'video' | NULL

create index if not exists idx_web_chat_msg_has_media
  on web_chat_messages (session_id, created_at)
  where media_url is not null;

-- ВАЖНО: создать bucket `chat-photos` через Supabase Dashboard:
--   1. Storage → New bucket → name=chat-photos → Public bucket ✓
--   2. Policies → New policy for SELECT (public read) → all rows
--   3. Policies → New policy for INSERT (authenticated insert) — мы используем service_role
--      ключ из бэка, RLS можно оставить открытым на INSERT для service_role
