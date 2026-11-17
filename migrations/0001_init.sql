PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  next TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS device_tokens_user_created ON device_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_codes_expires_at ON device_codes(expires_at);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  folder TEXT NOT NULL,
  sort_order INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL,
  published_from TEXT UNIQUE,
  deleting INTEGER NOT NULL DEFAULT 0,
  share_token TEXT,
  shared_at TEXT,
  UNIQUE(scope, name)
);
CREATE INDEX IF NOT EXISTS documents_scope ON documents(scope, sort_order, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_share_token
  ON documents(share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  storage_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL,
  files TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  source_version INTEGER,
  PRIMARY KEY(document_id, version),
  UNIQUE(document_id, source_version)
);

CREATE TABLE IF NOT EXISTS session_bindings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  host_id TEXT,
  host_name TEXT,
  opaque_binding TEXT,
  adapter_id TEXT NOT NULL,
  fallback_adapter_id TEXT,
  session_ref TEXT NOT NULL,
  cwd TEXT,
  source_file TEXT,
  adapter_meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_session_bindings_doc_ver
  ON session_bindings(document_id, version DESC);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL DEFAULT 1,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  anchor_json TEXT,
  intent TEXT NOT NULL CHECK (intent IN ('change', 'question')),
  prompt TEXT NOT NULL,
  target_host_id TEXT,
  target_host_name TEXT,
  target_adapter_id TEXT NOT NULL,
  effective_adapter_id TEXT,
  auto_fallback_from TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'leased',
      'dispatched',
      'working',
      'replied',
      'updated',
      'turn_completed',
      'needs_attention',
      'failed',
      'resolved'
    )
  ),
  progress_text TEXT,
  reply_text TEXT,
  result_version INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_interactions_doc_created
  ON interactions(document_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_interactions_thread
  ON interactions(thread_id, turn_index ASC);

CREATE TABLE IF NOT EXISTS interaction_deliveries (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_host_id TEXT,
  adapter_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending',
      'leased',
      'dispatched',
      'working',
      'replied',
      'turn_completed',
      'needs_attention',
      'failed'
    )
  ),
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  receipt_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (interaction_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_claim
  ON interaction_deliveries(owner_id, state, lease_until);
CREATE INDEX IF NOT EXISTS idx_deliveries_host_claim
  ON interaction_deliveries(owner_id, state, target_host_id, lease_until);

CREATE TABLE IF NOT EXISTS interaction_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (interaction_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_interaction_events_doc_seq
  ON interaction_events(document_id, seq ASC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_recent
  ON push_subscriptions(owner_id, updated_at DESC);
