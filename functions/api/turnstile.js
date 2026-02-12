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

  return db.withSession("first-unconstrained");
};

const isUuid = (value) => UUID_RE.test(String(value || ""));

const parseRequestBody = async (request) => {
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      return body;
    }
  } catch (error) {
    // Empty or invalid JSON gets treated as no-op input.
  }
  return {};
};

const selectExistingUserId = async (readDb, requestedUserId) => {
  if (!isUuid(requestedUserId)) {
    return null;
  }

  const row = await readDb
    .prepare(
      `
      SELECT user_id
      FROM users
      WHERE user_id = ?
      LIMIT 1
      `
    )
    .bind(requestedUserId)
    .first();

  return row?.user_id || null;
};

const upsertUser = async (db, userId, nowIso) => {
  await db
    .prepare(
      `
      INSERT INTO users (user_id, created_at, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at
      `
    )
    .bind(userId, nowIso, nowIso)
    .run();
};

const createSession = async (db, sessionId, userId, nowIso) => {
  await db
    .prepare(
      `
      INSERT INTO client_sessions (session_id, user_id, created_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
      `
    )
    .bind(sessionId, userId, nowIso, nowIso)
    .run();
};

export async function onRequestPost({ request, env }) {
  const nowIso = new Date().toISOString();

  try {
    const db = getDb(env);
    const readDb = getReadDb(db);
    const body = await parseRequestBody(request);
    const requestedUserId = body.user_id;

    const existingUserId = await selectExistingUserId(readDb, requestedUserId);
    const userId = existingUserId || crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    await upsertUser(db, userId, nowIso);
    await createSession(db, sessionId, userId, nowIso);

    return jsonResponse({
      user_id: userId,
      session_id: sessionId,
      issued_at: nowIso,
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "turnstile_failed",
        checked_at: nowIso,
      },
      500
    );
  }
}
