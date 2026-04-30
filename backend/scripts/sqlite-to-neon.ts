/**
 * One-shot data migration from local SQLite (`data/wheretoeat.db`) → Neon Postgres.
 *
 *   npm run push-data
 *
 * Reads every row from each table, bulk-inserts into Neon. Idempotent: uses
 * INSERT … ON CONFLICT DO NOTHING so rerunning won't duplicate. Prints row
 * counts on each side so you can verify parity.
 *
 * Run AFTER `npm run migrate` has created the Postgres schema.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';

const url =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
const sql = neon(url);

const sqlitePath = path.join(__dirname, '../data/wheretoeat.db');
console.log(`Reading from ${sqlitePath}`);
const lite = new Database(sqlitePath, { readonly: true });

type Row = Record<string, unknown>;

async function migrateTable<T extends Row>(
  table: string,
  insertOne: (row: T) => Promise<unknown>
): Promise<void> {
  const rows = lite.prepare(`SELECT * FROM ${table}`).all() as T[];
  console.log(`\n[${table}] sqlite: ${rows.length} rows`);
  let ok = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      await insertOne(row);
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
        skipped++;
      } else {
        console.error(`  ✗ ${msg}`);
        throw e;
      }
    }
  }
  const [{ count }] = (await sql`SELECT COUNT(*)::int AS count FROM ${sql.unsafe(table)}`) as Array<{ count: number }>;
  console.log(`[${table}] inserted ${ok}, skipped ${skipped}, neon now: ${count}`);
}

async function main() {
  // Order matters: parents before children.

  // 1. pipeline_runs (no FKs)
  await migrateTable<Row>('pipeline_runs', (r) => sql`
    INSERT INTO pipeline_runs (
      id, city, status, started_at, completed_at,
      post_count, restaurant_count, error_message
    ) VALUES (
      ${r.id}, ${r.city}, ${r.status},
      ${r.started_at as string ?? null}::timestamptz,
      ${r.completed_at as string ?? null}::timestamptz,
      ${r.post_count ?? null}, ${r.restaurant_count ?? null}, ${r.error_message ?? null}
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 2. xhs_restaurants (FK -> pipeline_runs)
  await migrateTable<Row>('xhs_restaurants', (r) => sql`
    INSERT INTO xhs_restaurants (
      id, city, restaurant_name, address, borough, neighborhood, cuisine_type,
      recommendation, post_url, post_created_at, mention_count, total_likes,
      google_place_id, google_maps_url, google_display_name, website_url,
      photo_url, photo_urls, resy_venue_id, resy_booking_url,
      opentable_rid, opentable_booking_url, is_available_this_week,
      pipeline_run_id, created_at
    ) VALUES (
      ${r.id}, ${r.city}, ${r.restaurant_name},
      ${r.address ?? null}, ${r.borough ?? null}, ${r.neighborhood ?? null}, ${r.cuisine_type ?? null},
      ${r.recommendation ?? null}, ${r.post_url ?? null}, ${r.post_created_at ?? null},
      ${r.mention_count ?? 1}, ${r.total_likes ?? 0},
      ${r.google_place_id ?? null}, ${r.google_maps_url ?? null}, ${r.google_display_name ?? null},
      ${r.website_url ?? null}, ${r.photo_url ?? null}, ${r.photo_urls ?? null},
      ${r.resy_venue_id ?? null}, ${r.resy_booking_url ?? null},
      ${r.opentable_rid ?? null}, ${r.opentable_booking_url ?? null},
      ${r.is_available_this_week ?? 1},
      ${r.pipeline_run_id ?? null},
      ${r.created_at as string ?? null}::timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 3. xhs_sources (FK -> xhs_restaurants)
  await migrateTable<Row>('xhs_sources', (r) => sql`
    INSERT INTO xhs_sources (
      id, restaurant_id, post_url, recommendation, likes, post_created_at, created_at
    ) VALUES (
      ${r.id}, ${r.restaurant_id}, ${r.post_url}, ${r.recommendation ?? null},
      ${r.likes ?? 0}, ${r.post_created_at ?? null},
      ${r.created_at as string ?? null}::timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 4. users (no FKs)
  await migrateTable<Row>('users', (r) => sql`
    INSERT INTO users (id, display_name, created_at, last_seen_at)
    VALUES (
      ${r.id}, ${r.display_name ?? null},
      ${r.created_at as string ?? null}::timestamptz,
      ${r.last_seen_at as string ?? null}::timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 5. user_reservations (FK -> users)
  await migrateTable<Row>('user_reservations', (r) => sql`
    INSERT INTO user_reservations (
      id, user_id, restaurant_id, restaurant_name, restaurant_photo_url,
      datetime, party_size, confirmation_code, platform, status,
      calendar_event_id, reminder_notification_id, created_at
    ) VALUES (
      ${r.id}, ${r.user_id}, ${r.restaurant_id}, ${r.restaurant_name},
      ${r.restaurant_photo_url ?? null}, ${r.datetime}, ${r.party_size},
      ${r.confirmation_code ?? null}, ${r.platform ?? null}, ${r.status ?? 'confirmed'},
      ${r.calendar_event_id ?? null}, ${r.reminder_notification_id ?? null},
      ${r.created_at as string ?? null}::timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 6. user_favorites (composite PK on user_id + restaurant_id)
  await migrateTable<Row>('user_favorites', (r) => sql`
    INSERT INTO user_favorites (user_id, restaurant_id, saved_at)
    VALUES (
      ${r.user_id}, ${r.restaurant_id},
      ${r.saved_at as string ?? null}::timestamptz
    )
    ON CONFLICT (user_id, restaurant_id) DO NOTHING
  `);

  console.log('\nData migration complete.');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => lite.close());
