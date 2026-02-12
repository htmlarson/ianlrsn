# ianlrsn

Static Linktree-style page for @ianlrsn, inspired by the neon green/red/blue look in the provided screenshot. Hosted on Cloudflare Pages at `ianlrsn.com`.

What's included:
- Mobile-first layout with animated background and bold color palette.
- Social icon row with local SVGs.
- Link tiles for Twitch, YouTube, Discord, TikTok, Instagram, and Nintendo friend code.
- Cash App placeholder removed with HTML comments for easy re-add.
- Cloudflare Pages Function at `/api/turnstile` that issues a server-assigned `session_id` and `user_id` (UUIDs).
- Cloudflare Worker cron job in `workers/twitch-live-cron` that fetches Twitch live status every minute and writes it to D1.
- Cloudflare Pages Function at `/api/twitch-live` that reads current Twitch state from D1.
- `/api/twitch-live` requires a valid `x-session-id` header that exists in `client_sessions`.
- Every `/api/twitch-live` request is logged to D1 with `session_id`, `user_id`, full headers, full `request.cf`, cache/result metadata, response code/payload, and timing.

Files:
- `index.html`
- `styles.css`
- `icons/`
- `functions/api/turnstile.js`
- `functions/api/twitch-live.js`
- `workers/twitch-live-cron/src/index.js`
- `workers/twitch-live-cron/wrangler.jsonc`

## Identity Flow

1. Browser calls `POST /api/turnstile` before checking live status.
2. If `localStorage` already has a `user_id`, it is sent in the turnstile request body as `{ "user_id": "..." }`.
3. Server always issues a fresh `session_id` and associates it with a `user_id`.
4. Browser stores:
- `session_id` in `sessionStorage` key `ianlrsn_session_id`
- `user_id` in `localStorage` key `ianlrsn_user_id`
5. Browser sends both IDs on `/api/twitch-live` using headers:
- `x-session-id`
- `x-user-id`

If `/api/twitch-live` returns `401`, the client refreshes `session_id` via `/api/turnstile` and retries once.

## Cloudflare Pages Setup

- Add D1 binding `REQUEST_LOGS_DB`.
- Run the D1 SQL below.

## Cloudflare Worker Setup (`workers/twitch-live-cron`)

- Add Worker secret `TWITCH_CLIENT_SECRET`.
- Keep the D1 binding in `workers/twitch-live-cron/wrangler.jsonc` as:
  - `binding`: `DB`
  - `database_name`: `ianlrsn`
  - `database_id`: `96bfb53d-dc1f-455e-b9f2-a60bcb6464b7`

### New Install SQL

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_user_id ON client_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_client_sessions_last_seen_at ON client_sessions(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  session_id TEXT,
  user_id TEXT,
  request_method TEXT,
  request_url TEXT,
  request_path TEXT,
  request_query TEXT,
  request_headers_json TEXT,
  cf_json TEXT,
  cf_country TEXT,
  cf_region TEXT,
  cf_city TEXT,
  cf_colo TEXT,
  cf_continent TEXT,
  cf_timezone TEXT,
  cf_asn INTEGER,
  cf_as_organization TEXT,
  cf_http_protocol TEXT,
  cf_tls_version TEXT,
  cf_tls_cipher TEXT,
  cf_client_tcp_rtt INTEGER,
  cf_bot_management_json TEXT,
  cache_status TEXT,
  from_cache INTEGER,
  stale INTEGER,
  live INTEGER,
  response_status INTEGER,
  response_json TEXT,
  error_code TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(response_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_cache_status ON request_logs(cache_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_session_id ON request_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);

CREATE TABLE IF NOT EXISTS api_cache_entries (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL
);

CREATE VIEW IF NOT EXISTS v_request_logs_enriched AS
SELECT
  id,
  created_at,
  session_id,
  user_id,
  request_method,
  request_url,
  request_path,
  request_query,
  cf_country,
  cf_region,
  cf_city,
  cf_colo,
  cf_timezone,
  cf_asn,
  cf_as_organization,
  cf_http_protocol,
  response_status,
  cache_status,
  live,
  error_code,
  duration_ms,
  CASE
    WHEN lower(ifnull(cf_http_protocol, '')) IN ('h3', 'http/3', 'web3') THEN 'web3'
    WHEN lower(ifnull(cf_http_protocol, '')) IN ('h2', 'http/2') THEN 'http2'
    WHEN lower(ifnull(cf_http_protocol, '')) IN ('http/1.1', 'http/1.0', 'http/1') THEN 'http1'
    ELSE 'other'
  END AS protocol_bucket
FROM request_logs;

CREATE VIEW IF NOT EXISTS v_distinct_regions AS
SELECT
  cf_country,
  cf_region,
  COUNT(*) AS request_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM v_request_logs_enriched
WHERE ifnull(trim(cf_region), '') <> ''
GROUP BY cf_country, cf_region
ORDER BY request_count DESC;

CREATE VIEW IF NOT EXISTS v_distinct_cities AS
SELECT
  cf_country,
  cf_region,
  cf_city,
  COUNT(*) AS request_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM v_request_logs_enriched
WHERE ifnull(trim(cf_city), '') <> ''
GROUP BY cf_country, cf_region, cf_city
ORDER BY request_count DESC;

CREATE VIEW IF NOT EXISTS v_protocol_summary AS
SELECT
  protocol_bucket,
  COUNT(*) AS request_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM v_request_logs_enriched
GROUP BY protocol_bucket
ORDER BY request_count DESC;

CREATE VIEW IF NOT EXISTS v_regions_web3 AS
SELECT
  cf_country,
  cf_region,
  COUNT(*) AS request_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM v_request_logs_enriched
WHERE protocol_bucket = 'web3'
  AND ifnull(trim(cf_region), '') <> ''
GROUP BY cf_country, cf_region
ORDER BY request_count DESC;

CREATE VIEW IF NOT EXISTS v_cities_web3 AS
SELECT
  cf_country,
  cf_region,
  cf_city,
  COUNT(*) AS request_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM v_request_logs_enriched
WHERE protocol_bucket = 'web3'
  AND ifnull(trim(cf_city), '') <> ''
GROUP BY cf_country, cf_region, cf_city
ORDER BY request_count DESC;
```

### Existing Install Migration SQL

If `request_logs` already exists from an earlier deployment, run this once:

```sql
ALTER TABLE request_logs ADD COLUMN session_id TEXT;
ALTER TABLE request_logs ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_request_logs_session_id ON request_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
```
