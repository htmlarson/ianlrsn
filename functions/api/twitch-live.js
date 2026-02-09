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

export async function onRequestGet({ env }) {
  const now = Date.now();
  let cached;
  let cachedPayload;

  try {
    cached = await env.live_kv.get(CACHE_KEY);
    if (cached) {
      cachedPayload = JSON.parse(cached);
      const checkedAt = Date.parse(cachedPayload?.checked_at);
      if (!Number.isNaN(checkedAt) && now - checkedAt < CACHE_TTL_MS) {
        return jsonResponse({
          live: Boolean(cachedPayload.live),
          checked_at: cachedPayload.checked_at,
          from_cache: true,
        });
      }
    }
  } catch (error) {
    cachedPayload = undefined;
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

    await env.live_kv.put(CACHE_KEY, JSON.stringify(payload));

    return jsonResponse({
      ...payload,
      from_cache: false,
    });
  } catch (error) {
    if (cachedPayload?.checked_at) {
      return jsonResponse({
        live: Boolean(cachedPayload.live),
        checked_at: cachedPayload.checked_at,
        from_cache: true,
        stale: true,
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
