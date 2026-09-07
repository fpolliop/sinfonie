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

-- Short-lived OAuth codes handed back to the desktop app by polling (state is unguessable, 5-minute life).
CREATE TABLE IF NOT EXISTS oauth_codes (
  state TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Screenshots attached to feedback (base64 in D1; small and few).
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  mime TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS attachments_feedback ON attachments(feedback_id);

-- ---------- accounts and plans ----------
-- People who signed in to Sinfonie with GitHub.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  -- Personal (Pro) subscription, from Paddle webhooks.
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  subscription_status TEXT,
  subscription_period TEXT,
  subscription_renews_at TEXT,
  subscription_ends_at TEXT,
  -- Manual grant: 'pro' or 'team' regardless of billing (founders, beta testers).
  plan_override TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS users_paddle_sub ON users (paddle_subscription_id);

-- Desktop sessions. Only the SHA-256 of the bearer token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Teams. One Paddle subscription per org, quantity = seats.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  subscription_status TEXT,
  subscription_period TEXT,
  subscription_renews_at TEXT,
  subscription_ends_at TEXT,
  seats INTEGER NOT NULL DEFAULT 0,
  plan_override TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS orgs_paddle_sub ON orgs (paddle_subscription_id);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_members_user ON org_members (user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_by TEXT,
  accepted_at TEXT
);

-- Every Paddle event we accepted, for idempotency and debugging.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subscription_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
