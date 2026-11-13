#!/usr/bin/env bash
# AI fallback for an upstream merge that git can't settle by itself.
# Called by scripts/auto-upstream.sh with the merge sitting in the working tree.
#
#   scripts/ai-resolve.sh conflicts        resolve every conflicted file
#   scripts/ai-resolve.sh gates <logfile>  fix typecheck/lint/test/build failures the merge caused
#
# Runs Claude Code headless in this checkout. It may edit files and run npm
# scripts; it never commits or pushes (auto-upstream.sh does that after the
# gates pass). Exit 0 = it finished and no conflict markers remain.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
MODE=${1:-conflicts}
CLAUDE=${MEANDER_CLAUDE:-$(command -v claude-auto || command -v claude)}
[ -x "$CLAUDE" ] || { echo "ai-resolve: no claude CLI"; exit 2; }
BASE=$(git show HEAD:.upstream-sync | sed -n 's/^commit=//p')
TIP=$(sed -n 's/^commit=//p' .upstream-sync)

read -r -d '' RULES <<EOF
You are merging upstream LearnHarness (github.com/amosblomqvist/learnharness) into Meander,
Vince's fork of it. Repo: this directory. Upstream range: ${BASE}..${TIP} (fetch remote 'upstream';
'git log ${BASE}..${TIP}' and 'git show <sha>' explain what upstream changed and why).
The fork's own history: 'git log HEAD' (commits titled "Meander x.y.z: ...").

Goal: Meander gets EVERY upstream feature and fix, and keeps EVERY Meander change.
- Meander-owned, always keep ours: product name/branding (Meander, the three-strand "m" mark,
  icons, app id, userData dir names stay as they are on HEAD), version in package.json, README,
  release/CI workflows (.github/workflows: Meander's release-on-merge + mac/linux packaging),
  update feed/URLs (vinceychu/meander), the Notes vault, Courses/course adapters, phone server
  (--serve), Stats, day/night mode, keys backup, Tailscale/shared-server code, scripts/*autosync*.
- Everything else: take upstream's new code and re-apply Meander's change on top of it when both
  touched the same lines. Never drop an upstream feature to make a conflict go away, and never drop
  a Meander feature either. If upstream deleted a file Meander still uses, keep Meander's file.
- Prefer upstream's structure when upstream refactored; port Meander's behaviour into it.
- package-lock.json: take upstream's, then run 'npm install --package-lock-only --ignore-scripts'.
Do not commit, push, tag, or touch git config/remotes. Do not run 'git merge --abort' or reset.
Keep this cheap: no full test suite unless asked; use targeted commands.
EOF

if [ "$MODE" = conflicts ]; then
	FILES=$(git diff --name-only --diff-filter=U)
	[ -z "$FILES" ] && { echo "ai-resolve: nothing conflicted"; exit 0; }
	TASK="Resolve every merge conflict. Conflicted files (git status shows the type; DU = upstream deleted, we modified):
$FILES
For each file: read both sides and the relevant upstream commits, write the merged file with no
conflict markers, then 'git add' it. When all are done run 'npm run typecheck' and fix whatever the
merge broke (only merge fallout). Finish with one short line per file saying what you kept."
else
	LOGF=${2:?gates log}
	TASK="The merge is resolved but these checks fail (tail of the log below). Fix the code the merge
broke so they pass. Tests that also fail on Meander main are listed as baseline and may be ignored.
Re-run only the failing command(s) to confirm. Then 'git add -A'.
----
$(tail -c 15000 "$LOGF")"
fi

timeout 3h "$CLAUDE" -p "$RULES

$TASK" --permission-mode bypassPermissions --max-turns 400 --output-format text \
	</dev/null 2>&1 | tail -80
if git diff --name-only --diff-filter=U | grep -q . || git grep -lE '^(<<<<<<<|>>>>>>>) ' -- . >/dev/null 2>&1; then
	echo "ai-resolve: conflict markers remain"; exit 1
fi
exit 0
