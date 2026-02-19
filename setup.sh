#!/usr/bin/env bash
# ============================================================
# SwiftClear — Post-clone setup script
# Run once after filling in .env from .env.example
# ============================================================
set -e

echo ""
echo "==> SwiftClear Setup"
echo ""

# ── 1. Check .env exists ─────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env not found."
  echo "Copy .env.example to .env and fill in your keys first:"
  echo "  cp .env.example .env"
  exit 1
fi

# ── 2. Supabase login + link ──────────────────────────────────
echo "[1/4] Logging in to Supabase (opens browser)..."
supabase login

echo ""
read -rp "Enter your Supabase project ref (from project URL): " PROJECT_REF
supabase link --project-ref "$PROJECT_REF"

# ── 3. Push migrations ────────────────────────────────────────
echo ""
echo "[2/4] Pushing database migrations..."
supabase db push

# ── 4. Deploy edge function ───────────────────────────────────
echo ""
echo "[3/4] Deploying reputation-cron edge function..."
supabase functions deploy reputation-cron --no-verify-jwt

# ── 5. Set edge function secrets ─────────────────────────────
echo ""
echo "[4/4] Setting edge function env vars..."
source .env
supabase secrets set \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY"

echo ""
echo "✓ Database migrations applied"
echo "✓ reputation-cron function deployed"
echo ""
echo "Next:"
echo "  • Schedule reputation-cron every 30 min in:"
echo "    https://supabase.com/dashboard/project/$PROJECT_REF/functions"
echo "  • Fill MAPBOX_ACCESS_TOKEN in apps/api/.env.local"
echo "  • Deploy the API: cd apps/api && npx vercel --prod"
echo "  • Start the mobile app: cd apps/mobile && npx expo start"
echo ""
