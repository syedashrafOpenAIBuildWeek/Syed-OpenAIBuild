#!/bin/sh
set -e

# Prefer a Render Secret File (avoids pasting a long credential into a
# single-line env var field, which can get truncated/mangled) - fall back to
# an env var for other hosts.
if [ -f /etc/secrets/sf-auth-url ]; then
  AUTH_FILE=/etc/secrets/sf-auth-url
elif [ -n "$SF_AUTH_URL" ]; then
  echo "$SF_AUTH_URL" > /tmp/sf-auth-url.txt
  AUTH_FILE=/tmp/sf-auth-url.txt
else
  echo "Neither /etc/secrets/sf-auth-url nor SF_AUTH_URL is set - cannot authenticate the sf CLI" >&2
  exit 1
fi

sf org login sfdx-url --sfdx-url-file "$AUTH_FILE" --alias "${SF_ORG_ALIAS:-hackathon-org}" --set-default
rm -f /tmp/sf-auth-url.txt

exec node server/index.js
