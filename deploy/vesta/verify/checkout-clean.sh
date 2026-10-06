#!/bin/sh
# checkout-clean.sh — report whether the deployment checkouts carry uncommitted work.
# The checkouts are the deployment source: they must stay clean. Uncommitted work
# belongs on a branch (a worktree for long-lived work), never loose in the tree that
# deploys (P29, 2026-10-06: an untracked example draft sat in the production checkout
# for five days before anything noticed). Runs ON vesta, changes nothing:
#   sh ~/code/vesta-harness-staging/deploy/vesta/verify/checkout-clean.sh
# Exit 0 when both checkouts are clean; exit 1 when either carries uncommitted or
# untracked files. vesta-build runs this as a pre-step and refuses a dirty tree.
set -u
check() { # label path
  branch=$(git -C "$2" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  head=$(git -C "$2" rev-parse --short HEAD 2>/dev/null || echo '?')
  dirty=$(git -C "$2" status --porcelain 2>/dev/null)
  if [ -z "$dirty" ]; then
    echo "clean  $1 ($head @ $branch)"
    return 0
  fi
  echo "DIRTY  $1 ($head @ $branch)"
  printf '%s\n' "$dirty" | sed 's/^/       /' | head -n 20
  return 1
}
rc=0
check "production  ~/code/vesta-harness"       "$HOME/code/vesta-harness"       || rc=1
check "staging     ~/code/vesta-harness-staging" "$HOME/code/vesta-harness-staging" || rc=1
exit $rc
