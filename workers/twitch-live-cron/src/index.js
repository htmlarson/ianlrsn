const TWITCH_CLIENT_ID = "tsuxllpdawrkk0jnkkcz1hjs9yb6p4";
const TWITCH_USERNAME = "ianlrsn";
const CACHE_KEY = "twitch-live";

const summarizeEnv = (env) =>
  JSON.stringify({
    binding_keys: Object.keys(env || {}).sort(),
  });

const setCacheRecord = async (db, cacheKey, payload, checkedAtMs, executionMeta) => {
  await db
    .prepare(
      `
      INSERT INTO api2_cache_entries (
        cache_key,
        payload_json,
        checked_at_ms,
        source_event_type,
        trigger_cron,
        scheduled_time_ms,
        request_url,
        request_method,
        request_path,
        request_cf_colo,
        request_cf_country,
        request_cf_region_code,
        request_cf_city,
        request_cf_timezone,
        request_cf_asn,
        request_cf_ray,
        runtime_env_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      cacheKey,
      JSON.stringify(payload || {}),
      checkedAtMs,
      executionMeta.sourceEventType || null,
      executionMeta.triggerCron || null,
      Number.isFinite(executionMeta.scheduledTimeMs)
        ? executionMeta.scheduledTimeMs
        : null,
      executionMeta.requestUrl || null,
      executionMeta.requestMethod || null,
      executionMeta.requestPath || null,
      executionMeta.requestCfColo || null,
      executionMeta.requestCfCountry || null,
      executionMeta.requestCfRegionCode || null,
      executionMeta.requestCfCity || null,
      executionMeta.requestCfTimezone || null,
      Number.isFinite(executionMeta.requestCfAsn) ? executionMeta.requestCfAsn : null,
      executionMeta.requestCfRay || null,
      executionMeta.runtimeEnvJson || null
    )
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

const runTwitchUpdate = async (env, options) => {
  const { updatedBy, event = null, request = null } = options || {};
  if (!env.DB) {
    throw new Error("missing_d1_binding_DB");
  }
  if (!env.TWITCH_CLIENT_SECRET) {
    throw new Error("missing_twitch_client_secret");
  }

  const checkedAtMs = Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const live = await fetchLiveStatus(env.TWITCH_CLIENT_SECRET);
  const requestUrl = request ? new URL(request.url) : null;
  const cf = request?.cf || null;

  const executionMeta = {
    sourceEventType: updatedBy,
    triggerCron: event?.cron || null,
    scheduledTimeMs: event?.scheduledTime,
    requestUrl: request?.url || null,
    requestMethod: request?.method || null,
    requestPath: requestUrl?.pathname || null,
    requestCfColo: cf?.colo || null,
    requestCfCountry: cf?.country || null,
    requestCfRegionCode: cf?.regionCode || null,
    requestCfCity: cf?.city || null,
    requestCfTimezone: cf?.timezone || null,
    requestCfAsn: cf?.asn,
    requestCfRay: request?.headers?.get("cf-ray") || null,
    runtimeEnvJson: summarizeEnv(env),
  };

  await setCacheRecord(
    env.DB,
    CACHE_KEY,
    {
      live,
      checked_at: checkedAt,
      updated_by: updatedBy,
    },
    checkedAtMs,
    executionMeta
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
      await runTwitchUpdate(env, { updatedBy: "http", request });
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
      runTwitchUpdate(env, { updatedBy: "cron", event: _event }).catch((error) => {
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
