// pages/api/claim-metrics.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const CORS_ORIGIN = process.env.CLAIMS_ALLOWED_ORIGIN || '*';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function toNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(sorted: number[], p: number) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (i - lo)) + sorted[hi] * (i - lo);
}
const median = (s: number[]) => pct(s, 0.5);
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- Inputs ---
  const zip = String(req.query.zip || '').trim();
  const cpt = String(req.query.cpt || '').trim();
  const ignoreZero = String(req.query.ignoreZero ?? 'true').toLowerCase() === 'true';

  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'zip must be 5 digits' });
  if (!/^\d{5}$/.test(cpt)) return res.status(400).json({ error: 'cpt must be 5 digits' });

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const yStart = currentYear - 4;
  const yEnd = currentYear;

  // --- Claims ---
  const { data: claims, error: claimErr } = await supabase
    .from('claims')  // change if your table name differs
    .select('zip5, cpt, paid_amt, dos_year')
    .eq('zip5', zip)
    .eq('cpt', cpt)
    .gte('dos_year', yStart)
    .lte('dos_year', yEnd)
    .limit(50000);

  if (claimErr) return res.status(500).json({ error: `db error: ${claimErr.message}` });

  const amounts: number[] = [];
  const byYear = new Map<number, number[]>();
  for (const r of claims || []) {
    const amt = toNum((r as any).paid_amt);
    const yr = toNum((r as any).dos_year);
    if (amt === null || yr === null) continue;
    if (ignoreZero && amt <= 0) continue;
    amounts.push(amt);
    if (!byYear.has(yr)) byYear.set(yr, []);
    byYear.get(yr)!.push(amt);
  }
  const sorted = [...amounts].sort((a, b) => a - b);

  // --- RVU ---
  const { data: rvuRows } = await supabase
    .from('rvu_master') // change if your table name differs
    .select('cpt_code, year, wrvu')
    .eq('cpt_code', cpt)
    .gte('year', yStart)
    .lte('year', yEnd)
    .limit(50);

  const wrvuByYear = new Map<number, number>();
  for (const r of rvuRows || []) {
    const yr = toNum((r as any).year);
    const w = toNum((r as any).wrvu);
    if (yr && w && w > 0) wrvuByYear.set(yr, w);
  }

  const ratios: number[] = [];
  for (const r of claims || []) {
    const amt = toNum((r as any).paid_amt);
    const yr = toNum((r as any).dos_year);
    if (amt === null || yr === null) continue;
    if (ignoreZero && amt <= 0) continue;
    const w = wrvuByYear.get(yr);
    if (w && w > 0) ratios.push(amt / w);
  }

  const ratiosSorted = ratios.sort((a, b) => a - b);
  const trend_by_year = Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, arr]) => ({ year, median: median(arr.sort((a, b) => a - b)) }));

  return res.status(200).json({
    api_version: 2,
    current_year: currentYear,
    code_selected: cpt,
    query_zip: zip,
    used_scope: { level: 'zip', sample_size: sorted.length, representative_zip: zip },
    metrics: {
      year_window: `${yStart}-${yEnd}`,
      mean: mean(sorted),
      median: median(sorted),
      p25: pct(sorted, 0.25),
      p75: pct(sorted, 0.75),
      mean_per_wrvu: mean(ratiosSorted),
      median_per_wrvu: median(ratiosSorted),
      ratio_sample_size: ratiosSorted.length,
      trend_by_year,
      ignore_zero_applied: ignoreZero
    }
  });
}
