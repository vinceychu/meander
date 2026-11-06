#!/usr/bin/env bash
# Unattended upstream sync + release, run daily on the 5090 by
# meander-autosync.timer (scripts/install-autosync.sh sets it up).
#
#   1. Fresh checkout of origin/main in its own folder (never your working copy).
#   2. scripts/sync-upstream.sh merges new LearnHarness commits.
#   3. Conflicts it can't settle mechanically (anything beyond package.json
#      metadata and the lockfile) stop the run: no guessing at code.
#   4. Gates: typecheck, lint, tests, production build. A test that already
#      failed on main is not held against the merge; any NEW failure is.
#   5. Pass: bump the patch version, push main -> GitHub builds the
#      release -> this PC's server restarts onto it (phone follows on open).
#      Fail: nothing is pushed to main; the attempt goes to an
#      upstream-sync/<date> branch and you get a notification.
#
#   scripts/auto-upstream.sh            normal run
#   scripts/auto-upstream.sh --dry-run  everything except pushing/releasing/notifying
#   MEANDER_FORCE_BASE=<sha> ... --dry-run   rehearse from an older upstream point
set -uo pipefail

REPO_URL=${MEANDER_REPO:-https://github.com/vinceychu/meander.git}
WORK=${MEANDER_AUTOSYNC_DIR:-$HOME/projects/meander-autosync}
LOG=${MEANDER_AUTOSYNC_LOG:-$HOME/.cache/meander-autosync.log}
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
exec 9>"$HOME/.cache/meander-autosync.lock"
flock -n 9 || { echo "$(date -Is) another run is active"; exit 0; }

log() { echo "[$(date -Is)] $*"; }
notify() {
	log "NOTIFY: $1"
	[ "$DRY" = 1 ] && return 0
	[ -x "$HOME/bin/notify" ] && "$HOME/bin/notify" "$1" "Meander auto-update" "${2:-default}" >/dev/null 2>&1 || true
}
# Owner rule on this PC: heavy jobs low priority, limited cores.
heavy() { nice -n 19 taskset -c 0-23 "$@"; }

log "=== auto-upstream start (dry=$DRY)"
if [ ! -d "$WORK/.git" ]; then
	git clone -q "$REPO_URL" "$WORK" || { notify "clone failed" high; exit 1; }
fi
cd "$WORK" || exit 1
# Push over the repo's SSH deploy key when this PC has one (~/.ssh/config
# "Host github-meander"); fetches stay on public HTTPS. No gh token needed.
PUSH_URL=${MEANDER_PUSH_URL:-}
[ -z "$PUSH_URL" ] && grep -q "^Host github-meander" "$HOME/.ssh/config" 2>/dev/null && PUSH_URL=git@github-meander:vinceychu/meander.git
[ -n "$PUSH_URL" ] && git remote set-url --push origin "$PUSH_URL"
git merge --abort >/dev/null 2>&1; git reset -q --hard; git clean -qfdx -e node_modules
git fetch -q origin main --tags || { notify "fetch failed" high; exit 1; }
git checkout -q -B main origin/main
# Testing only: pretend Meander is synced to an older upstream commit.
if [ -n "${MEANDER_FORCE_BASE:-}" ]; then
	sed -i "s/^commit=.*/commit=$MEANDER_FORCE_BASE/" .upstream-sync
	git -c user.name=t -c user.email=t commit -qam "test: force upstream base"
fi

PENDING=$(bash scripts/sync-upstream.sh --check | head -1 | cut -d' ' -f1)
case "$PENDING" in
	''|*[!0-9]*) notify "upstream check failed" high; exit 1 ;;
	0) log "up to date"; exit 0 ;;
esac
log "$PENDING upstream commit(s) pending"
BASE=$(sed -n 's/^commit=//p' .upstream-sync)

