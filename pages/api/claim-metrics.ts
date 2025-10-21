// pages/api/claim-metrics.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// ── ENV ────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!; // server-only
const CORS_ORIGIN = process.env.CLAIMS_ALLOWED_ORIGIN || '*';      // set to your Squarespace domain when live

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const pct = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
};
const median = (sorted: number[]) => pct(sorted, 0.5);
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

const bad = (res: NextApiResponse, code: number, msg: string) =>
  res.status(code).json({ error: msg });

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return bad(res, 405, 'Method not allowed');

  // Inputs
  const zip = String(req.query.zip || '').trim();
  const cpt = String(req.query.cpt || '').trim();
  const ignoreZero = String(req.query.ignoreZero ?? 'true').toLowerCase() === 'true';

  if (!/^\d{5}$/.test(zip)) return bad(res, 400, 'zip must be 5 digits');
  if (!/^\d{5}$/.test(cpt)) return bad(res, 400, 'cpt must be 5 digits');

  // 5-year window anchored on current year
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const yStart = currentYear - 4;
  const yEnd = currentYear;

  // Pull claim rows
  // EXPECTED columns: zip5 (text), cpt (text), paid_amt (numeric), dos_year (int)
  // Table name: 'claims' (change to your actual table/view if different)
  const { data: claimRows, error: claimErr } = await supabase
    .from('claims')
    .select('zip5, cpt, paid_amt, dos_year')
    .eq('zip5', zip)
    .eq('cpt', cpt)
    .gte('dos_year', yStart)
    .lte('dos_year', yEnd)
    .limit(50000);

  if (claimErr) return bad(res, 500, `db error: ${claimErr.message}`);

  // Filter and prep values
  let amounts: number[] = [];
  const byYearAmounts = new Map<number, number[]>();

  for (const r of claimRows || []) {
    const amt = n((r as any).paid_amt);
    const yr = n((r as any).dos_year);
    if (amt === null || yr === null) continue;
    if (ignoreZero && amt <= 0) continue;
    amounts.push(amt);
    if (!byYearAmounts.has(yr)) byYearAmounts.set(yr, []);
    byYearAmounts.get(yr)!.push(amt);
  }

  const sorted = [...amounts].sort((a, b) => a - b);
  const stats = {
    mean: mean(sorted),
    median: median(sorted),
    p25: pct(sorted, 0.25),
    p75: pct(sorted, 0.75),
    sample_size: sorted.length,
  };

  // Pull wRVU by CPT and year (if you have rvu_master)
  // EXPECTED columns in rvu_master: cpt_code (text), year (int), wrvu (numeric)
  // If your column names differ, tell me and I’ll align them.
  const { data: rvuRows, error: rvuErr } = await supabase
    .from('rvu_master')
    .select('cpt_code, year, wrvu')
    .eq('cpt_code', cpt)
    .gte('year', yStart)
    .lte('year', yEnd)
    .limit(50);

  // Build year->wrvu map
  const wrvuByYear = new Map<number, number>();
  if (!rvuErr) {
    for (const r of rvuRows || []) {
      const yr = n((r as any).year);
      const wr = n((r as any).wrvu);
      if (yr && wr && wr > 0) wrvuByYear.set(yr, wr);
    }
  }

  // Compute per-claim $/wRVU ratios where we have both amt and wrvu>0 for that year
  const ratios: number[] = [];
  for (const r of claimRows || []) {
    const amt = n((r as any).paid_amt);
    const yr = n((r as any).dos_year);
    if (amt === null || yr === null) continue;
    if (ignoreZero && amt <= 0) continue;
    const wr = wrvuByYear.get(yr || 0);
    if (!wr || wr <= 0) continue;
    ratios.push(amt / wr);
  }
  const ratiosSorted = ratios.sort((a, b) => a - b);
  const dollarsPerWrvu = {
    mean_per_wrvu: mean(ratiosSorted),
    median_per_wrvu: median(ratiosSorted),
    sample_ratio_count: ratiosSorted.length,
  };

  // Trend by year (median)
  const trend_by_year = Array.from(byYearAmounts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, arr]) => {
      const s = arr.sort((a, b) => a - b);
      return { year, median: median(s) };
    });

  // Response
  return res.status(200).json({
    current_year: currentYear,
    code_selected: cpt,
    query_zip: zip,
    used_scope: { level: 'zip', sample_size: stats.sample_size, representative_zip: zip },
    metrics: {
      year_window: `${yStart}-${yEnd}`,
      mean: stats.mean,
      median: stats.median,
      p25: stats.p25,
      p75: stats.p75,
      mean_per_wrvu: dollarsPerWrvu.mean_per_wrvu,
      median_per_wrvu: dollarsPerWrvu.median_per_wrvu,
      ratio_sample_size: dollarsPerWrvu.sample_ratio_count,
      trend_by_year,
    },
  });
}
