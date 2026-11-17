#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
cfg="wrangler.deploy.toml"
rm -f "$cfg"
trap 'rm -f "$cfg"' EXIT
node scripts/render-deploy-config.mjs "$cfg"
npx wrangler d1 migrations apply html-preview --remote --config "$cfg"
npx wrangler deploy --config "$cfg"
