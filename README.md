# ianlrsn by Andrew Larson

Static Linktree-style page for @ianlrsn, inspired by the neon green/red/blue look in the provided screenshot. Hosted on Cloudflare Pages at `ianlrsn.com`.

What's included:
- Mobile-first layout with animated background and bold color palette.
- Social icon row with local SVGs.
- Link tiles for Twitch, YouTube, Discord, TikTok, Instagram, and Nintendo friend code.
- Cash App placeholder removed with HTML comments for easy re-add.
- Cloudflare Pages Function at `/api/twitch-live` that checks Twitch live status with a 60s D1 cache.
- Every `/api/twitch-live` request is logged to D1 (headers, full `request.cf`, cache/result metadata, response code/payload, and timing).

Files:
- `index.html`
- `styles.css`
- `icons/`
- `functions/api/twitch-live.js`

Cloudflare Pages setup:
- Add environment variable `TWITCH_CLIENT_SECRET` (matching the Twitch app ID in `functions/api/twitch-live.js`).
- Add D1 binding `REQUEST_LOGS_DB`.
- Create these D1 tables:

```sql
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS api_cache_entries (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL
);
```
