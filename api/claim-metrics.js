// /api/claim-metrics.js  (CommonJS, Supabase + Vercel)
// Adds optional filters:
//   - exclude_zero=1   -> drop rows with paid_amt <= 0
//   - min_paid=NUMBER  -> keep only rows with paid_amt >= NUMBER

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required by Supabase
});

const MIN_N = 12;            // minimum rows required to accept a scope
const MAX_RADIUS_ZIPS = 50;  // nearest ZIPs to consider in radius fallback

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function dollars(n) { return Math.round(Number(n || 0)); }

// Filter helper: apply exclude_zero and min_paid
function filterRows(rows, excludeZero, minPaid) {
  return rows.filter(r => {
    const v = Number(r.paid_amt);
    if (!Number.isFinite(v)) return false;
    if (excludeZero && v <= 0) return false;
    if (v < minPaid) return false;
    return true;
  });
}

function summarize(rows, meta, zip, y0, y1, level) {
  const vals = rows.map(r => Number(r.paid_amt)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;

  const idx = p => Math.max(0, Math.min(vals.length - 1, Math.floor((p / 100) * vals.length)));

  const byYear = {};
  rows.forEach(r => {
    const y = Number(r.dos_year);
    if (y >= y0 && y <= y1) {
      (byYear[y] = byYear[y] || []).push(Number(r.paid_amt));
    }
  });

  const trend = Object.keys(byYear).map(y => {
    const arr = byYear[y].sort((a, b) => a - b);
    return { year: Number(y), median: dollars(arr[Math.floor(arr.length / 2)]) };
  }).sort((a, b) => a.year - b.year);

  return {
    query_zip: zip,
    used_scope: { level, sample_size: rows.length, ...meta },
    metrics: {
      year_window: `${y0}-${y1}`,
      mean: dollars(vals.reduce((s, n) => s + n, 0) / vals.length),
      median: dollars(vals[Math.floor(vals.length / 2)]),
      p25: dollars(vals[idx(25)]),
      p75: dollars[idx(75)] ? dollars(vals[idx(75)]) : dollars(vals[vals.length - 1]),
      trend_by_year: trend
    }
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const zip = String(req.query.zip || "").trim();
    const cpt = String(req.query.cpt || "").trim();
    const y0 = Number(req.query.year_from || "2021");
    const y1 = Number(req.query.year_to || "2025");
    const debug = String(req.query.debug || "") === "1";

    // NEW: optional filters
    const excludeZero = String(req.query.exclude_zero || "") === "1";
    const minPaid = Number(req.query.min_paid || "0"); // e.g., 50 to drop tiny pays

    if (!/^\d{5}$/.test(zip) || !/^\d{4,5}$/.test(cpt)) {
      return res.status(400).json({ error: "bad params" });
    }

    const client = await pool.connect();
    try {
      const runQuery = async (sql, params, level, meta) => {
        const q = await client.query(sql, params);
        const filtered = filterRows(q.rows, excludeZero, minPaid);
        if (filtered.length >= MIN_N) {
          return summarize(filtered, meta, zip, y0, y1, level);
        }
        return null;
      };

      // 1) Exact ZIP
      let resObj = await runQuery(
        `select paid_amt, dos_year
           from claims
          where zip5 = $1 and cpt = $2 and dos_year between $3 and $4`,
        [zip, cpt, y0, y1],
        "zip",
        { representative_zip: zip }
      );
      if (resObj) return res.json(resObj);

      // 2) ZIP3
      const zip3 = zip.slice(0, 3);
      resObj = await runQuery(
        `select paid_amt, dos_year
           from claims
          where substring(zip5,1,3) = $1 and cpt = $2 and dos_year between $3 and $4`,
        [zip3, cpt, y0, y1],
        "zip3",
        {}
      );
      if (resObj) return res.json(resObj);

      // Get geo for radius/state
      const zg = await client.query(
        `select state, lat, lon from zip_geometry where zip5 = $1 limit 1`,
        [zip]
      );
      const qgeo = zg.rows[0];

      // 3) Radius (nearest ZIPs, join claims)
      if (qgeo) {
        resObj = await runQuery(
          `with q as (select $1::float as qlat, $2::float as qlon),
           nearest as (
             select z.zip5,
                    (3959 * 2 * asin(
                      sqrt( power(sin(radians((z.lat - q.qlat)/2)),2) +
                            cos(radians(q.qlat))*cos(radians(z.lat))*
                            power(sin(radians((z.lon - q.qlon)/2)),2) )
                    )) as dist_mi
               from zip_geometry z, q
              order by dist_mi asc
              limit $3
           )
           select c.paid_amt, c.dos_year
             from nearest n
             join claims c on c.zip5 = n.zip5
            where c.cpt = $4 and c.dos_year between $5 and $6`,
          [qgeo.lat, qgeo.lon, MAX_RADIUS_ZIPS, cpt, y0, y1],
          "radius",
          { representative_zip: zip }
        );
        if (resObj) return res.json(resObj);
      }

      // 4) State
      if (qgeo?.state) {
        resObj = await runQuery(
          `select paid_amt, dos_year
             from claims
            where state = $1 and cpt = $2 and dos_year between $3 and $4`,
          [qgeo.state, cpt, y0, y1],
          "state",
          { state: qgeo.state }
        );
        if (resObj) return res.json(resObj);
      }

      // 5) National
      resObj = await runQuery(
        `select paid_amt, dos_year
           from claims
          where cpt = $1 and dos_year between $2 and $3`,
        [cpt, y0, y1],
        "national",
        {}
      );
      if (resObj) return res.json(resObj);

      // Nothing met MIN_N after filtering
      return res.json({
        query_zip: zip,
        used_scope: { level: null, sample_size: 0 },
        metrics: null
      });
    } finally {
      client.release();
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const debug = String(req.query.debug || "") === "1";
    console.error("API ERROR:", msg);
    res.status(500).json({ error: "server error", ...(debug ? { detail: msg } : {}) });
  }
};
