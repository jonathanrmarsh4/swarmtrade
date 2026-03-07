-- Migration 020: Config audit log
-- Tracks all changes to risk settings and agent configuration.
-- The analyst chat is aware of this table and will proactively mention active non-default settings.

CREATE TABLE IF NOT EXISTS config_audit_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  changed_at  timestamptz DEFAULT now(),
  setting_key text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  text DEFAULT 'user',
  reason      text
);

CREATE INDEX IF NOT EXISTS idx_config_audit_log_changed_at
  ON config_audit_log (changed_at DESC);
