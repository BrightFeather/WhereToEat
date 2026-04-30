/**
 * Re-verify every restaurant that currently has an OpenTable URL stored.
 *
 *   npx ts-node scripts/verify-opentable.ts
 *
 * OpenTable autocomplete includes restaurants that are *listed* but not on
 * the booking network. Their profile page shows a "Not available on
 * OpenTable" sidebar. This script navigates to each stored rid, runs
 * `verifyBookable`, and clears opentable_rid + opentable_booking_url when
 * the restaurant is not bookable.
 */
import Database from 'better-sqlite3';
import path from 'path';
import * as dotenv from 'dotenv';
import { OpenTableSearcher } from '../api/_lib/opentableSearch';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

async function main() {
  const rows = db.prepare(`
    SELECT id, restaurant_name, opentable_rid
    FROM xhs_restaurants
    WHERE opentable_booking_url IS NOT NULL
      AND opentable_rid IS NOT NULL
  `).all() as { id: string; restaurant_name: string; opentable_rid: string }[];

  console.log(`Verifying ${rows.length} restaurants currently stored with OpenTable URLs...\n`);

  const clear = db.prepare(`
    UPDATE xhs_restaurants
    SET opentable_rid = NULL, opentable_booking_url = NULL
    WHERE id = ?
  `);

  const searcher = new OpenTableSearcher();
  await searcher.open();

  let kept = 0;
  let removed = 0;

  try {
    for (const r of rows) {
      const bookable = await searcher.verifyBookable(r.opentable_rid);
      if (bookable) {
        console.log(`✓ ${r.restaurant_name} (rid=${r.opentable_rid}) still bookable`);
        kept++;
      } else {
        clear.run(r.id);
        console.log(`⊘ ${r.restaurant_name} (rid=${r.opentable_rid}) NOT bookable — cleared`);
        removed++;
      }
    }
  } finally {
    await searcher.close();
  }

  console.log(`\nDone: ${kept} kept, ${removed} removed`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
