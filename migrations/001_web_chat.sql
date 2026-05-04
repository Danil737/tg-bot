-- Web chat tables for live chat widget on uhod-mogil.ru
-- Apply once in Supabase SQL Editor.

create extension if not exists "uuid-ossp";

-- One row per chat session (one site visitor)
create table if not exists web_chat_sessions (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  user_name text,
  user_contact text,
  user_cemetery text,
  user_service text,
  status text not null default 'active',          -- active | escalated | closed
  user_agent text,
  source_url text,
  tg_root_message_id bigint                       -- TG message_id of the first admin notification (used for replies)
);

create index if not exists idx_web_chat_sessions_last_active on web_chat_sessions (last_active_at desc);
create index if not exists idx_web_chat_sessions_tg_root on web_chat_sessions (tg_root_message_id);

-- Chat messages
create table if not exists web_chat_messages (
  id bigserial primary key,
  session_id uuid not null references web_chat_sessions(id) on delete cascade,
  role text not null,                             -- user | ai | admin | system
  content text not null,
  created_at timestamptz not null default now(),
  tg_message_id bigint                            -- TG message id (for admin replies)
);

create index if not exists idx_web_chat_messages_session_time
  on web_chat_messages (session_id, created_at);

-- Trigger: bump session.last_active_at on new message
create or replace function web_chat_touch_session()
returns trigger language plpgsql as $$
begin
  update web_chat_sessions set last_active_at = now() where id = new.session_id;
  return new;
end; $$;

drop trigger if exists trg_web_chat_touch on web_chat_messages;
create trigger trg_web_chat_touch
  after insert on web_chat_messages
  for each row execute function web_chat_touch_session();
