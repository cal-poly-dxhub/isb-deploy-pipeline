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
# A diff is informational: failures are recorded in the output file but never
# abort the run, because being unable to render a diff must not block a deploy.
set -uo pipefail

OUT_FILE="${1:?usage: render_stage_diff.sh <out-file> <stack>:<account>:<region> ...}"
shift

DEPLOY_ROLE_NAME="${DEPLOY_ROLE_NAME:-InnovationSandboxPipelineDeployRole}"
# Targets in this account are diffed with the CodeBuild role directly, matching
# how deploy-step.ts skips role assumption for same-account deploys.
TOOLING_ACCOUNT="${TOOLING_ACCOUNT:-}"
CDK="npm run --silent --workspace @amzn/innovation-sandbox-infrastructure cdk --"

{
  echo "Innovation Sandbox - pending changes"
  echo "===================================="
  echo "Generated:       $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Upstream commit: ${CODEBUILD_RESOLVED_SOURCE_VERSION:-unknown}"
  echo "Namespace:       ${NAMESPACE:-unset}"
  echo
  echo "Review the resource changes below before approving."
  echo
} >"$OUT_FILE"

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
  } >>"$OUT_FILE"

  # Drop any previously assumed credentials so the CodeBuild role is used to
  # assume the next target role.
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

  if [ "$ACCOUNT" != "$TOOLING_ACCOUNT" ]; then
    if ! CREDS="$(aws sts assume-role \
      --role-arn "arn:aws:iam::${ACCOUNT}:role/${DEPLOY_ROLE_NAME}" \
      --role-session-name "cdk-diff-${STACK##*-}" \
      --duration-seconds 3600 2>&1)"; then
      echo "Could not assume ${DEPLOY_ROLE_NAME} in ${ACCOUNT}: ${CREDS}" >>"$OUT_FILE"
      continue
    fi

    AWS_ACCESS_KEY_ID="$(echo "$CREDS" | jq -r .Credentials.AccessKeyId)"
    AWS_SECRET_ACCESS_KEY="$(echo "$CREDS" | jq -r .Credentials.SecretAccessKey)"
    AWS_SESSION_TOKEN="$(echo "$CREDS" | jq -r .Credentials.SessionToken)"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  fi

  # cdk diff writes the human-readable diff to stderr, so fold both streams in.
  if ! AWS_REGION="$REGION" \
    CDK_DEFAULT_ACCOUNT="$ACCOUNT" \
    CDK_DEFAULT_REGION="$REGION" \
    $CDK diff "$STACK" >>"$OUT_FILE" 2>&1; then
    echo >>"$OUT_FILE"
    echo "(cdk diff exited non-zero for ${STACK} - see the output above.)" >>"$OUT_FILE"
  fi
done

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

echo "==> Rendered diff to ${OUT_FILE}"
