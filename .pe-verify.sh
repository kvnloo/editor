#!/usr/bin/env bash
# usage (inside a PR worktree via fleet-build): pe-verify.sh <pkg> <test files...> -- <biome files...>
set -o pipefail
export BUN_INSTALL=$HOME/.bun-pe; export PATH=$BUN_INSTALL/bin:$PATH
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null 2>&1
bun --version
pkg=$1; shift; tests=(); while [ "$1" != -- ] && [ -n "$1" ]; do tests+=("$1"); shift; done; shift
bun install --frozen-lockfile --ignore-scripts >/tmp/pe-install.log 2>&1 || { echo INSTALL_FAIL; tail -20 /tmp/pe-install.log; }
echo "== biome"; bunx biome check "$@" 2>&1 | tail -15; echo "biome_rc=$?"
for t in "${tests[@]}"; do d=$(dirname "$t"); echo "== test $t"; (cd "packages/${t%%/*}" 2>/dev/null || true; bun test "${t#*/}" 2>&1 | tail -25); done
