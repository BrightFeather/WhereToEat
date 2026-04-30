import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
process.env.VERCEL = '1'; // force Neon path in db.ts
async function main() {
  const { sql } = await import('/Users/chenweijia/Documents/code/WhereToEat/backend/api/_lib/db');

  const totals = await sql`SELECT COUNT(*) AS c FROM xhs_sources` as any[];
  console.log('Neon xhs_sources total:', totals[0]?.c);

  const chada = await sql`
    SELECT id, restaurant_name, google_place_id, mention_count
    FROM xhs_restaurants
    WHERE restaurant_name = 'CHADA NYC'` as any[];
  console.log('Neon CHADA row(s):', JSON.stringify(chada, null, 2));

  if (chada.length) {
    const srcs = await sql`
      SELECT post_url, likes, source_type
      FROM xhs_sources
      WHERE restaurant_id = ${chada[0].id}` as any[];
    console.log('Neon CHADA sources:', JSON.stringify(srcs, null, 2));
  }

  const dangling = await sql`
    SELECT COUNT(*) AS c
    FROM xhs_sources s
    LEFT JOIN xhs_restaurants r ON r.id = s.restaurant_id
    WHERE r.id IS NULL` as any[];
  console.log('Neon dangling source rows:', dangling[0]?.c);
}
main().catch(e => { console.error(e); process.exit(1); });
