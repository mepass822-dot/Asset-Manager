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

# Deploy to production — capture the live URL
echo "── Step 4: Deploy to production ───────────────"
DEPLOY_URL=$(vercel --prod --yes 2>&1 | tee /dev/stderr | grep -E "^https://" | tail -1)
echo ""

# Health check
echo "── Step 5: Health check ────────────────────────"
if [ -z "$DEPLOY_URL" ]; then
  echo "⚠️  Could not detect deployment URL — skipping health check."
  echo "   Verify manually: <your-project>.vercel.app/api/healthz"
else
  HEALTH_URL="${DEPLOY_URL}/api/healthz"
  echo "  Pinging $HEALTH_URL ..."
  MAX_RETRIES=6
  RETRY_DELAY=10
  SUCCESS=false
  for i in $(seq 1 $MAX_RETRIES); do
    HTTP_STATUS=$(curl -s -o /tmp/healthz_body.json -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
    BODY=$(cat /tmp/healthz_body.json 2>/dev/null || echo "")
    if [ "$HTTP_STATUS" = "200" ] && echo "$BODY" | grep -q '"ok"'; then
      echo "✅ API is healthy ($HEALTH_URL → $HTTP_STATUS)"
      SUCCESS=true
      break
    fi
    echo "  Attempt $i/$MAX_RETRIES — HTTP $HTTP_STATUS, retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  done
  if [ "$SUCCESS" = "false" ]; then
    echo ""
    echo "❌ Health check failed after $MAX_RETRIES attempts."
    echo "   Last response: HTTP $HTTP_STATUS — $BODY"
    echo "   Check logs at: https://vercel.com/mecprojects/workspace"
    echo ""
    echo "   To roll back to the previous deployment, run:"
    echo "   vercel rollback --yes"
    exit 1
  fi
fi

echo ""
echo "✅ Deployment complete! Your app is live at: $DEPLOY_URL"
