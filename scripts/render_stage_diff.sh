#!/usr/bin/env bash
#
# Renders a `cdk diff` for the upstream Innovation Sandbox stacks so a reviewer
# can see what a manual approval is about to authorise.
#
#   usage: render_stage_diff.sh <out-file> <stack>:<account>:<region> [...]
#
# Must be run from the root of the upstream repo, with the stage config already
# sourced into the environment and dependencies installed.
#
# The four upstream stacks live in up to three different accounts, so the target
# role is re-assumed per stack. Unsetting the credential variables first returns
# the shell to the CodeBuild role, which is the identity allowed to assume them.
#
# The output leads with a summary, because a raw `cdk diff` of this solution is
# dominated by noise that changes on every single build (asset hashes, Lambda
# Code.S3Key, aws:asset:path metadata). The things a reviewer actually needs -
# resource replacements, deletions, IAM/security changes and the upstream
# version - are pulled out first.
#
# A diff is informational: failures are recorded in the output but never abort
# the run, because being unable to render a diff must not block a deploy.
set -uo pipefail

OUT_FILE="${1:?usage: render_stage_diff.sh <out-file> <stack>:<account>:<region> ...}"
shift

DEPLOY_ROLE_NAME="${DEPLOY_ROLE_NAME:-InnovationSandboxPipelineDeployRole}"
# Targets in this account are diffed with the CodeBuild role directly, matching
# how deploy-step.ts skips role assumption for same-account deploys.
TOOLING_ACCOUNT="${TOOLING_ACCOUNT:-}"
CDK="npm run --silent --workspace @amzn/innovation-sandbox-infrastructure cdk --"

DETAILS_FILE="$(mktemp)"
SUMMARY_FILE="$(mktemp)"
STACK_DIFF="$(mktemp)"
trap 'rm -f "$DETAILS_FILE" "$SUMMARY_FILE" "$STACK_DIFF"' EXIT

VERSIONS_SEEN=""
NEEDS_ATTENTION=0

for TARGET in "$@"; do
  STACK="${TARGET%%:*}"
  REST="${TARGET#*:}"
  ACCOUNT="${REST%%:*}"
  REGION="${REST##*:}"

  {
    echo
    echo "########################################################################"
    echo "# ${STACK}  ->  ${ACCOUNT} / ${REGION}"
    echo "########################################################################"
  } >>"$DETAILS_FILE"

  # Drop any previously assumed credentials so the CodeBuild role is used to
  # assume the next target role.
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

  if [ "$ACCOUNT" != "$TOOLING_ACCOUNT" ]; then
    if ! CREDS="$(aws sts assume-role \
      --role-arn "arn:aws:iam::${ACCOUNT}:role/${DEPLOY_ROLE_NAME}" \
      --role-session-name "cdk-diff-${STACK##*-}" \
      --duration-seconds 3600 2>&1)"; then
      echo "Could not assume ${DEPLOY_ROLE_NAME} in ${ACCOUNT}: ${CREDS}" >>"$DETAILS_FILE"
      printf '%s (%s/%s)\n  !! could not assume %s - diff unavailable\n\n' \
        "$STACK" "$ACCOUNT" "$REGION" "$DEPLOY_ROLE_NAME" >>"$SUMMARY_FILE"
      NEEDS_ATTENTION=1
      continue
    fi

    AWS_ACCESS_KEY_ID="$(echo "$CREDS" | jq -r .Credentials.AccessKeyId)"
    AWS_SECRET_ACCESS_KEY="$(echo "$CREDS" | jq -r .Credentials.SecretAccessKey)"
    AWS_SESSION_TOKEN="$(echo "$CREDS" | jq -r .Credentials.SessionToken)"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  fi

  # cdk diff writes the human-readable diff to stderr, so fold both streams in.
  # --no-color keeps ANSI escapes out of a file that gets read in a browser.
  : >"$STACK_DIFF"
  if AWS_REGION="$REGION" \
    CDK_DEFAULT_ACCOUNT="$ACCOUNT" \
    CDK_DEFAULT_REGION="$REGION" \
    $CDK diff "$STACK" --no-color >"$STACK_DIFF" 2>&1; then
    DIFF_OK=1
  else
    DIFF_OK=0
  fi
  cat "$STACK_DIFF" >>"$DETAILS_FILE"

  # ---- summarise -----------------------------------------------------------
  ADDED="$(grep -cE '^\[\+\] AWS::' "$STACK_DIFF" 2>/dev/null || true)"
  REMOVED="$(grep -cE '^\[-\] AWS::' "$STACK_DIFF" 2>/dev/null || true)"
  CHANGED="$(grep -cE '^\[~\] AWS::' "$STACK_DIFF" 2>/dev/null || true)"

  printf '%s (%s/%s)\n' "$STACK" "$ACCOUNT" "$REGION" >>"$SUMMARY_FILE"
  printf '  resources: +%s  -%s  ~%s\n' \
    "${ADDED:-0}" "${REMOVED:-0}" "${CHANGED:-0}" >>"$SUMMARY_FILE"

  if [ "$DIFF_OK" -eq 0 ]; then
    printf '  !! cdk diff exited non-zero - see the details below\n' >>"$SUMMARY_FILE"
    NEEDS_ATTENTION=1
  fi

  # Replacements and deletions destroy and recreate resources. For a solution
  # holding lease state in DynamoDB this is the single most important signal.
  REPLACEMENTS="$(grep -icE 'requires replacement|may be replaced|destroy' "$STACK_DIFF" 2>/dev/null || true)"
  if [ "${REPLACEMENTS:-0}" -gt 0 ]; then
    printf '  !! %s line(s) mention replacement/destruction - REVIEW CAREFULLY\n' \
      "$REPLACEMENTS" >>"$SUMMARY_FILE"
    grep -iE 'requires replacement|may be replaced|destroy' "$STACK_DIFF" 2>/dev/null |
      head -10 | sed 's/^/       /' >>"$SUMMARY_FILE"
    NEEDS_ATTENTION=1
  fi

  if [ "${REMOVED:-0}" -gt 0 ]; then
    printf '  !! resources are being REMOVED:\n' >>"$SUMMARY_FILE"
    grep -E '^\[-\] AWS::' "$STACK_DIFF" 2>/dev/null |
      head -10 | sed 's/^/       /' >>"$SUMMARY_FILE"
    NEEDS_ATTENTION=1
  fi

  # cdk prints dedicated tables for these when permissions broaden.
  if grep -qE 'IAM Statement Changes|IAM Policy Changes|Security Group Changes' \
    "$STACK_DIFF" 2>/dev/null; then
    printf '  !  IAM / security-group changes present\n' >>"$SUMMARY_FILE"
    NEEDS_ATTENTION=1
  fi

  # Parameter and output changes alter how the stacks wire together.
  if grep -qE '^Parameters$|^Outputs$' "$STACK_DIFF" 2>/dev/null; then
    printf '  .  parameter/output changes present\n' >>"$SUMMARY_FILE"
  fi

  # The upstream solution version is carried in USER_AGENT_EXTRA, so a bump
  # there is the clearest signal that the solution itself moved.
  STACK_VERSIONS="$(grep -oE 'AwsSolution/[A-Za-z0-9]+/v[0-9][0-9.]*' "$STACK_DIFF" 2>/dev/null |
    sort -u | tr '\n' ' ')"
  if [ -n "$STACK_VERSIONS" ]; then
    VERSIONS_SEEN="${VERSIONS_SEEN}${STACK_VERSIONS}"
  fi

  echo >>"$SUMMARY_FILE"
