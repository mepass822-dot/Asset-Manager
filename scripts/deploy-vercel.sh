#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/env/.env.local"

echo ""
echo "═══════════════════════════════════════════════"
echo "  MEC Agent — Vercel Deployment"
echo "═══════════════════════════════════════════════"
echo ""

# Check Vercel CLI
if ! command -v vercel &> /dev/null; then
  echo "Installing Vercel CLI..."
  npm install -g vercel
fi
echo "✅ Vercel CLI: $(vercel --version)"
echo ""

# Check env file
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ env/.env.local not found."
  echo "   Copy env/.env.example → env/.env.local and fill in your secrets."
  exit 1
fi
echo "✅ Found env/.env.local"
echo ""

# Login
echo "── Step 1: Login ───────────────────────────────"
vercel login
echo ""

# Link project
echo "── Step 2: Link project ────────────────────────"
vercel link --yes
echo ""

# Push all env vars from env/.env.local to Vercel (production + preview)
echo "── Step 3: Sync secrets to Vercel ─────────────"
while IFS= read -r line || [ -n "$line" ]; do
  trimmed="${line#"${line%%[![:space:]]*}"}"  # ltrim
  [ -z "$trimmed" ] && continue
  [[ "$trimmed" == \#* ]] && continue
  eq_pos="${trimmed%%=*}"
  key="$eq_pos"
  val="${trimmed#*=}"
  [ -z "$key" ] && continue
  echo "  → Setting $key..."
  printf '%s' "$val" | vercel env add "$key" production --force 2>/dev/null \
    || printf '%s' "$val" | vercel env add "$key" production
  printf '%s' "$val" | vercel env add "$key" preview --force 2>/dev/null \
    || printf '%s' "$val" | vercel env add "$key" preview
done < "$ENV_FILE"
echo ""

# Deploy
echo "── Step 4: Deploy to production ───────────────"
vercel --prod

echo ""
echo "✅ Deployment complete! Your app is live."
