const TWITCH_CLIENT_ID = "7tiifmm8jdm1lfqrielkfho92fjzwb";
const TWITCH_USERNAME = "ianlrsn";
const CACHE_KEY = "twitch-live";
const CACHE_TTL_MS = 60000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const getDb = (env) => {
  const db = env.REQUEST_LOGS_DB || env.DB;
  if (!db) {
    throw new Error("missing_d1_binding_REQUEST_LOGS_DB");
  }
  return db;
};

const getReadDb = (db) => {
  if (typeof db.withSession !== "function") {
    return db;
  }

  // Prefer replica reads when available; writes stay on primary via `db`.
  return db.withSession("first-unconstrained");
};

const serializeHeaders = (headers) => {
  const out = {};
  try {
    for (const [key, value] of headers.entries()) {
      out[key] = value;
    }
  } catch (error) {
    // Ignore serialization failures.
  }
  return out;
};

const isUuid = (value) => UUID_RE.test(String(value || ""));

const getRequestIdentity = (request) => {
  const sessionId = request.headers.get("x-session-id")?.trim() || null;
  const userId = request.headers.get("x-user-id")?.trim() || null;
  return { sessionId, userId };
};

const getCacheRecord = async (db, cacheKey) => {
  const row = await db
    .prepare(
      `
      SELECT payload_json, checked_at_ms
      FROM api_cache_entries
      WHERE cache_key = ?
      LIMIT 1
      `
    )
    .bind(cacheKey)
    .first();

  if (!row) {
    return null;
  }

  try {
    return {
      payload: JSON.parse(row.payload_json),
      checkedAtMs: row.checked_at_ms,
    };
  } catch (error) {
    return null;
  }
};

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

const getValidatedSession = async (readDb, request) => {
  const { sessionId, userId } = getRequestIdentity(request);

  if (!sessionId) {
    return { ok: false, sessionId: null, userId: null, errorCode: "missing_session_id" };
  }

  if (!isUuid(sessionId)) {
    return {
      ok: false,
      sessionId,
      userId: userId || null,
      errorCode: "invalid_session_id_format",
    };
  }

  if (userId && !isUuid(userId)) {
    return {
      ok: false,
      sessionId,
      userId,
      errorCode: "invalid_user_id_format",
    };
  }

  const row = await readDb
    .prepare(
      `
      SELECT session_id, user_id, revoked_at
      FROM client_sessions
      WHERE session_id = ?
      LIMIT 1
      `
    )
    .bind(sessionId)
    .first();

  if (!row || row.revoked_at) {
    return {
      ok: false,
      sessionId,
      userId: userId || null,
      errorCode: "unknown_or_revoked_session",
    };
  }

  if (userId && userId !== row.user_id) {
    return {
      ok: false,
      sessionId,
      userId,
      errorCode: "session_user_mismatch",
    };
  }

  return { ok: true, sessionId: row.session_id, userId: row.user_id, errorCode: null };
};

const touchSession = async (db, sessionId) => {
  await db
    .prepare(
      `
      UPDATE client_sessions
      SET last_seen_at = ?
      WHERE session_id = ?
      `
    )
    .bind(new Date().toISOString(), sessionId)
    .run();
};

