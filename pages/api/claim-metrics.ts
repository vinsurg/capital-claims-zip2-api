import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function makeStableClaimNumber(orgId: string, rowId: number) {
  const h = crypto.createHash('sha256').update(`${orgId}:${rowId}`).digest('hex');
  return h.replace(/[a-f]/g, c => String('012345'[c.charCodeAt(0)-97]!)).slice(0, 10);
}

function zipFallbacks(zip?: string) {
  if (!zip) return { zip5: null, zip3: null };
  const zip5 = zip.slice(0, 5);
  const zip3 = zip5.slice(0, 3);
  return { zip5, zip3 };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { cpt, zip, state, yearFrom, yearTo, afterId, limit, excludeZero } = req.query as Record<string,string>;
    const orgId = (req.headers['x-org-id'] as string) || 'org_demo';

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

    const LIMIT = Math.min(Math.max(Number(limit ?? 50), 1), 100);
    const after = afterId ? Number(afterId) : null;
    const yf = yearFrom ? Number(yearFrom) : null;
    const yt = yearTo ? Number(yearTo) : null;
    const ex0 = excludeZero === '1';
    const { zip5, zip3 } = zipFallbacks(zip);

    const baseSelect = 'id, org_id, zip, zip3, state, cpt_code, year, mean, median, p25, p75, count, amount';

    async function fetchScope(scope: 'zip5'|'zip3'|'state'|'national') {
      let q = supabase.from('v_claim_metrics').select(baseSelect).eq('org_id', orgId);
      if (cpt) q = q.eq('cpt_code', cpt);
      if (ex0) q = q.gt('amount', 0);
      if (yf) q = q.gte('year', yf);
      if (yt) q = q.lte('year', yt);
      if (after) q = q.gt('id', after);
      q = q.order('id', { ascending: true }).limit(LIMIT);

      if (scope === 'zip5' && zip5) return q.eq('zip', zip5);
      if (scope === 'zip3' && zip3) return q.eq('zip3', zip3);
      if (scope === 'state' && state) return q.eq('state', state);
      return q;
    }

    const scopes: Array<'zip5'|'zip3'|'state'|'national'> = [];
    if (zip5) scopes.push('zip5');
    if (zip3) scopes.push('zip3');
    if (state) scopes.push('state');
    scopes.push('national');

    let usedScope: string | null = null;
    let rows: any[] = [];

    for (const s of scopes) {
      const { data, error } = await fetchScope(s);
      if (error) continue;
      if (data && data.length) { usedScope = s; rows = data; break; }
    }

    const results = rows.map(r => ({
      ...r,
      unique_claim_number: makeStableClaimNumber(orgId, r.id)
    }));
    const nextCursor = results.length ? String(results[results.length - 1].id) : null;

    res.status(200).json({
      query_zip: zip ?? null,
      used_scope: usedScope,
      exclude_zero: ex0,
      pagination: { limit: LIMIT, nextCursor },
      results
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Server error' });
  }
}
