#!/usr/bin/env bash
# Push the Sveltia CMS GitHub OAuth credentials to the Cloudflare Worker
# `reckons-sveltia-cms-auth` (admin.reckons.ai) as wrangler secrets.
#
# These values are NEVER shipped in the app build — they live only in your
# local .env and are pushed straight to the worker's secret store.
#
# Setup (see .env.example "Sveltia CMS — GitHub OAuth" block and
# kb:sveltia-cms-setup in static/reckons-roadmap.ttl):
#   1. Create the GitHub OAuth App and fill SVELTIA_GITHUB_CLIENT_ID /
#      SVELTIA_GITHUB_CLIENT_SECRET / SVELTIA_ALLOWED_DOMAINS in .env.
#   2. Ensure CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are also set in .env.
#   3. Run:
#        bash scripts/sveltia-auth-secrets.sh
#      (this script sources .env itself; you can also export the vars in your
#      shell instead of using a .env file)
#
# Local editing without any of this: npx @sveltia/cms-proxy-server, then
# enable local_backend: true in static/admin/config.yml.

set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_NAME="reckons-sveltia-cms-auth"

# Load .env if present (KEY=VALUE lines only, same format .env.example uses).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

missing=()

for var in SVELTIA_GITHUB_CLIENT_ID SVELTIA_GITHUB_CLIENT_SECRET SVELTIA_ALLOWED_DOMAINS \
           CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "sveltia-auth-secrets: missing required environment variable(s):" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  echo "" >&2
  echo "Fill these in .env (see the \"Sveltia CMS — GitHub OAuth\" block in" >&2
  echo ".env.example), then run:" >&2
  echo "  bash scripts/sveltia-auth-secrets.sh" >&2
  exit 1
fi

push_secret() {
  local worker_var_name="$1"
  local value="$2"
  printf '%s' "$value" | npx wrangler secret put "$worker_var_name" --name "$WORKER_NAME"
}

echo "Pushing Sveltia CMS auth secrets to worker '$WORKER_NAME'..."

push_secret "GITHUB_CLIENT_ID" "$SVELTIA_GITHUB_CLIENT_ID"
push_secret "GITHUB_CLIENT_SECRET" "$SVELTIA_GITHUB_CLIENT_SECRET"
push_secret "ALLOWED_DOMAINS" "$SVELTIA_ALLOWED_DOMAINS"

echo "Done. Verify with: npx wrangler secret list --name $WORKER_NAME"
