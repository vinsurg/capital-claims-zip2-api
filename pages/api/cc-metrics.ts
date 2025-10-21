import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const CORS_ORIGIN = process.env.CLAIMS_ALLOWED_ORIGIN || '*';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
};
const median = (s: number[]) => pct(s, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function bad(res: NextApiResponse, code: number, msg: string) {
  return res.status(code).json({ error: msg });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return bad(res, 405, 'Method not allowed');

  const zip = String(req.query.zip || '').trim();
  const cpt = String(req.query.cpt || '').trim();
  const ignoreZero = String(req.query.ignoreZero ?? 'true').toLowerCase() === 'true';

  if (!/^\d{5}$/.test(zip)) return bad(res, 400, 'zip must be 5 digits');
  if (!/^\d{5}$/.test(cpt)) return bad(res, 400, 'cpt must be 5 digits');

  const currentYear = new Date().getUTCFullYear();
  const yStart = currentYear - 4;
  const yEnd = currentYear;

  // claims table expected: zip5 (text), cpt (text), paid_amt (numeric), dos_year (int)
  const { data: rows, error: claimErr } = await supabase
    .from('claims')
    .select('zip5, cpt, paid_amt, dos_year')
    .eq('zip5', zip)
    .eq('cpt', cpt)
    .gte('dos_year', yStart)
    .lte('dos_year', yEnd)
    .limit(50000);

  if (claimErr) return bad(res, 500, `db error: ${claimErr.message}`);

  let vals: number[] = [];
  const byYear = new Map<number, number[]>();
  for (const r of rows || []) {
    const amt = num((r as any).paid_amt);
    const yr = num((r as any).dos_year);
    if (amt == null || yr == null) continue;
    if (ignoreZero && amt <= 0) continue;
    vals.push(amt);
    if (!byYear.has(yr)) byYear.set(yr, []);
    byYear.get(yr)!.push(amt);
  }
  const sorted = vals.sort((a, b) => a - b);
  const sample_size = sorted.length;

  // rvu_master expected: cpt_code (text), year (int), wrvu (numeric)
  const { data: rvu, error: rvuErr } = await supabase
    .from('rvu_master')
    .select('cpt_code, year, wrvu')
    .eq('cpt_code', cpt)
    .gte('year', yStart)
    .lte('year', yEnd)
    .limit(50);

  const wrvuByYear = new Map<number, number>();
  if (!rvuErr) {
    for (const r of rvu || []) {
      const yr = num((r as any).year);
      const wr = num((r as any).wrvu);
      if (yr && wr && wr > 0) wrvuByYear.set(yr, wr);
    }
  }

  const ratios: number[] = [];
  for (const r of rows || []) {
    const amt = num((r as any).paid_amt);
    const yr = num((r as any).dos_year);
    if (amt == null || yr == null) continue;
    if (ignoreZero && amt <= 0) continue;
    const wr = wrvuByYear.get(yr);
    if (!wr || wr <= 0) continue;
    ratios.push(amt / wr);
  }
  const rSorted = ratios.sort((a, b) => a - b);

  const trend_by_year = Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, arr]) => ({ year, median: median(arr.sort((x, y) => x - y)) }));

  return res.status(200).json({
    current_year: currentYear,
    code_selected: cpt,
    query_zip: zip,
    used_scope: { level: 'zip', sample_size, representative_zip: zip },
    metrics: {
      year_window: `${yStart}-${yEnd}`,
      mean: mean(sorted),
      median: median(sorted),
      p25: pct(sorted, 0.25),
      p75: pct(sorted, 0.75),
      mean_per_wrvu: mean(rSorted),
      median_per_wrvu: median(rSorted),
      ratio_sample_size: rSorted.length,
      trend_by_year,
    },
  });
}
