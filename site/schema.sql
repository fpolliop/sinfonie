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
