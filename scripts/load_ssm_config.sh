#!/usr/bin/env bash
#
# Loads the Innovation Sandbox pipeline configuration from SSM Parameter Store
# and writes it out as a shell-sourceable env file.
#
#   usage: load_ssm_config.sh <param-name> <region> [out-file]
#
# The output is consumed by the synth step as:
#
#   set -a && . /tmp/isb.env && set +a
#
# On top of the raw config keys it derives:
#
#   ORG_MGT_ACCOUNT_ID / IDC_ACCOUNT_ID / HUB_ACCOUNT_ID
#       The accounts of the first fully-configured stage. The upstream
#       Innovation Sandbox `cdk synth` requires these unprefixed. Deriving them
#       here (instead of baking them into the CodeBuild environment at
#       pipeline-synth time) is what makes an SSM config change take effect on
#       the very next run instead of the run after it.
#
# This runs in the synth step *before* `npm ci`, so node_modules is not
# available. Everything here relies only on the AWS CLI and jq, both of which
# are already required by the deploy, nuke and integration-test steps.
set -euo pipefail

PARAM_NAME="${1:?usage: load_ssm_config.sh <param-name> <region> [out-file]}"
REGION="${2:?usage: load_ssm_config.sh <param-name> <region> [out-file]}"
OUT_FILE="${3:-/tmp/isb.env}"

# Only keys that are valid shell identifiers can be exported. Anything else
# (dashes, dots, leading digits) is reported and skipped rather than silently
# producing an unsourceable file.
IDENT='^[A-Za-z_][A-Za-z0-9_]*$'

# Values are trimmed to match how loadPipelineConfig() in
# lib/config/pipeline-config.ts trims what it reads.
JQ_TRIM='def trim: gsub("^[[:space:]]+|[[:space:]]+$"; "");'

echo "==> Loading pipeline config from ${PARAM_NAME} (${REGION})"

# A missing parameter is not fatal here. The very first pipeline deploy happens
# before update_ssm has ever run, and in that case the values baked into the
# CodeBuild environment by `npm run deploy:pipeline` are still correct. (The
# pipeline's own `cdk synth` will fail straight after with a clear message about
# the missing variable, which is the better error to surface.)
if ! RAW_CONFIG="$(aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --region "$REGION" \
  --query Parameter.Value \
  --output text 2>/dev/null)"; then
  echo "WARNING: ${PARAM_NAME} not found in ${REGION}." >&2
  echo "WARNING: continuing with the environment baked in at deploy time." >&2
  RAW_CONFIG='{}'
fi

if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$RAW_CONFIG"; then
  echo "ERROR: ${PARAM_NAME} must contain a JSON object of NAME -> value" >&2
  exit 1
fi

# @sh performs the shell quoting. That is the one security-critical step in this
# script: these values come from a mutable parameter and are sourced by the
# build, so a value such as '$(...)' has to survive as a literal.
jq -r --arg ident "$IDENT" "
  $JQ_TRIM
  to_entries
  | map(select(.key | trim | test(\$ident)))
  | sort_by(.key)[]
  | \"\(.key | trim)=\((.value // \"\") | tostring | trim | @sh)\"
" <<<"$RAW_CONFIG" >"$OUT_FILE"

# Mirror readStage() in lib/config/pipeline-config.ts: a stage counts as enabled
# only when all three of its account IDs are present.
for PREFIX in DEV STAGING PROD; do
  IFS=$'\t' read -r ORG IDC HUB <<<"$(jq -r --arg p "$PREFIX" "
    $JQ_TRIM
    [ .[\$p + \"_ORG_MGT_ACCOUNT\"], .[\$p + \"_IDC_ACCOUNT\"], .[\$p + \"_HUB_ACCOUNT\"] ]
    | map((. // \"\") | tostring | trim)
    | @tsv
  " <<<"$RAW_CONFIG")"

  if [ -n "$ORG" ] && [ -n "$IDC" ] && [ -n "$HUB" ]; then
    {
      printf 'ORG_MGT_ACCOUNT_ID=%s\n' "$(jq -rn --arg v "$ORG" '$v | @sh')"
      printf 'IDC_ACCOUNT_ID=%s\n' "$(jq -rn --arg v "$IDC" '$v | @sh')"
      printf 'HUB_ACCOUNT_ID=%s\n' "$(jq -rn --arg v "$HUB" '$v | @sh')"
    } >>"$OUT_FILE"
    echo "Upstream synth will target the ${PREFIX} accounts"
    FOUND_STAGE=1
    break
  fi
done

if [ -z "${FOUND_STAGE:-}" ]; then
  echo "No fully-configured stage found in SSM; keeping baked-in account IDs"
fi

COUNT="$(jq -r --arg ident "$IDENT" "
  $JQ_TRIM
  [ to_entries[] | select(.key | trim | test(\$ident)) ] | length
" <<<"$RAW_CONFIG")"
echo "Wrote ${COUNT} config variables to ${OUT_FILE}"

SKIPPED="$(jq -r --arg ident "$IDENT" "
  $JQ_TRIM
  [ to_entries[] | select((.key | trim | test(\$ident)) | not) | .key ] | sort | join(\", \")
" <<<"$RAW_CONFIG")"
if [ -n "$SKIPPED" ]; then
  echo "Skipped non-identifier keys: ${SKIPPED}"
fi

chmod 600 "$OUT_FILE"
