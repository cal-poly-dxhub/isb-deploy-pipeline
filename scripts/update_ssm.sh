#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$SCRIPT_DIR/../.env}"
PARAM_NAME="/isb-pipeline/config"
REGION="${AWS_REGION:-$(grep -m1 '^TOOLING_REGION=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 'us-west-2')}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found" >&2
  exit 1
fi

# Convert .env to JSON (skip comments and blank lines)
JSON=$(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | while IFS='=' read -r key value; do
  printf '%s\t%s\n' "$key" "$value"
done | jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add')

aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --type String \
  --region "$REGION" \
  --overwrite \
  --value "$JSON"

echo "Updated $PARAM_NAME in $REGION"
