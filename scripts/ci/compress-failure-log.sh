#!/usr/bin/env bash
# compress-failure-log.sh — distill a failed GitHub Actions run into a small
# context brief for an AI fixer, instead of feeding it raw full logs.
#
# Usage: scripts/ci/compress-failure-log.sh <run_id> [output_file]
#        run_id may be empty — the script then tries the latest failed run on
#        the default branch, and degrades to a short note if that fails too.
# Env:   GH_TOKEN or GITHUB_TOKEN (for `gh`), GITHUB_REPOSITORY (owner/repo).
#
# Output sections: run metadata (workflow, branch, commit SHA, url), failed
# jobs/steps, first meaningful error/stack block, file paths mentioned in
# errors, last ~100 lines of the failed log, existing fix PR + retry round.
# Defensive throughout: any fetch failure yields a note, never a hard exit.
set -uo pipefail

RUN_ID="${1:-}"
OUT="${2:-/dev/stdout}"
REPO="${GITHUB_REPOSITORY:-}"
TAIL_LINES=100

note() { printf '%s\n' "$*" >> "$OUT"; }

: > "$OUT" 2>/dev/null || OUT=/dev/stdout

if [ -z "$REPO" ]; then
  note "(GITHUB_REPOSITORY unset — failure log compression skipped)"
  exit 0
fi

# Resolve a run id when none was given: latest failed run on the default branch.
if [ -z "$RUN_ID" ]; then
  DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo "")
  RUN_ID=$(gh run list --repo "$REPO" ${DEFAULT_BRANCH:+--branch "$DEFAULT_BRANCH"} \
             --status failure --limit 1 --json databaseId --jq '.[0].databaseId // ""' 2>/dev/null || echo "")
fi

if [ -z "$RUN_ID" ]; then
  note "(no failed run id available — reason from the finding text and the code)"
  exit 0
fi

META=$(gh run view "$RUN_ID" --repo "$REPO" \
        --json name,headBranch,headSha,conclusion,url,displayTitle 2>/dev/null || echo "")
if [ -z "$META" ]; then
  note "(could not fetch run $RUN_ID metadata — log fetch failed; reason from the code)"
  exit 0
fi

WF_NAME=$(echo "$META" | jq -r '.name // "?"')
BRANCH=$(echo "$META" | jq -r '.headBranch // "?"')
SHA=$(echo "$META" | jq -r '.headSha // "?"')
URL=$(echo "$META" | jq -r '.url // "?"')

{
  echo "# Compressed failure brief (run $RUN_ID)"
  echo
  echo "- Failed workflow: $WF_NAME"
  echo "- Branch: $BRANCH"
  echo "- Commit SHA: $SHA"
  echo "- Run URL: $URL"
  echo
} >> "$OUT"

# Failed jobs and their failed steps.
note "## Failed jobs / steps"
gh run view "$RUN_ID" --repo "$REPO" --json jobs \
  --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out")
        | "- job: \(.name)\n" + ((.steps // []) | map(select(.conclusion == "failure")) | map("  - failed step: \(.name)") | join("\n"))' \
  2>/dev/null >> "$OUT" || note "(job list unavailable)"
note ""

# Raw failed log (bounded — this file never reaches the model, only extracts do).
RAW=$(mktemp 2>/dev/null || echo "/tmp/compress-failure-log.$$.log")
if ! gh run view "$RUN_ID" --repo "$REPO" --log-failed > "$RAW" 2>/dev/null || [ ! -s "$RAW" ]; then
  gh run view "$RUN_ID" --repo "$REPO" --log > "$RAW" 2>/dev/null || true
fi

if [ -s "$RAW" ]; then
  # First meaningful error/stack block: first error-ish line plus following context.
  note "## First error/stack block"
  FIRST=$(grep -n -m1 -E 'Error|error TS|FAIL|failed|Exception|Traceback|panic:' "$RAW" 2>/dev/null | cut -d: -f1 || echo "")
  if [ -n "$FIRST" ]; then
    sed -n "${FIRST},$((FIRST + 25))p" "$RAW" >> "$OUT"
  else
    note "(no recognizable error line found)"
  fi
  note ""

  # File paths mentioned in errors.
  note "## File paths mentioned in errors"
  grep -oE '[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|cjs|py|sql|yml|yaml|css)(:[0-9]+)?' "$RAW" 2>/dev/null \
    | grep -v 'node_modules' | sort -u | head -30 >> "$OUT" || note "(none extracted)"
  note ""

  note "## Last $TAIL_LINES lines of failed log"
  tail -"$TAIL_LINES" "$RAW" >> "$OUT"
else
  note "(failed-log fetch unavailable — no log excerpts extracted)"
fi
rm -f "$RAW" 2>/dev/null || true

# Existing fix PR on this branch + retry round (self-healing loop context).
{
  echo
  echo "## Existing fix PR / retry round"
} >> "$OUT"
PR_JSON=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open \
            --json number,labels --jq '.[0] // empty' 2>/dev/null || echo "")
if [ -n "$PR_JSON" ]; then
  PR_NUM=$(echo "$PR_JSON" | jq -r '.number')
  ROUND=$(echo "$PR_JSON" | jq -r '[.labels[].name | select(startswith("selfheal-round-"))] | .[0] // "1 (initial attempt)"')
  note "- Open PR: #$PR_NUM"
  note "- Retry round: $ROUND"
else
  note "- No open PR for branch $BRANCH (fresh fix attempt)"
fi

exit 0
