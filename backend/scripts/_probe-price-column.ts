import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';

const url =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL!;

const sql = neon(url);

(async () => {
  const cols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'xhs_restaurants' AND column_name LIKE 'price%'
  `;
  console.log('Neon price columns:', cols);
  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE price_level IS NOT NULL) AS with_price,
      COUNT(*) AS total
    FROM xhs_restaurants
  `;
  console.log('Counts:', counts);
})();
