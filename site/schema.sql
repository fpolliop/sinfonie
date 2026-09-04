CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT,
  app_version TEXT,
  os TEXT,
  context TEXT,
  source TEXT NOT NULL DEFAULT 'site',
  ip_country TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS feedback_kind_created ON feedback (kind, created_at);
ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE feedback ADD COLUMN note TEXT;
CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status);
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT,
  os TEXT,
  engines TEXT,
  workspaces INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, install_id)
);
CREATE INDEX IF NOT EXISTS usage_install ON usage (install_id, day);
