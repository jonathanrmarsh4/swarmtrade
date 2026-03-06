-- Market Scanner tables
-- Run this in Supabase SQL editor

-- scanner_runs: one row per hourly scan
create table if not exists scanner_runs (
  id           text primary key,
  scanned_at   timestamptz not null default now(),
  total_assets integer,
  escalated    integer,
  duration_ms  integer
);

-- scanner_results: one row per asset per scan
create table if not exists scanner_results (
  id           bigserial primary key,
  scan_id      text references scanner_runs(id) on delete cascade,
  scanned_at   timestamptz not null default now(),
  symbol       text not null,
  price        numeric,
  score        integer not null default 0,
  direction    text,
  rsi          numeric,
  volume_ratio numeric,
  macd_cross   text,
  breakout     text,
  signals      text[],
  escalated    boolean default false
);

-- Indexes for dashboard queries
create index if not exists scanner_results_scan_id   on scanner_results(scan_id);
create index if not exists scanner_results_score     on scanner_results(score desc);
create index if not exists scanner_results_scanned_at on scanner_results(scanned_at desc);
create index if not exists scanner_runs_scanned_at    on scanner_runs(scanned_at desc);

-- Enable realtime on scanner_runs so dashboard updates live
alter publication supabase_realtime add table scanner_runs;
alter publication supabase_realtime add table scanner_results;
