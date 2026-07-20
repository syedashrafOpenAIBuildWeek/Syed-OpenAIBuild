#!/bin/bash
# Checks whether the Cloudflare tunnel is alive; if not, restarts it and
# repoints the org (CSP Trusted Site + Home Page backendUrl) at the new URL.
# Run this any time you see "Failed to Fetch" in the app.
set -e

TOKEN="673a298a25ef70fb7d201532b733c3f640bc6a895086d30b"
ORG="hackathon-org"
CSP_ID="08ydL000004Pq9BQAS"
FLEXIPAGE_NAME="Field_and_Object_Deletion"
PROJECT_DIR="/Users/a1989/Desktop/OpenAIDev"
TUNNEL_LOG="/tmp/cloudflared3.log"
FLEXIPAGE_FILE="$PROJECT_DIR/force-app/main/default/flexipages/$FLEXIPAGE_NAME.flexipage-meta.xml"

cd "$PROJECT_DIR"

CURRENT_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1)
STATUS="000"
if [ -n "$CURRENT_URL" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -H "X-Backend-Token: $TOKEN" "$CURRENT_URL/api/health" 2>/dev/null || echo "000")
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
  nohup npm run backend > /tmp/backend.log 2>&1 &
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

STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -H "X-Backend-Token: $TOKEN" "$NEW_URL/api/health")
if [ "$STATUS" != "200" ]; then
  echo "ERROR: new tunnel isn't responding (status: $STATUS). Try running this again in a few seconds."
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
sf project deploy start --source-dir force-app/main/default/flexipages --target-org "$ORG" > /dev/null 2>&1

git add force-app/main/default/flexipages/ > /dev/null 2>&1
git commit -m "Auto-fix: point Home Page at fresh tunnel URL" > /dev/null 2>&1 || true
git push > /dev/null 2>&1 || echo "(git push failed - not critical, fix still applied to the org)"

echo ""
echo "Done. New tunnel: $NEW_URL"
echo "Reload the Salesforce Home Page in your browser, then try again."
