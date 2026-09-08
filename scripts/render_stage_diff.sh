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
set -f # parameter values can contain '*' ARN patterns; never pathname-expand them

OUT_FILE="${1:?usage: render_stage_diff.sh <out-file> <stack>:<account>:<region> ...}"
shift

DEPLOY_ROLE_NAME="${DEPLOY_ROLE_NAME:-InnovationSandboxPipelineDeployRole}"
# Targets in this account are diffed with the CodeBuild role directly, matching
# how deploy-step.ts skips role assumption for same-account deploys.
TOOLING_ACCOUNT="${TOOLING_ACCOUNT:-}"
CDK="npm run --silent --workspace @amzn/innovation-sandbox-infrastructure cdk --"

# Read-only change sets are subject to the same CloudFormation validation as a

# Match the build-time contexts used by deploy-step.ts/upstream
CDK_CONTEXT_ARGS=(--context "deploymentMode=${DEPLOYMENT_MODE:-prod}")
[ -n "${LOG_LEVEL:-}" ] && CDK_CONTEXT_ARGS+=(--context "logLevel=$LOG_LEVEL")
[ -n "${CLOUDWATCH_LOG_RETENTION_IN_DAYS:-}" ] && CDK_CONTEXT_ARGS+=(--context "cloudWatchLogRetentionInDays=$CLOUDWATCH_LOG_RETENTION_IN_DAYS")
[ -n "${S3_LOGS_ARCHIVE_RETENTION_IN_DAYS:-}" ] && CDK_CONTEXT_ARGS+=(--context "s3LogsArchiveRetentionInDays=$S3_LOGS_ARCHIVE_RETENTION_IN_DAYS")
[ -n "${S3_LOGS_GLACIER_RETENTION_IN_DAYS:-}" ] && CDK_CONTEXT_ARGS+=(--context "s3LogsGlacierRetentionInDays=$S3_LOGS_GLACIER_RETENTION_IN_DAYS")
[ -n "${API_THROTTLING_RATE_LIMIT:-}" ] && CDK_CONTEXT_ARGS+=(--context "apiThrottlingRateLimit=$API_THROTTLING_RATE_LIMIT")
[ -n "${API_THROTTLING_BURST_LIMIT:-}" ] && CDK_CONTEXT_ARGS+=(--context "apiThrottlingBurstLimit=$API_THROTTLING_BURST_LIMIT")
[ -n "${COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES:-}" ] && CDK_CONTEXT_ARGS+=(--context "cognitoAccessTokenValidityMinutes=$COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES")
[ -n "${COGNITO_ID_TOKEN_VALIDITY_MINUTES:-}" ] && CDK_CONTEXT_ARGS+=(--context "cognitoIdTokenValidityMinutes=$COGNITO_ID_TOKEN_VALIDITY_MINUTES")
[ -n "${COGNITO_REFRESH_TOKEN_VALIDITY_DAYS:-}" ] && CDK_CONTEXT_ARGS+=(--context "cognitoRefreshTokenValidityDays=$COGNITO_REFRESH_TOKEN_VALIDITY_DAYS")
[ -n "${NUKE_CONFIG_FILE_PATH:-}" ] && CDK_CONTEXT_ARGS+=(--context "nukeConfigFilePath=$NUKE_CONFIG_FILE_PATH")
[ -n "${SCP_DIRECTORY_PATH:-}" ] && CDK_CONTEXT_ARGS+=(--context "scpDirectoryPath=$SCP_DIRECTORY_PATH")
[ -n "${PRIVATE_ECR_REPO:-}" ] && CDK_CONTEXT_ARGS+=(--context "privateEcrRepo=$PRIVATE_ECR_REPO")
# real deploy: every required Parameter must be supplied, or CreateChangeSet
# throws MissingParameters and cdk diff silently falls back to a template-only
# diff ("Could not create a change set..."). This mirrors stackDeployCmd in
# lib/steps/deploy-step.ts exactly - same stacks, same parameters, same
# required/optional split - so the two cannot drift out of sync again.
stack_parameters() {
  case "$1" in
    InnovationSandbox-AccountPool)
      printf -- '--parameters Namespace=%s --parameters ParentOuId=%s --parameters HubAccountId=%s --parameters IsbManagedRegions=%s' \
        "${NAMESPACE:?NAMESPACE is required}" \
        "${PARENT_OU_ID:?PARENT_OU_ID is required}" \
        "${HUB_ACCOUNT_ID:?HUB_ACCOUNT_ID is required}" \
        "${AWS_REGIONS:?AWS_REGIONS is required}"
      [ -n "${ADDITIONAL_ALLOWED_SERVICES:-}" ] && printf -- ' --parameters AdditionalAllowedServices=%s' "$ADDITIONAL_ALLOWED_SERVICES"
      [ -n "${ADDITIONAL_PRINCIPAL_EXCEPTIONS:-}" ] && printf -- ' --parameters AdditionalPrincipalExceptions=%s' "$ADDITIONAL_PRINCIPAL_EXCEPTIONS"
      [ -n "${BEDROCK_INFERENCE_PROFILE_PATTERNS:-}" ] && printf -- ' --parameters BedrockInferenceProfilePatterns=%s' "$BEDROCK_INFERENCE_PROFILE_PATTERNS"
      ;;
    InnovationSandbox-IDC)
      printf -- '--parameters Namespace=%s --parameters IdentityStoreId=%s --parameters SsoInstanceArn=%s --parameters OrgMgtAccountId=%s --parameters HubAccountId=%s' \
        "${NAMESPACE:?NAMESPACE is required}" \
        "${IDENTITY_STORE_ID:?IDENTITY_STORE_ID is required}" \
        "${SSO_INSTANCE_ARN:?SSO_INSTANCE_ARN is required}" \
        "${ORG_MGT_ACCOUNT_ID:?ORG_MGT_ACCOUNT_ID is required}" \
        "${HUB_ACCOUNT_ID:?HUB_ACCOUNT_ID is required}"
      [ -n "${ADMIN_GROUP_NAME:-}" ] && printf -- ' --parameters AdminGroupName=%s' "$ADMIN_GROUP_NAME"
      [ -n "${MANAGER_GROUP_NAME:-}" ] && printf -- ' --parameters ManagerGroupName=%s' "$MANAGER_GROUP_NAME"
      [ -n "${USER_GROUP_NAME:-}" ] && printf -- ' --parameters UserGroupName=%s' "$USER_GROUP_NAME"
      ;;
    InnovationSandbox-Data)
      printf -- '--parameters Namespace=%s --parameters SamlMetadataUrl=%s --parameters AwsAccessPortalUrl=%s' \
        "${NAMESPACE:?NAMESPACE is required}" \
        "${SAML_METADATA_URL:?SAML_METADATA_URL is required for v1.3.0}" \
        "${AWS_ACCESS_PORTAL_URL:?AWS_ACCESS_PORTAL_URL is required for v1.3.0}"
      ;;
    InnovationSandbox-Compute)
      printf -- '--parameters Namespace=%s --parameters OrgMgtAccountId=%s --parameters IdcAccountId=%s --parameters AcceptSolutionTermsOfUse=%s' \
        "${NAMESPACE:?NAMESPACE is required}" \
        "${ORG_MGT_ACCOUNT_ID:?ORG_MGT_ACCOUNT_ID is required}" \
        "${IDC_ACCOUNT_ID:?IDC_ACCOUNT_ID is required}" \
        "${ACCEPT_SOLUTION_TERMS_OF_USE:-Accept}"
      [ -n "${CUSTOM_DOMAIN_NAME:-}" ] && printf -- ' --parameters CustomDomainName=%s' "$CUSTOM_DOMAIN_NAME"
      [ -n "${CUSTOM_DOMAIN_CERTIFICATE_ARN:-}" ] && printf -- ' --parameters CustomDomainCertificateArn=%s' "$CUSTOM_DOMAIN_CERTIFICATE_ARN"
      [ -n "${ALLOW_LISTED_IP_RANGES:-}" ] && printf -- ' --parameters AllowListedIPRanges=%s' "$ALLOW_LISTED_IP_RANGES"
      [ -n "${USE_STABLE_TAGGING:-}" ] && printf -- ' --parameters UseStableTagging=%s' "$USE_STABLE_TAGGING"
      ;;
    *)
      echo "WARNING: no known CloudFormation Parameters for stack '$1'; diff may fail to create a change set." >&2
      ;;
  esac
}

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
  #
  # Set DIFF_VERBOSE=1 to add `-v`, which prints WHY a read-only change set
  # could not be created ("Could not create a change set, will base the diff on
  # template differences"). Change-set mode gives accurate replacement info, so
  # the reason it falls back is worth seeing. Leave unset in normal operation -
  # -v is extremely noisy.
  VERBOSE_FLAG=""
  [ "${DIFF_VERBOSE:-0}" = "1" ] && VERBOSE_FLAG="-v"
  : >"$STACK_DIFF"
  #
  # --context deploymentMode must match what deploy-step.ts passes to `cdk
  # deploy` for this same stack, or the diff compares against the wrong
  # baseline.
  #
  # STACK_PARAMS is intentionally unquoted below: it is a space-separated list
  # of "--parameters Key=Value" pairs built by stack_parameters(), and none of
  # the values it substitutes contain spaces (account IDs, ARNs, region lists,
  # group names), so word-splitting is the desired behaviour here.
  if ! STACK_PARAMS="$(stack_parameters "$STACK" 2>&1)"; then
    echo "Could not resolve required parameters for ${STACK}: ${STACK_PARAMS}" >>"$DETAILS_FILE"
    printf '%s (%s/%s)\n  !! missing a required config variable - diff unavailable\n\n' \
      "$STACK" "$ACCOUNT" "$REGION" >>"$SUMMARY_FILE"
    NEEDS_ATTENTION=1
    continue
  fi
  if AWS_REGION="$REGION" \
    CDK_DEFAULT_ACCOUNT="$ACCOUNT" \
    CDK_DEFAULT_REGION="$REGION" \
    $CDK diff "$STACK" --no-color $VERBOSE_FLAG \
      "${CDK_CONTEXT_ARGS[@]}" \
      $STACK_PARAMS \
      >"$STACK_DIFF" 2>&1; then
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
