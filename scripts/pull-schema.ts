// scripts/pull-schema.ts
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL; // e.g. from Supabase > Settings > Database > Connection string (password-protected)
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL. Set it in your env.');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ get_schema_snapshot: any }>(
      `select public.get_schema_snapshot() as get_schema_snapshot;`
    );
    const snapshot = rows[0]?.get_schema_snapshot;
    if (!snapshot) {
      console.error('No snapshot returned. Check function/permissions.');
      process.exit(1);
    }

    const outPath = path.resolve(process.cwd(), 'schema-lock.json');
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`Wrote schema lock to ${outPath}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
