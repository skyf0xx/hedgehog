#!/usr/bin/env bash
# Mints a short-lived GitHub App installation token for hedgehog-bot,
# scoped to one repo. Prints the token (and only the token) to stdout.
#
# Usage: mint-token.sh <owner/repo>
#
# Reads the App's private key from ~/.config/hedgehog-bot/private-key.pem
# (chmod 600) — never from chat. Requires: openssl, curl, jq.

set -euo pipefail

APP_ID="4532199"
REPO="${1:?usage: mint-token.sh <owner/repo>}"
KEY_FILE="$HOME/.config/hedgehog-bot/private-key.pem"

if [ ! -f "$KEY_FILE" ]; then
  echo "error: private key not found at $KEY_FILE" >&2
  exit 1
fi

b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 540))

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64url)
SIGNING_INPUT="${HEADER}.${PAYLOAD}"

SIGNATURE=$(printf '%s' "$SIGNING_INPUT" \
  | openssl dgst -sha256 -sign "$KEY_FILE" \
  | b64url)

JWT="${SIGNING_INPUT}.${SIGNATURE}"

INSTALLATION_ID=$(curl -sf -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/installation" \
  | jq -r '.id')

if [ -z "$INSTALLATION_ID" ] || [ "$INSTALLATION_ID" = "null" ]; then
  echo "error: could not resolve installation id for ${REPO} — is the App installed on this repo?" >&2
  exit 1
fi

curl -sf -X POST -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens" \
  | jq -r '.token'
