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
  -- One or both identities; a second provider with the same verified email links to the same user.
  github_id INTEGER UNIQUE,
  google_id TEXT UNIQUE,
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
CREATE INDEX IF NOT EXISTS users_email ON users (email);

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

-- Coupon codes: a code grants a plan for free (beta users, friends). Redeeming sets users.plan_override.
ALTER TABLE users ADD COLUMN plan_override_until TEXT;
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'team',
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  -- How long the granted plan lasts after redemption, in days; NULL means for good.
  duration_days INTEGER,
  expires_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, user_id)
);

-- Admin-editable settings (trial on/off and length); defaults live in _session.js.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE coupons ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
-- The cardless trial every new account gets, separate from coupon grants (plan_override).
ALTER TABLE users ADD COLUMN trial_plan TEXT;
ALTER TABLE users ADD COLUMN trial_until TEXT;

-- ---------- organisations ----------
-- Several verified emails per account; the primary is what users.email holds.
CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT,
  verified INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS user_emails_user ON user_emails (user_id);
-- Organisations grow a slug and a domain-join policy: open (anyone with a verified email on a verified domain joins), approval (an admin approves), off.
ALTER TABLE orgs ADD COLUMN slug TEXT;
ALTER TABLE orgs ADD COLUMN domain_join TEXT NOT NULL DEFAULT 'approval';
CREATE UNIQUE INDEX IF NOT EXISTS orgs_slug ON orgs (slug);
-- Domains an organisation claims; verified through a DNS TXT record on _sinfonie.<domain>.
CREATE TABLE IF NOT EXISTS org_domains (
  domain TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  token TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS org_domains_org ON org_domains (org_id);
-- People who asked to join through a domain that requires approval.
CREATE TABLE IF NOT EXISTS org_join_requests (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by TEXT,
  decided_at TEXT,
  PRIMARY KEY (org_id, user_id)
);
-- Spaces shared inside an organisation: the definition every member syncs, versioned for last-write-wins.
CREATE TABLE IF NOT EXISTS org_spaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS org_spaces_org ON org_spaces (org_id);

-- What each member is working on inside a shared space: names, branches, stages, times. Never chat content.
CREATE TABLE IF NOT EXISTS org_workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  stage TEXT,
  status TEXT,
  repos TEXT NOT NULL,
  ticket TEXT,
  last_activity_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS org_workspaces_space ON org_workspaces (org_space_id);
CREATE INDEX IF NOT EXISTS org_workspaces_user ON org_workspaces (user_id);

-- How members experience the app on their first sign-in: guided (build with AI, no code) or expert. Their own setting wins afterwards.
ALTER TABLE orgs ADD COLUMN default_mode TEXT NOT NULL DEFAULT 'expert';
