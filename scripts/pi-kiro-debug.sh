#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${KIRO_LOG:-}" ]]; then
  export KIRO_LOG="debug"
fi

if [[ -z "${KIRO_LOG_FILE:-}" ]]; then
  export KIRO_LOG_FILE="$REPO_ROOT/.pi/kiro-debug.jsonl"
fi

mkdir -p "$(dirname "$KIRO_LOG_FILE")"

if [[ "${PI_KIRO_DEBUG_DRY_RUN:-}" == "1" ]]; then
  printf 'KIRO_LOG=%s\n' "$KIRO_LOG"
  printf 'KIRO_LOG_FILE=%s\n' "$KIRO_LOG_FILE"
  printf 'COMMAND=pi'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\n'
  exit 0
fi

exec pi "$@"
