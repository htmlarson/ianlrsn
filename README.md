# ianlrsn

Static Linktree-style page for @ianlrsn, inspired by the neon green/red/blue look in the provided screenshot. Hosted on Cloudflare Pages at `ianlrsn.com`.

What's included:
- Mobile-first layout with animated background and bold color palette.
- Social icon row with local SVGs.
- Link tiles for Twitch, YouTube, Discord, TikTok, Instagram, and Nintendo friend code.
- Cash App placeholder removed with HTML comments for easy re-add.
- Cloudflare Pages Function at `/api/twitch-live` that checks Twitch live status with a 60s KV cache.

Files:
- `index.html`
- `styles.css`
- `icons/`
- `functions/twitch-live.js`

Cloudflare Pages setup:
- Bind a KV namespace as `live_kv`.
- Add environment variable `TWITCH_CLIENT_SECRET` (matching the Twitch app ID in `functions/twitch-live.js`).
