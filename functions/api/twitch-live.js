const CACHE_KEY = "twitch-live";
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
  const debugBindings =
    new URL(request.url).searchParams.get("debug_bindings") === "1";

  let db;
  let readDb;
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
  const cacheRecord = await getCacheRecord(readDb, CACHE_KEY);
  if (cacheRecord?.payload?.checked_at) {
    const payload = {
      live: Boolean(cacheRecord.payload.live),
      checked_at: cacheRecord.payload.checked_at,
      updated_by: cacheRecord.payload.updated_by || "unknown",
      source: "d1",
    };

    await logRequestToD1({
      db,
      request,
      startedAtMs,
      status: 200,
      responsePayload: payload,
      cacheStatus: "db",
      fromCache: true,
      stale: false,
      live: payload.live,
      errorCode: null,
      sessionId,
      userId,
    });

    return jsonResponse(payload);
  }

  const payload = {
    live: false,
    checked_at: nowIso,
    updated_by: "unknown",
    source: "d1",
    error: "twitch_state_unavailable",
  };

  await logRequestToD1({
    db,
    request,
    startedAtMs,
    status: 200,
    responsePayload: payload,
    cacheStatus: "empty",
    fromCache: false,
    stale: false,
    live: false,
    errorCode: "twitch_state_unavailable",
    sessionId,
    userId,
  });

  return jsonResponse(payload);
}
