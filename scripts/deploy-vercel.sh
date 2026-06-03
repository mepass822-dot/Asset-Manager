#!/bin/bash
set -e

echo ""
echo "═══════════════════════════════════════════════"
echo "  MEC Agent — Vercel Deployment Setup"
echo "═══════════════════════════════════════════════"
echo ""

# Check Vercel CLI
if ! command -v vercel &> /dev/null; then
  echo "❌ Vercel CLI not found. Installing..."
  npm install -g vercel
fi

echo "✅ Vercel CLI: $(vercel --version)"
echo ""

# Login check
echo "── Step 1: Login to Vercel ─────────────────────"
vercel login

echo ""
echo "── Step 2: Link project to Vercel ─────────────"
vercel link --yes

echo ""
echo "── Step 3: Set environment variables ──────────"

# FIREBASE_SERVICE_ACCOUNT — read from local file
SA_FILE="$(dirname "$0")/sa_for_vercel.txt"
if [ ! -f "$SA_FILE" ]; then
  echo "❌ $SA_FILE not found. Run from the workspace root."
  exit 1
fi

echo "Setting FIREBASE_SERVICE_ACCOUNT..."
cat "$SA_FILE" | vercel env add FIREBASE_SERVICE_ACCOUNT production --force 2>/dev/null || \
  cat "$SA_FILE" | vercel env add FIREBASE_SERVICE_ACCOUNT production

echo "Setting FIREBASE_SERVICE_ACCOUNT for preview..."
cat "$SA_FILE" | vercel env add FIREBASE_SERVICE_ACCOUNT preview --force 2>/dev/null || \
  cat "$SA_FILE" | vercel env add FIREBASE_SERVICE_ACCOUNT preview

echo ""
echo "Setting NVIDIA_API_KEY..."
echo "  → You'll be prompted to paste your NVIDIA_API_KEY."
vercel env add NVIDIA_API_KEY production
vercel env add NVIDIA_API_KEY preview

echo ""
echo "── Step 4: Deploy to production ───────────────"
vercel --prod

echo ""
echo "✅ Deployment complete!"
echo "   Your app is live at the URL shown above."
echo ""
echo "NOTE: Keep scripts/sa_for_vercel.txt private — it contains your Firebase key."
