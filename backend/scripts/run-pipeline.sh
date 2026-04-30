#!/bin/bash
# Weekly pipeline runner — called by crontab every Monday
# Crontab entry: 0 6 * * 1 /path/to/backend/scripts/run-pipeline.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$BACKEND_DIR/data/pipeline.log"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) pipeline start ===" >> "$LOG_FILE"
cd "$BACKEND_DIR"
npx ts-node scripts/test-pipeline.ts >> "$LOG_FILE" 2>&1
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) pipeline done ===" >> "$LOG_FILE"