const logRequestToD1 = async ({
  db,
  request,
  startedAtMs,
  status,
  responsePayload,
  cacheStatus,
  fromCache,
  stale,
  live,
  errorCode,
  sessionId,
  userId,
}) => {
  const now = Date.now();
  const url = new URL(request.url);
  const cf = request.cf || {};

  try {
    await db
      .prepare(
        `
        INSERT INTO request_logs (
          created_at,
          session_id,
          user_id,
          request_method,
          request_url,
          request_path,
          request_query,
          request_headers_json,
          cf_json,
          cf_country,
          cf_region,
          cf_city,
          cf_colo,
          cf_continent,
          cf_timezone,
          cf_asn,
          cf_as_organization,
          cf_http_protocol,
          cf_tls_version,
          cf_tls_cipher,
          cf_client_tcp_rtt,
          cf_bot_management_json,
          cache_status,
          from_cache,
          stale,
          live,
          response_status,
          response_json,
          error_code,
          duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        new Date(now).toISOString(),
        sessionId || null,
        userId || null,
        request.method,
        request.url,
        url.pathname,
        url.search,
        JSON.stringify(serializeHeaders(request.headers)),
        JSON.stringify(cf),
        cf.country || null,
        cf.region || null,
        cf.city || null,
        cf.colo || null,
        cf.continent || null,
        cf.timezone || null,
        Number.isFinite(cf.asn) ? cf.asn : null,
        cf.asOrganization || null,
        cf.httpProtocol || null,
        cf.tlsVersion || null,
        cf.tlsCipher || null,
        Number.isFinite(cf.clientTcpRtt) ? cf.clientTcpRtt : null,
        JSON.stringify(cf.botManagement || null),
        cacheStatus || null,
        fromCache ? 1 : 0,
        stale ? 1 : 0,
        typeof live === "boolean" ? (live ? 1 : 0) : null,
        status,
        JSON.stringify(responsePayload || null),
        errorCode || null,
        now - startedAtMs
      )
      .run();
  } catch (error) {
    // Never fail API response due to logging errors.
  }
};

export async function onRequestGet({ request, env }) {
  const startedAtMs = Date.now();
  const nowIso = new Date(startedAtMs).toISOString();
  const url = new URL(request.url);
  const bypassCache = url.searchParams.get("refresh") === "1";
  const debugBindings = url.searchParams.get("debug_bindings") === "1";

  let db;
  let readDb;
  let cachedPayload = null;
  let cacheAgeMs;
  let sessionId = null;
  let userId = null;

  try {
    db = getDb(env);
    readDb = getReadDb(db);

    const auth = await getValidatedSession(readDb, request);
    sessionId = auth.sessionId;
    userId = auth.userId;

    if (!auth.ok) {
      const payload = {
        live: false,
        checked_at: nowIso,
        error: "invalid_session",
        error_code: auth.errorCode,
      };

      await logRequestToD1({
        db,
        request,
        startedAtMs,
        status: 401,
        responsePayload: payload,
        cacheStatus: "unauthorized",
        fromCache: false,
        stale: false,
        live: false,
        errorCode: auth.errorCode,
        sessionId,
        userId,
      });

      return jsonResponse(payload, 401);
    }

    await touchSession(db, sessionId);

    if (!bypassCache) {
      const cacheRecord = await getCacheRecord(readDb, CACHE_KEY);
      if (cacheRecord?.payload?.checked_at) {
        cacheAgeMs = startedAtMs - cacheRecord.checkedAtMs;
        cachedPayload = cacheRecord.payload;

        if (cacheAgeMs >= 0 && cacheAgeMs < CACHE_TTL_MS) {
          const payload = {
            live: Boolean(cacheRecord.payload.live),
            checked_at: cacheRecord.payload.checked_at,
            from_cache: true,
            cache_age_ms: cacheAgeMs,
            cache_status: "hit",
          };

          await logRequestToD1({
            db,
            request,
            startedAtMs,
            status: 200,
            responsePayload: payload,
            cacheStatus: "hit",
            fromCache: true,
            stale: false,
            live: payload.live,
            errorCode: null,
            sessionId,
            userId,
          });

          return jsonResponse(payload);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissingBinding = message.includes("missing_d1_binding");
    const payload = {
      live: false,
      checked_at: nowIso,
      error: isMissingBinding ? "missing_d1_binding" : "d1_init_failed",
    };
    if (debugBindings) {
      payload.debug = {
        init_error: message,
        has_REQUEST_LOGS_DB: Boolean(env.REQUEST_LOGS_DB),
        has_DB: Boolean(env.DB),
        binding_keys: Object.keys(env || {}).sort(),
      };
    }

    return jsonResponse(payload, 500);
  }

  const clientSecret = env.TWITCH_CLIENT_SECRET;
  if (!clientSecret) {
    const payload = {
      live: false,
      checked_at: nowIso,
      error: "missing_twitch_client_secret",
    };

    await logRequestToD1({
      db,
      request,
      startedAtMs,
      status: 500,
      responsePayload: payload,
      cacheStatus: bypassCache ? "bypass" : "miss",
      fromCache: false,
      stale: false,
      live: false,
      errorCode: "missing_twitch_client_secret",
      sessionId,
      userId,
    });

    return jsonResponse(payload, 500);
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
    const live = Array.isArray(streamData?.data) && streamData.data.length > 0;
    const payload = {
      live,
      checked_at: nowIso,
    };

    await setCacheRecord(db, CACHE_KEY, payload, startedAtMs);

    const responsePayload = {
      ...payload,
      from_cache: false,
      cache_status: bypassCache ? "bypass" : "miss",
    };

    await logRequestToD1({
      db,
      request,
      startedAtMs,
      status: 200,
      responsePayload: responsePayload,
      cacheStatus: responsePayload.cache_status,
      fromCache: false,
      stale: false,
      live,
      errorCode: null,
      sessionId,
      userId,
    });

    return jsonResponse(responsePayload);
  } catch (error) {
    if (cachedPayload?.checked_at) {
      const payload = {
        live: Boolean(cachedPayload.live),
        checked_at: cachedPayload.checked_at,
        from_cache: true,
        stale: true,
        cache_age_ms: cacheAgeMs,
        cache_status: "stale",
      };

      await logRequestToD1({
        db,
        request,
        startedAtMs,
        status: 200,
        responsePayload: payload,
        cacheStatus: "stale",
        fromCache: true,
        stale: true,
        live: payload.live,
        errorCode: "twitch_fetch_failed",
        sessionId,
        userId,
      });

      return jsonResponse(payload);
    }

    const payload = {
      live: false,
      checked_at: new Date().toISOString(),
      error: "twitch_fetch_failed",
    };

    await logRequestToD1({
      db,
      request,
      startedAtMs,
      status: 502,
      responsePayload: payload,
      cacheStatus: bypassCache ? "bypass" : "miss",
      fromCache: false,
      stale: false,
      live: false,
      errorCode: "twitch_fetch_failed",
      sessionId,
      userId,
    });

    return jsonResponse(payload, 502);
  }
}
