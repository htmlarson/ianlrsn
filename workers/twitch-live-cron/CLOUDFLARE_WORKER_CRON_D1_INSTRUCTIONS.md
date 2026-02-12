# Cloudflare Worker 1-Minute D1 Twitch Updater

## Objective
Run a cron Worker every minute, fetch Twitch live status, and write the current state to D1 for the Pages API to read.

## Platform facts
- Cloudflare Cron Triggers use 5-field cron syntax (minute-level granularity).
- One-minute cadence (`* * * * *`) is the target for this worker.
- No Durable Object is required for this setup.

## Implementation plan
1. Create a Worker with a `scheduled()` handler.
2. Configure `triggers.crons = ["* * * * *"]` in `wrangler.jsonc` or `wrangler.toml`.
3. Add the D1 database binding as `DB`.
4. Add Worker secret `TWITCH_CLIENT_SECRET`.
5. In `scheduled()`, call Twitch, compute `live`, and upsert `api_cache_entries` with key `twitch-live`.
6. Add minimal error handling and logging:
   - Log run ID, start/end, and errors.
7. Test locally:
   - `wrangler dev --test-scheduled`
   - Trigger scheduled endpoint and verify the D1 write occurs.
8. Deploy and validate:
   - Deploy with Wrangler.
   - Confirm trigger events and DB rows.

## Required config shape (reference)
```jsonc
{
  "main": "src/index.js",
  "compatibility_date": "2026-02-12",
  "triggers": { "crons": ["* * * * *"] },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ianlrsn",
      "database_id": "96bfb53d-dc1f-455e-b9f2-a60bcb6464b7"
    }
  ]
}
```

## Guardrails
- Keep each run short and bounded.
- Make job logic re-entrant and safe on retries (at-least-once behavior).
- Use parameterized SQL (`prepare().bind(...)`) for all dynamic values.
