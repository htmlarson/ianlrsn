const TWITCH_CLIENT_ID = "7tiifmm8jdm1lfqrielkfho92fjzwb";
const TWITCH_USERNAME = "ianlrsn";
const CACHE_KEY = "data";
const CACHE_TTL_MS = 60000;

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export async function onRequestGet({ request, env }) {
  const now = Date.now();
  let cached;
  let cachedPayload;
  let cacheAgeMs;
  const url = new URL(request.url);
  const bypassCache = url.searchParams.get("refresh") === "1";
  const cf = request.cf || {};

  try {
    if (!bypassCache) {
      cached = await env.live_kv.get(CACHE_KEY);
      if (cached) {
        cachedPayload = JSON.parse(cached);
        const checkedAt = Date.parse(cachedPayload?.checked_at);
        cacheAgeMs = Number.isNaN(checkedAt) ? undefined : now - checkedAt;
        if (cacheAgeMs !== undefined && cacheAgeMs < CACHE_TTL_MS) {
          const needsFirstHit =
            !cachedPayload?.cache_first_hit &&
            (cf.country || cf.region || cf.colo);
          let updatedPayload = cachedPayload;
          if (needsFirstHit) {
            updatedPayload = {
              ...cachedPayload,
              cache_first_hit: {
                at: new Date(now).toISOString(),
                location: {
                  country: cf.country,
                  region: cf.region,
                  colo: cf.colo,
                },
              },
            };
            await env.live_kv.put(CACHE_KEY, JSON.stringify(updatedPayload), {
              expirationTtl: Math.ceil(CACHE_TTL_MS / 1000),
            });
          }
          return jsonResponse({
            live: Boolean(updatedPayload.live),
            checked_at: updatedPayload.checked_at,
            from_cache: true,
            cache_age_ms: cacheAgeMs,
            cache_status: "hit",
            cache_first_hit: updatedPayload.cache_first_hit,
          });
        }
      }
    }
  } catch (error) {
    cachedPayload = undefined;
    cacheAgeMs = undefined;
  }

  const clientSecret = env.TWITCH_CLIENT_SECRET;
  if (!clientSecret) {
    return jsonResponse(
      {
        live: false,
        checked_at: new Date(now).toISOString(),
        error: "missing_twitch_client_secret",
      },
      500
    );
  }

  try {
    const tokenParams = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const tokenResponse = await fetch(
      `https://id.twitch.tv/oauth2/token?${tokenParams.toString()}`,
      { method: "POST" }
    );

    if (!tokenResponse.ok) {
      throw new Error("token request failed");
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      throw new Error("missing access token");
    }

    const streamResponse = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${TWITCH_USERNAME}`,
      {
        headers: {
          "Client-ID": TWITCH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!streamResponse.ok) {
      throw new Error("stream request failed");
    }

    const streamData = await streamResponse.json();
    const live = Array.isArray(streamData?.data) && streamData.data.length > 0;
    const payload = {
      live,
      checked_at: new Date(now).toISOString(),
    };

    await env.live_kv.put(CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: Math.ceil(CACHE_TTL_MS / 1000),
    });

    return jsonResponse({
      ...payload,
      from_cache: false,
      cache_status: bypassCache ? "bypass" : "miss",
    });
  } catch (error) {
    if (cachedPayload?.checked_at) {
      return jsonResponse({
        live: Boolean(cachedPayload.live),
        checked_at: cachedPayload.checked_at,
        from_cache: true,
        stale: true,
        cache_age_ms: cacheAgeMs,
        cache_status: "stale",
      });
    }

    return jsonResponse(
      {
        live: false,
        checked_at: new Date(now).toISOString(),
        error: "twitch_fetch_failed",
      },
      502
    );
  }
}
