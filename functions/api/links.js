const NO_CACHE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: NO_CACHE_HEADERS,
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

const selectLinks = async (readDb) => {
  const { results } = await readDb
    .prepare(
      `
      SELECT service, url
      FROM links
      WHERE ifnull(trim(service), '') <> ''
        AND ifnull(trim(url), '') <> ''
      ORDER BY service COLLATE NOCASE ASC
      `
    )
    .all();

  return Array.isArray(results) ? results : [];
};

export async function onRequestGet({ env }) {
  try {
    const db = getDb(env);
    const readDb = getReadDb(db);
    const rows = await selectLinks(readDb);
    const links = {};

    for (const row of rows) {
      const service = String(row?.service || "").trim();
      const url = String(row?.url || "").trim();
      if (!service || !url) continue;
      links[service] = url;
    }

    return jsonResponse({
      links,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return jsonResponse(
      {
        links: {},
        error: "links_fetch_failed",
        checked_at: new Date().toISOString(),
      },
      500
    );
  }
}
