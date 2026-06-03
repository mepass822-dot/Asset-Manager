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

# Login (skip if already authenticated)
echo "── Step 1: Login ───────────────────────────────"
vercel whoami 2>/dev/null && echo "✅ Already logged in" || vercel login
echo ""

# Link project
echo "── Step 2: Link project ────────────────────────"
vercel link --yes
echo ""

# Push all env vars from env/.env.local to Vercel
# Targets: production + development only (preview requires a git branch arg)
echo "── Step 3: Sync secrets to Vercel ─────────────"
while IFS= read -r line || [ -n "$line" ]; do
  # Skip blank lines and comments
  trimmed="${line#"${line%%[![:space:]]*}"}"
  [ -z "$trimmed" ] && continue
  [[ "$trimmed" == \#* ]] && continue

  key="${trimmed%%=*}"
  val="${trimmed#*=}"
  [ -z "$key" ] || [ -z "$val" ] && continue

  echo "  → $key"
  vercel env add "$key" production --value "$val" --yes --force 2>/dev/null \
    || vercel env add "$key" production --value "$val" --yes
  vercel env add "$key" development --value "$val" --yes --force 2>/dev/null \
    || vercel env add "$key" development --value "$val" --yes
done < "$ENV_FILE"
echo "✅ Secrets synced"
echo ""

# Deploy to production
echo "── Step 4: Deploy to production ───────────────"
vercel --prod --yes

echo ""
echo "✅ Deployment complete! Your app is live."
