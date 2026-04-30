#!/bin/bash
# reset-deck.sh — Reset the card deck for testing
# 1. Marks all restaurants as available in the DB
# 2. Clears the weekly swipe session from the iOS Simulator's UserDefaults

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="$SCRIPT_DIR/../data/wheretoeat.db"

# Reset DB
node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB');
const result = db.prepare('UPDATE xhs_restaurants SET is_available_this_week = 1').run();
console.log('✓ Reset ' + result.changes + ' restaurants to available');
db.close();
"

# Clear weekly_session_* keys from simulator UserDefaults
PLIST=$(find ~/Library/Developer/CoreSimulator/Devices -name "weijia.WhereToEat.plist" 2>/dev/null | head -1)
if [ -n "$PLIST" ]; then
  python3 -c "
import plistlib
with open('$PLIST', 'rb') as f:
    d = plistlib.load(f)
keys_removed = [k for k in list(d.keys()) if k.startswith('weekly_session')]
for k in keys_removed:
    del d[k]
with open('$PLIST', 'wb') as f:
    plistlib.dump(d, f)
if keys_removed:
    print('✓ Cleared session keys:', keys_removed)
else:
    print('  No session keys found (already clean)')
"
else
  echo "  Simulator plist not found — app may not be installed yet"
fi

echo ""
echo "Done. Relaunch the app in the simulator to see restaurants."
