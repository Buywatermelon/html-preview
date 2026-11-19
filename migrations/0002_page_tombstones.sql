CREATE TABLE IF NOT EXISTS page_tombstones (
  id_hash TEXT PRIMARY KEY NOT NULL,
  public_id_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  share_token_hash TEXT UNIQUE
);
