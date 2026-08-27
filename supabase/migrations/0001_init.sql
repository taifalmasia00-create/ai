-- جدول جلسات الدخول (لنظام كلمة السر البسيط)
create table if not exists sessions (
  token text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- جدول وظائف المعالجة
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'uploaded', -- uploaded | processing | done | error
  headers jsonb not null,
  rows jsonb not null,
  total int not null,
  processed int not null default 0,
  source_column text,
  target_column text,
  instruction text,
  sheet_name text default 'Sheet1',
  error text,
  last_processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- تفعيل RLS من غير أي policies عامة: الوصول للجداول دول بيبقى بس عن طريق
-- الـ Edge Functions اللي بتستخدم الـ service role key (بيتخطى RLS تلقائي).
-- محدش يقدر يقرا أو يكتب في الجداول دي مباشرة من الفرونت إند.
alter table sessions enable row level security;
alter table jobs enable row level security;

create index if not exists idx_jobs_created_at on jobs (created_at);
create index if not exists idx_sessions_expires_at on sessions (expires_at);
