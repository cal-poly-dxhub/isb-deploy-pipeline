#!/usr/bin/env bash
#
# Loads the Innovation Sandbox pipeline configuration from SSM Parameter Store
# and writes it out as a shell-sourceable env file.
#
#   usage: load_ssm_config.sh <param-name> <region> [out-file]
#
# The output file is meant to be consumed as:
#
#   set -a && . /tmp/isb.env && set +a
#
# In addition to the raw config keys it emits two derived values:
#
#   ORG_MGT_ACCOUNT_ID / IDC_ACCOUNT_ID / HUB_ACCOUNT_ID
#       The accounts of the first fully-configured stage. The upstream
#       Innovation Sandbox `cdk synth` requires these unprefixed. Deriving
#       them here (instead of baking them into the CodeBuild environment at
#       pipeline-synth time) is what makes an SSM config change take effect on
#       the very next run instead of the run after it.
#
#   ISB_CONFIG_HASH
#       Stable sha256 of the normalised config, passed to `cdk synth` as the
#       `configHash` context value so a config-only change still produces a
#       CloudFormation diff for self-mutation to apply.
set -euo pipefail

PARAM_NAME="${1:?usage: load_ssm_config.sh <param-name> <region> [out-file]}"
REGION="${2:?usage: load_ssm_config.sh <param-name> <region> [out-file]}"
OUT_FILE="${3:-/tmp/isb.env}"

echo "==> Loading pipeline config from ${PARAM_NAME} (${REGION})"

# A missing parameter is not fatal. The very first pipeline deploy happens
# before update_ssm.sh has ever run, and in that case the values baked into the
# CodeBuild environment by `npm run deploy:pipeline` are still correct.
if ! RAW_CONFIG="$(aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --region "$REGION" \
  --query Parameter.Value \
  --output text 2>/dev/null)"; then
  echo "WARNING: ${PARAM_NAME} not found in ${REGION}." >&2
  echo "WARNING: continuing with the environment baked in at deploy time." >&2
  RAW_CONFIG='{}'
fi

CONFIG_JSON="$RAW_CONFIG" OUT_FILE="$OUT_FILE" python3 - <<'PY'
import hashlib
import json
import os
import re
import shlex
import sys

raw = os.environ["CONFIG_JSON"]
out_path = os.environ["OUT_FILE"]

try:
    config = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.exit(f"ERROR: {out_path}: config parameter is not valid JSON: {exc}")

if not isinstance(config, dict):
    sys.exit("ERROR: config parameter must be a JSON object of NAME -> value")

VALID_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

resolved = {}
skipped = []
for key, value in config.items():
    key = str(key).strip()
    if not VALID_KEY.match(key):
        skipped.append(key)
        continue
    resolved[key] = "" if value is None else str(value).strip()

lines = [f"{key}={shlex.quote(value)}" for key, value in sorted(resolved.items())]

# Mirror readStage() in lib/config/pipeline-config.ts: a stage counts as
# enabled only when all three of its account IDs are present.
for prefix in ("DEV", "STAGING", "PROD"):
    org = resolved.get(f"{prefix}_ORG_MGT_ACCOUNT", "")
    idc = resolved.get(f"{prefix}_IDC_ACCOUNT", "")
    hub = resolved.get(f"{prefix}_HUB_ACCOUNT", "")
    if org and idc and hub:
        lines.append(f"ORG_MGT_ACCOUNT_ID={shlex.quote(org)}")
        lines.append(f"IDC_ACCOUNT_ID={shlex.quote(idc)}")
        lines.append(f"HUB_ACCOUNT_ID={shlex.quote(hub)}")
        print(f"Upstream synth will target the {prefix} accounts")
        break
else:
    print("No fully-configured stage found in SSM; keeping baked-in account IDs")

digest = hashlib.sha256(
    json.dumps(resolved, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()
lines.append(f"ISB_CONFIG_HASH={digest}")

with open(out_path, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")

print(f"Wrote {len(resolved)} config variables to {out_path}")
if skipped:
    print(f"Skipped non-identifier keys: {', '.join(sorted(skipped))}")
print(f"Config hash: {digest}")
PY

chmod 600 "$OUT_FILE"
