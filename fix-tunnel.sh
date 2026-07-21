#!/bin/bash
# Checks whether the Cloudflare tunnel is alive; if not, restarts it and
# repoints the org (CSP Trusted Site + Home Page backendUrl) at the new URL.
# Run this any time you see "Failed to Fetch" in the app.
#
# Portable to any org/machine: reads ORG and TOKEN from .env, resolves the
# CSP Trusted Site record by name (not a hardcoded Id), and derives the
# project path from the script's own location.
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ -f .env ]; then
  ORG=$(grep -E '^SF_ORG_ALIAS=' .env | cut -d= -f2-)
  TOKEN=$(grep -E '^BACKEND_API_TOKEN=' .env | cut -d= -f2-)
fi
ORG="${ORG:-hackathon-org}"
CSP_DEVELOPER_NAME="Safe_Delete_Backend"
FLEXIPAGE_NAME="Field_and_Object_Deletion"
TUNNEL_LOG="/tmp/cloudflared-safe-metadata-delete.log"
FLEXIPAGE_FILE="$PROJECT_DIR/force-app/main/default/flexipages/$FLEXIPAGE_NAME.flexipage-meta.xml"

TOKEN_HEADER=()
if [ -n "$TOKEN" ]; then
  TOKEN_HEADER=(-H "X-Backend-Token: $TOKEN")
fi

CURRENT_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1)
STATUS="000"
if [ -n "$CURRENT_URL" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${TOKEN_HEADER[@]}" "$CURRENT_URL/api/health" 2>/dev/null || echo "000")
fi

if [ "$STATUS" = "200" ]; then
  echo "Tunnel is alive: $CURRENT_URL"
  echo "Nothing to do."
  exit 0
fi

echo "Tunnel is down (last known: $CURRENT_URL, status: $STATUS). Fixing..."

pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

if ! pgrep -f "node server/index.js" > /dev/null; then
  echo "Backend isn't running either - starting it..."
  nohup npm run backend > /tmp/safe-metadata-delete-backend.log 2>&1 &
  disown
  sleep 2
fi

echo "Starting a fresh tunnel..."
cloudflared tunnel --url http://localhost:3001 > "$TUNNEL_LOG" 2>&1 &
disown
sleep 8

NEW_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
if [ -z "$NEW_URL" ]; then
  echo "ERROR: couldn't get a new tunnel URL. Check $TUNNEL_LOG manually."
  exit 1
fi
echo "New tunnel: $NEW_URL"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${TOKEN_HEADER[@]}" "$NEW_URL/api/health")
if [ "$STATUS" != "200" ]; then
  echo "ERROR: new tunnel isn't responding (status: $STATUS). Try running this again in a few seconds."
  exit 1
fi

echo "Looking up the CSP Trusted Site record..."
CSP_ID=$(sf data query --target-org "$ORG" \
  --query "SELECT Id FROM CspTrustedSite WHERE DeveloperName = '$CSP_DEVELOPER_NAME'" \
  --json 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)['result']['records']; print(r[0]['Id'] if r else '')")
if [ -z "$CSP_ID" ]; then
  echo "ERROR: no CspTrustedSite named '$CSP_DEVELOPER_NAME' in org '$ORG'. Deploy force-app first (see README)."
  exit 1
fi

echo "Updating CSP Trusted Site..."
sf data update record --sobject CspTrustedSite --record-id "$CSP_ID" --values "EndpointUrl=$NEW_URL" --target-org "$ORG" --json > /dev/null

echo "Updating Home Page backend URL..."
sf project retrieve start --target-org "$ORG" --metadata "FlexiPage:$FLEXIPAGE_NAME" --wait 30 > /dev/null 2>&1
OLD_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$FLEXIPAGE_FILE" | head -1)
if [ -n "$OLD_URL" ]; then
  sed -i '' "s#$OLD_URL#$NEW_URL#" "$FLEXIPAGE_FILE"
fi
sf project deploy start --metadata "FlexiPage:$FLEXIPAGE_NAME" --target-org "$ORG" > /dev/null 2>&1

git add force-app/main/default/flexipages/ > /dev/null 2>&1
git commit -m "Auto-fix: point Home Page at fresh tunnel URL" > /dev/null 2>&1 || true
git push > /dev/null 2>&1 || echo "(git push failed - not critical, fix still applied to the org)"

echo ""
echo "Done. New tunnel: $NEW_URL"
echo "Reload the Salesforce Home Page in your browser, then try again."
