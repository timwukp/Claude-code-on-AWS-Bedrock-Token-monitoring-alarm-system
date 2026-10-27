#!/usr/bin/env bash
# Create one application inference profile (AIP) per model for a TUMS project, tagged
# tums-project=<project>, so every call routed through it is attributed to the project
# (attribution tier 1 — config-routed, IAM-enforceable, no per-call effort).
#
# Usage:
#   ./scripts/create-project-aip.sh [--dry-run] <project-id> <model-id> [<model-id>...]
#   ./scripts/create-project-aip.sh llmops-agentic-system us.anthropic.claude-opus-5-5 us.anthropic.claude-haiku-5-5
#
# A model id with a cross-region prefix (us. / global. / eu. / apac.) is a system inference
# profile; the AIP copies from its ARN. Any other id is treated as a foundation model id.
# Idempotent: an existing profile named tums-<project>-<model-slug> is reused, not recreated.
# Needs: aws CLI with bedrock:ListInferenceProfiles, GetInferenceProfile, CreateInferenceProfile,
# TagResource; sts:GetCallerIdentity.
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
if [[ $# -lt 2 ]]; then
  echo "usage: $0 [--dry-run] <project-id> <model-id> [<model-id>...]" >&2
  exit 2
fi
PROJECT="$1"; shift
if [[ ! "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]]; then
  echo "project id must be lowercase letters, digits and hyphens: $PROJECT" >&2
  exit 2
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || true)}}"
if [[ -z "$REGION" ]]; then echo "set AWS_REGION" >&2; exit 2; fi
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run] %q ' "$@"; echo
    return 0
  fi
  "$@"
}

# One listing, reused for every model.
EXISTING_JSON=$(aws bedrock list-inference-profiles --type-equals APPLICATION --region "$REGION" \
  --query 'inferenceProfileSummaries[].{name:inferenceProfileName,arn:inferenceProfileArn}' --output json)

existing_arn_for() {
  python3 -c 'import json,sys
name=sys.argv[1]
for p in json.loads(sys.argv[2]):
    if p["name"]==name: print(p["arn"]); break' "$1" "$EXISTING_JSON"
}

slug_of() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'; }

ARNS=()
FIRST_ARN=""
HAIKU_ARN=""
for MODEL in "$@"; do
  SLUG=$(slug_of "$MODEL")
  NAME="tums-${PROJECT}-${SLUG}"
  # Profile names are capped at 64 characters.
  NAME="${NAME:0:64}"

  if [[ "$MODEL" =~ ^(us|global|eu|apac)\. ]]; then
    SOURCE_ARN=$(aws bedrock get-inference-profile --inference-profile-identifier "$MODEL" --region "$REGION" \
      --query inferenceProfileArn --output text)
  else
    SOURCE_ARN="arn:aws:bedrock:${REGION}::foundation-model/${MODEL}"
  fi

  ARN=$(existing_arn_for "$NAME")
  if [[ -n "$ARN" ]]; then
    echo "exists   $NAME -> $ARN"
  else
    echo "creating $NAME (copyFrom=$SOURCE_ARN)"
    if [[ $DRY_RUN -eq 1 ]]; then
      run aws bedrock create-inference-profile --region "$REGION" \
        --inference-profile-name "$NAME" --description "TUMS project ${PROJECT}" \
        --model-source "copyFrom=${SOURCE_ARN}" --tags "key=tums-project,value=${PROJECT}"
      ARN="arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/<pending>"
    else
      ARN=$(aws bedrock create-inference-profile --region "$REGION" \
        --inference-profile-name "$NAME" --description "TUMS project ${PROJECT}" \
        --model-source "copyFrom=${SOURCE_ARN}" --tags "key=tums-project,value=${PROJECT}" \
        --query inferenceProfileArn --output text)
      echo "created  $NAME -> $ARN"
    fi
  fi

  ARNS+=("$ARN")
  [[ -z "$FIRST_ARN" ]] && FIRST_ARN="$ARN"
  if [[ "$MODEL" == *haiku* && -z "$HAIKU_ARN" ]]; then HAIKU_ARN="$ARN"; fi
done

echo
echo "Application inference profiles for project '${PROJECT}':"
for A in "${ARNS[@]}"; do echo "  $A"; done

echo
echo "Paste into the repo's .claude/settings.json (Claude Code CLI and Desktop both read it):"
if [[ -n "$HAIKU_ARN" ]]; then
  cat <<EOF
{
  "env": {
    "ANTHROPIC_MODEL": "${FIRST_ARN}",
    "ANTHROPIC_SMALL_FAST_MODEL": "${HAIKU_ARN}"
  }
}
EOF
else
  cat <<EOF
{
  "env": {
    "ANTHROPIC_MODEL": "${FIRST_ARN}"
  }
}
EOF
fi

echo
echo "Register the profiles in the dashboard Settings → Project registry (or wait for the tag resolver)."