done

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

# ---- assemble --------------------------------------------------------------
{
  echo "Innovation Sandbox - pending changes"
  echo "===================================="
  echo "Generated:       $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Upstream commit: ${CODEBUILD_RESOLVED_SOURCE_VERSION:-unknown}"
  echo "Namespace:       ${NAMESPACE:-unset}"
  if [ -n "$VERSIONS_SEEN" ]; then
    # Render as "SO0284: v1.2.12 -> v1.2.15" rather than repeating the prefix.
    SOLUTION_ID="$(echo "$VERSIONS_SEEN" | tr ' ' '\n' | sed -n 's|^AwsSolution/\([^/]*\)/.*|\1|p' | sort -u | head -1)"
    VERSION_LIST="$(echo "$VERSIONS_SEEN" | tr ' ' '\n' | sed -n 's|^AwsSolution/[^/]*/||p' | sort -u -V | paste -sd '>' - | sed 's/>/ -> /g')"
    echo "Solution version: ${SOLUTION_ID}: ${VERSION_LIST}"
  fi
  echo
  if [ "$NEEDS_ATTENTION" -eq 1 ]; then
    echo ">> This diff contains replacements, removals, IAM changes or errors."
    echo ">> Read the summary below before approving."
  else
    echo ">> No replacements, removals or IAM changes detected."
  fi
  echo
  echo "SUMMARY"
  echo "-------"
  cat "$SUMMARY_FILE"
  echo "Reading notes"
  echo "-------------"
  echo "  Changes to Code.S3Key, aws:asset:path and asset.<hash> are expected on"
  echo "  every build - they are the rebuilt Lambda bundles, not a behaviour"
  echo "  change. A USER_AGENT_EXTRA change means the upstream solution version"
  echo "  moved. Focus on added/removed resources, replacements, and IAM."
  echo
  echo
  echo "FULL DIFF"
  echo "---------"
  cat "$DETAILS_FILE"
} >"$OUT_FILE"

echo "==> Rendered diff to ${OUT_FILE}"
