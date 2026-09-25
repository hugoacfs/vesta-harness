#!/bin/sh
# homes-drift.sh — report where the live Harness homes differ from the versioned templates.
# Runs ON vesta (report only, changes nothing):
#   sh ~/code/vesta-harness-staging/deploy/vesta/verify/homes-drift.sh
# Production is compared with the production checkout's templates, staging with the staging
# checkout's. Known, intended divergence: the staging settings carry the `ceres` model alias
# (2026-09-06). Secrets never appear: settings live apart from credentials, and the diff lines
# are filtered by key name anyway.
set -u
LIMIT="${LIMIT:-40}"
pair() { # label template live
  if [ ! -f "$2" ]; then echo "MISSING template  $1 ($2)"; return; fi
  if [ ! -f "$3" ]; then echo "MISSING live      $1 ($3)"; return; fi
  if diff -q "$2" "$3" >/dev/null 2>&1; then echo "same    $1"
  else echo "DRIFT   $1"; diff -u "$2" "$3" | grep -v -i 'apikey\|api_key\|token\|secret\|password' | sed 's/^/        /' | head -n "$LIMIT"; fi
}
presets() { # label template-dir live-dir
  if diff -rq "$2" "$3" >/dev/null 2>&1; then echo "same    $1"; else echo "DRIFT   $1"; diff -rq "$2" "$3" | sed 's/^/        /' | head -n "$LIMIT"; fi
}
P=$HOME/code/vesta-harness/deploy/vesta;         PH=$HOME/.vesta-harness
S=$HOME/code/vesta-harness-staging/deploy/vesta; SH=$HOME/.vesta-harness-staging
echo "== production: $PH against $P ($(git -C "$HOME/code/vesta-harness" rev-parse --short HEAD 2>/dev/null))"
pair "settings.yaml"  "$P/settings.yaml"                     "$PH/settings.yaml"
pair "home patch"     "$P/home-cordis.patch.yml"             "$PH/cordis.patch.yml"
pair "profile patch"  "$P/profiles/vesta/cordis.patch.yml"   "$PH/profiles/vesta/cordis.patch.yml"
pair "hooks.json"     "$P/hooks/hooks.json"                  "$PH/hooks.json"
presets "presets"     "$P/agent-presets"                     "$PH/.agent-presets"
echo "== staging: $SH against $S ($(git -C "$HOME/code/vesta-harness-staging" rev-parse --short HEAD 2>/dev/null))"
pair "settings.yaml (ceres alias is expected)" "$S/settings.yaml" "$SH/settings.yaml"
pair "home patch"     "$S/staging-home-cordis.patch.yml"     "$SH/cordis.patch.yml"
pair "profile patch"  "$S/staging-cordis.patch.yml"          "$SH/profiles/vesta/cordis.patch.yml"
pair "hooks.json"     "$S/hooks/hooks.json"                  "$SH/hooks.json"
presets "presets"     "$S/agent-presets"                     "$SH/.agent-presets"
