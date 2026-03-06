-- Deliberation Events table — one row per step in the pipeline
-- Powers the War Room live streaming view

create table if not exists deliberation_events (
  id               bigserial primary key,
  deliberation_id  uuid references deliberations(id) on delete cascade,
  signal_id        uuid references signals(id) on delete cascade,
  event_type       text not null,
  sequence         integer not null default 0,
  payload          jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create index if not exists deliberation_events_deliberation_id on deliberation_events(deliberation_id);
create index if not exists deliberation_events_signal_id       on deliberation_events(signal_id);
create index if not exists deliberation_events_created_at      on deliberation_events(created_at desc);

-- Enable realtime so War Room dashboard streams events live
alter publication supabase_realtime add table deliberation_events;