# Baseline: tests that already fail on main (Linux-only quirks etc.).
heavy npm ci --no-audit --no-fund >/dev/null || { notify "npm ci failed on main" high; exit 1; }
run_tests() { NODE_ENV=test heavy npx tsx --test tests/*.test.ts tests/*.test.tsx 2>&1 | sed -n 's/^not ok [0-9]* - //p' | sort -u; }
BASELINE=$(run_tests)
log "baseline failures on main: $(echo "$BASELINE" | grep -c . )"

bash scripts/sync-upstream.sh
TIP=$(sed -n 's/^commit=//p' .upstream-sync)
COUNT=$(git rev-list --count "$BASE..$TIP")
SUBJECTS=$(git log --first-parent --format='- %s' "$BASE..$TIP" | grep -v -E '^- (Merge current main|test|chore)' | head -40)

CONFLICTS=$(git diff --name-only --diff-filter=U)
if [ -n "$CONFLICTS" ]; then
	log "conflicts: $(echo $CONFLICTS)"
	FAIL="merge conflicts in $(echo $CONFLICTS)"
fi

gates() {
	heavy npm ci --no-audit --no-fund >/dev/null || { echo "npm ci"; return; }
	npm run -s typecheck >/tmp/meander-autosync-tsc.txt 2>&1 || { echo "typecheck"; return; }
	npx eslint . >/tmp/meander-autosync-lint.txt 2>&1 || { echo "lint"; return; }
	local new; new=$(comm -13 <(echo "$BASELINE") <(run_tests))
	[ -n "$new" ] && { echo "new test failures: $(echo "$new" | tr '\n' ';')"; return; }
	heavy npx next build >/tmp/meander-autosync-build.txt 2>&1 || { echo "next build"; return; }
}
if [ -z "${FAIL:-}" ]; then
	git add -A
	FAIL=$(gates)
fi

DATE=$(date +%F)
if [ -n "$FAIL" ]; then
	git add -A
	git -c user.name="Meander autosync" -c user.email="vinceychu@users.noreply.github.com" commit -qm "WIP upstream sync to ${TIP:0:7} (failed: $FAIL)" --no-verify || true
	[ $DRY = 0 ] && git push -qf origin "HEAD:refs/heads/upstream-sync/$DATE"
	notify "Upstream merge of $COUNT commits needs you: $FAIL. Branch upstream-sync/$DATE" high
	exit 1
fi

OLD=$(node -p 'require("./package.json").version')
NEW=$(node -p '(v=>{v=v.split(".");v[2]=+v[2]+1;return v.join(".")})(require("./package.json").version)')
node -e '
const fs=require("fs"),v=process.argv[1];
for (const f of ["package.json","package-lock.json"]) { const j=JSON.parse(fs.readFileSync(f,"utf8")); j.version=v; if (j.packages?.[""]) j.packages[""].version=v; fs.writeFileSync(f, JSON.stringify(j,null,"\t")+"\n"); }' "$NEW"
git add -A
git -c user.name="Vincent Chu" -c user.email="vinceychu@users.noreply.github.com" commit -q -F - <<MSG
Meander $NEW: merge $COUNT LearnHarness commits (${BASE:0:7}..${TIP:0:7})

Automatic upstream sync (scripts/auto-upstream.sh). Typecheck, lint,
tests (no new failures vs $OLD) and the production build passed.

$SUBJECTS
MSG
if [ $DRY = 1 ]; then log "dry run: would release $NEW"; exit 0; fi
# A version bump on main is enough: release.yml publishes v$NEW (and creates
# the tag) by itself. Pushing a tag too would start a second release run.
git push -q origin main || { notify "push of $NEW failed" high; exit 1; }
log "pushed v$NEW; waiting for the release"

API=https://api.github.com/repos/vinceychu/meander/releases/latest
for _ in $(seq 1 90); do
	sleep 60
	[ "$(curl -fsS "$API" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tag_name)}catch{}})')" = "v$NEW" ] && break
done
if [ "$(curl -fsS "$API" | node -p 'JSON.parse(require("fs").readFileSync(0)).tag_name' 2>/dev/null)" != "v$NEW" ]; then
	notify "v$NEW pushed but the release didn't publish within 90 min; check GitHub Actions" high
	exit 1
fi
# Serve mode checks on launch, installs, exits; systemd brings it back new.
systemctl --user restart meander.service
notify "Meander $NEW released: $COUNT upstream LearnHarness commits merged. This PC's server is updating; the phone gets it on next open."
log "=== done: v$NEW"
