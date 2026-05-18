-- Album/media_group support for chat photo reports.
-- Apply once in Supabase SQL Editor.
--
-- TG album: когда отправляешь несколько фото одним сообщением (paperclip → выбрать
-- 2-10 фото → Send), они приходят на webhook как ОТДЕЛЬНЫЕ updates, но с одинаковым
-- `media_group_id`. Widget группирует их в одну галерею если media_group_id совпадает.

alter table web_chat_messages
  add column if not exists media_group_id text;

create index if not exists idx_web_chat_msg_group
  on web_chat_messages (session_id, media_group_id, created_at)
  where media_group_id is not null;
