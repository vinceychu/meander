#!/usr/bin/env bash
# Merge new LearnHarness (upstream) commits into the current branch.
#
# Meander's history does not contain upstream's, so a plain `git merge`
# has no common ancestor. This script uses the commit recorded in
# .upstream-sync as the merge base (via a temporary local graft), merges
# upstream into the working tree, and leaves the result uncommitted so
# conflicts can be resolved. Nothing upstream-authored enters Meander's
# history: the result is committed as one ordinary commit.
#
#   scripts/sync-upstream.sh          merge, then resolve + commit
#   scripts/sync-upstream.sh --check  print how many commits are pending
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

conf() { sed -n "s/^$1=//p" .upstream-sync; }
REPO=$(conf repo); BRANCH=$(conf branch); BASE=$(conf commit)

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$REPO"
git fetch --quiet --no-tags upstream "$BRANCH"
git cat-file -e "$BASE^{commit}" 2>/dev/null || git fetch --quiet --no-tags --depth 1000 upstream "$BRANCH"
TIP=$(git rev-parse "upstream/$BRANCH")

PENDING=$(git rev-list --count "$BASE..$TIP")
if [ "${1:-}" = "--check" ]; then
	echo "$PENDING upstream commit(s) not yet in Meander ($BASE..$TIP)"
	git log --no-merges --format='  %h %ad %s' --date=short "$BASE..$TIP" | head -50
	exit 0
fi
[ "$PENDING" = 0 ] && { echo "Already up to date with upstream ($TIP)."; exit 0; }
[ -z "$(git status --porcelain)" ] || { echo "Working tree is dirty; commit or stash first." >&2; exit 1; }

ROOT=$(git rev-list --max-parents=0 HEAD | tail -1)
git replace --graft "$ROOT" "$BASE"
trap 'git replace -d "$ROOT" >/dev/null 2>&1 || true' EXIT
set +e
git merge --no-commit --no-ff "$TIP"
set -e
git replace -d "$ROOT" >/dev/null; trap - EXIT
# The merge state would record upstream as a parent; drop it so the
# commit stays single-parent (squash), keeping the index/worktree.
rm -f .git/MERGE_HEAD .git/MERGE_MODE
sed -i "s/^commit=.*/commit=$TIP/" .upstream-sync
git add .upstream-sync

# Conflicts that happen on every sync and have one right answer:
# - package.json: Meander's own version/name/author/homepage lines win.
# - package-lock.json: regenerate from the merged package.json.
if git diff --name-only --diff-filter=U | grep -qx package.json; then
	python3 - <<'PY'
import re
p = "package.json"
s = open(p).read()
pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
meta = re.compile(r'^\s*"(version|name|homepage|desktopName|description)"\s*:|^\s*"(name|email)"\s*:', re.M)
def keep_ours(m):
	ours, theirs = m.group(1), m.group(2)
	lines = [l for l in (ours + theirs).splitlines() if l.strip()]
	return ours if all(meta.search(l) for l in lines) else m.group(0)
open(p, "w").write(pat.sub(keep_ours, s))
PY
	grep -q '^<<<<<<< ' package.json || git add package.json
fi
if git diff --name-only --diff-filter=U | grep -qx package-lock.json && ! grep -q '^<<<<<<< ' package.json; then
	git checkout --theirs package-lock.json
	npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
	git add package-lock.json
fi

echo
echo "Merged $PENDING upstream commit(s) up to $TIP into the working tree."
echo "Conflicted files (resolve, then: git add -A && npm run typecheck && npm test && git commit):"
git diff --name-only --diff-filter=U
