-- Email subscriptions for newsletter
-- Apply once in Supabase SQL Editor.

create table if not exists email_subscriptions (
  id bigserial primary key,
  email text not null unique,
  source text,                                  -- 'footer-form', 'popup', 'order-thanks', etc
  source_url text,
  subscribed_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unsubscribe_token uuid not null default uuid_generate_v4(),
  -- topics: which type of emails to send. Default — all
  topic_memorial_days boolean not null default true,    -- reminders before Радоница/Троица/etc
  topic_seasonal_tips boolean not null default true,    -- seasonal care advice
  topic_promo boolean not null default false            -- discounts, special offers
);

create index if not exists idx_email_subs_active on email_subscriptions (subscribed_at desc) where unsubscribed_at is null;
create index if not exists idx_email_subs_token on email_subscriptions (unsubscribe_token);

-- Outgoing email queue (for the cron-triggered mailing system)
create table if not exists email_queue (
  id bigserial primary key,
  recipient_email text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  campaign_key text,                            -- 'radonitsa-2027', 'pokrov-2026', etc
  created_at timestamptz not null default now(),
  scheduled_for timestamptz,                    -- send not before this time
  sent_at timestamptz,
  send_error text,                              -- last error if failed
  attempts int not null default 0
);

create index if not exists idx_email_queue_pending on email_queue (scheduled_for) where sent_at is null;
create index if not exists idx_email_queue_campaign on email_queue (campaign_key);
