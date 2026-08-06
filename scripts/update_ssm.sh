#!/usr/bin/env bash
#
# Publishes the local .env to the SSM parameter the pipeline reads at synth
# time.
#
#   usage: update_ssm.sh [env-file]
#
# This script deliberately does NOT start a pipeline execution. The pipeline
# stack owns an EventBridge rule on the Parameter Store change event instead, so
# a run is triggered no matter how the parameter was edited - this script, the
# AWS console, the CLI, or any other tooling.
#
# Set FORCE=1 to write a new parameter version even when nothing changed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$SCRIPT_DIR/../.env}"
PARAM_NAME="${PARAM_NAME:-/isb-pipeline/config}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found" >&2
  exit 1
fi

# Region precedence: AWS_REGION, then TOOLING_REGION from the env file.
REGION="${AWS_REGION:-}"
if [ -z "$REGION" ]; then
  REGION="$(sed -n 's/^[[:space:]]*\(export[[:space:]]*\)\{0,1\}TOOLING_REGION[[:space:]]*=[[:space:]]*//p' \
    "$ENV_FILE" | head -1 | tr -d '"'"'"'\r' | awk '{print $1}')"
fi
REGION="${REGION:-us-east-1}"

# Convert the env file to a flat JSON object. Done in python rather than with
# grep/cut so that comments, `export` prefixes, quoted values, CRLF line
# endings, and values containing '=' are all handled correctly.
JSON="$(ENV_FILE="$ENV_FILE" python3 - <<'PY'
import json
import os
import re
import sys

ASSIGNMENT = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
config = {}

with open(os.environ["ENV_FILE"], encoding="utf-8-sig") as handle:
    for raw in handle:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = ASSIGNMENT.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        quote = value[:1]
        if quote in ('"', "'") and len(value) >= 2 and value[-1:] == quote:
            value = value[1:-1]
        else:
            # Drop trailing ` # inline comment`, but keep '#' inside a value.
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        config[key] = value

if not config:
    sys.exit("Error: no variable assignments found in the env file")

json.dump(config, sys.stdout, sort_keys=True, separators=(",", ":"))
PY
)"

CURRENT="$(aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --region "$REGION" \
  --query Parameter.Value \
  --output text 2>/dev/null || true)"

if [ "${FORCE:-0}" != "1" ] && [ "$CURRENT" = "$JSON" ]; then
  echo "$PARAM_NAME in $REGION is already up to date; nothing to do."
  echo "(Set FORCE=1 to write a new version and trigger a pipeline run anyway.)"
  exit 0
fi

aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --type String \
  --tier Intelligent-Tiering \
  --region "$REGION" \
  --overwrite \
  --value "$JSON" \
  --output text >/dev/null

echo "Updated $PARAM_NAME in $REGION"
echo "The pipeline's config-change EventBridge rule will start a new execution."
