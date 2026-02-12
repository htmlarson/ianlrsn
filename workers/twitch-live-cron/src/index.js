const TWITCH_CLIENT_ID = "tsuxllpdawrkk0jnkkcz1hjs9yb6p4";
const TWITCH_USERNAME = "ianlrsn";
const CACHE_KEY = "twitch-live";

const setCacheRecord = async (db, cacheKey, payload, checkedAtMs) => {
  await db
    .prepare(
      `
      INSERT INTO api_cache_entries (cache_key, payload_json, checked_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        checked_at_ms = excluded.checked_at_ms
      `
    )
    .bind(cacheKey, JSON.stringify(payload || {}), checkedAtMs)
    .run();
};

const fetchLiveStatus = async (clientSecret) => {
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
    throw new Error("token_request_failed");
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData?.access_token;
  if (!accessToken) {
    throw new Error("missing_access_token");
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
    throw new Error("stream_request_failed");
  }

  const streamData = await streamResponse.json();
  return Array.isArray(streamData?.data) && streamData.data.length > 0;
};

const runTwitchUpdate = async (env, updatedBy) => {
  if (!env.DB) {
    throw new Error("missing_d1_binding_DB");
  }
  if (!env.TWITCH_CLIENT_SECRET) {
    throw new Error("missing_twitch_client_secret");
  }

  const checkedAtMs = Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const live = await fetchLiveStatus(env.TWITCH_CLIENT_SECRET);

  await setCacheRecord(
    env.DB,
    CACHE_KEY,
    {
      live,
      checked_at: checkedAt,
      updated_by: updatedBy,
    },
    checkedAtMs
  );

  console.log(
    JSON.stringify({
      event: "twitch_live_updated",
      live,
      checked_at: checkedAt,
      updated_by: updatedBy,
    })
  );
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const shouldUpdate = url.searchParams.get("update") === "1";

    if (!shouldUpdate) {
      return Response.json({ ok: true, mode: "http", updated: false });
    }

    try {
      await runTwitchUpdate(env, "http");
      return Response.json({ ok: true, mode: "http", updated: true });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          mode: "http",
          updated: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runTwitchUpdate(env, "cron").catch((error) => {
        console.error(
          JSON.stringify({
            event: "twitch_live_update_failed",
            error: error instanceof Error ? error.message : String(error),
          })
        );
      })
    );
  },
};
