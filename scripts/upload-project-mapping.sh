#!/usr/bin/env bash
# Upload / refresh the project-mapping CSV used by the By-Project view's Athena name JOIN.
# The CSV format is: project_id,project_name,cost_center  (one row per project, no header).
#
# Usage: ./scripts/upload-project-mapping.sh <env> <path-to-csv>
# Example CSV:
#   proj-alpha,Customer Portal,CC-1001
#   proj-bravo,Fraud Detection,CC-2002
set -euo pipefail

ENV="${1:?Pass the environment, e.g. dev}"
CSV="${2:?Pass the path to the mapping CSV}"
STACK="Tums-${ENV}-Data"

[ -f "$CSV" ] || { echo "CSV not found: $CSV" >&2; exit 1; }

CURATED=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'Curated')].OutputValue | [0]" --output text 2>/dev/null)
# Fall back to the conventional name if the output key differs.
[ -z "$CURATED" ] || [ "$CURATED" = "None" ] && CURATED="token-monitoring-curated-${ENV}-$(aws sts get-caller-identity --query Account --output text)"

echo "Uploading $CSV -> s3://${CURATED}/mappings/project_mapping.csv"
aws s3 cp "$CSV" "s3://${CURATED}/mappings/project_mapping.csv"

echo "Done. Athena reads the new mapping immediately (the external table points at the prefix)."
echo "No table re-creation needed; the default /v1/projects path will reflect the update on the next query."
