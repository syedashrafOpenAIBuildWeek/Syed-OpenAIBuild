#!/bin/sh
set -e

if [ -z "$SF_AUTH_URL" ]; then
  echo "SF_AUTH_URL is not set - cannot authenticate the sf CLI" >&2
  exit 1
fi

echo "$SF_AUTH_URL" > /tmp/sf-auth-url.txt
sf org login sfdx-url --sfdx-url-file /tmp/sf-auth-url.txt --alias "${SF_ORG_ALIAS:-hackathon-org}" --set-default
rm -f /tmp/sf-auth-url.txt

exec node server/index.js
