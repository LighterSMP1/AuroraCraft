#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== AuroraCraft Startup ==="

# 1. Start PostgreSQL
echo "[1/3] Starting PostgreSQL..."
sudo service postgresql start
until pg_isready -q; do
  echo "  Waiting for PostgreSQL..."
  sleep 1
done
echo "  PostgreSQL is ready."

# 2. Start PM2 processes
echo "[2/3] Starting PM2 processes..."
cd "$SCRIPT_DIR"
pm2 resurrect --no-daemon 2>/dev/null || pm2 start ecosystem.config.cjs
pm2 save

# 3. Verify
echo "[3/3] Verifying services..."
sleep 3
pm2 list
echo ""
echo "=== All services started ==="
