/**
 * MAC SELF-UPDATE for the fork's ad-hoc-signed builds (fork, 2026-10-27).
 *
 * Squirrel.Mac — what electron-updater uses on macOS — only installs an
 * update whose code signature satisfies the running app's designated
 * requirement, which an ad-hoc signature (no Apple Developer ID) never
 * does. So on the Mac, electron-updater only CHECKS (autoDownload off) and
 * this module does the rest:
 *
 *   1. pick the release zip for this CPU from the feed's file list,
 *   2. download it and verify the feed's sha512,
 *   3. unpack it with ditto into a staging dir,
 *   4. on restart (or quit): a detached shell script waits for this
 *      process to exit, updates the .app in place (keeping its Dock pin,
 *      even across a rename), clears the quarantine flag, re-signs
 *      ad-hoc, refreshes the Dock if the name/icon changed, and relaunches.
 */

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The zip in a latest-mac.yml `files` list that matches this CPU. */
function pickMacZip(files, arch) {
	const zips = (files ?? []).filter((f) => typeof f?.url === "string" && f.url.endsWith(".zip"));
	const isArm = (f) => /arm64/.test(f.url);
	return zips.find((f) => (arch === "arm64" ? isArm(f) : !isArm(f))) ?? null;
}

/** /Applications/Meander.app from …/Meander.app/Contents/MacOS/Meander. */
function appBundlePath(execPath) {
	const bundle = path.resolve(execPath, "..", "..", "..");
	return bundle.endsWith(".app") ? bundle : null;
}

/** Shell-quote one argument. */
function q(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The swap script (pure — tested as text, and run with stubbed macOS tools
 * in tests/data-location.test.ts).
 *
 * Updates the bundle IN PLACE (rsync into the same directory) and, if the
 * new build has a different name, renames that same directory. The Dock
 * remembers apps by their file identity, so an in-place update + rename
 * keeps the Dock pin; replacing the bundle with a new copy would leave a
 * "?" in the Dock. A name or icon change also restarts the Dock once so it
 * redraws (macOS caches both).
 *
 * macOS 13+ "App Management" can refuse an app without a Developer ID
 * writing into an app bundle (its own included). Then the in-place copy
 * fails before changing anything, and the script falls back to swapping
 * whole bundles by rename (old one into the temp dir, staged one in). If that is
 * refused too, the old app is left as it was and relaunched, and the
 * result file says "failed" — the app then asks for App Management once.
 * Every step is logged to `logFile`; the outcome goes to `resultFile`. */
function installScript({ pid, appPath, stagedApp, relaunch, version = "", logFile = "/dev/null", resultFile = "/dev/null" }) {
	const prev = `${appPath}.previous`;
	// Out of /Applications, so a leftover never shows up as a second app.
	// Same volume as the temp dir on macOS, so the move is a rename.
	const aside = path.join(path.dirname(path.dirname(stagedApp)), "previous-version.app");
	const target = path.join(path.dirname(appPath), path.basename(stagedApp));
	const renamed = target !== appPath;
	const icon = (app) => `${app}/Contents/Resources/icon.icns`;
	const v = String(version).replace(/[^0-9A-Za-z.+-]/g, "");
	return [
		"#!/bin/sh",
		'PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"',
		`LOG=${q(logFile)}`,
		'say() { echo "$(date \'+%Y-%m-%d %H:%M:%S\') $*" >> "$LOG"; }',
		`result() { printf '{"version":"${v}","outcome":"%s"}\\n' "$1" > ${q(resultFile)}; say "result: $1"; }`,
		// Re-sign ad-hoc (the copy invalidated the old seal), clear quarantine, bump mtime.
		'finish() { xattr -cr "$1" 2>/dev/null; codesign --force --deep --sign - "$1" >>"$LOG" 2>&1 || say "codesign failed"; touch "$1"; }',
		`while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.3; done`,
		`say "installing ${v} into ${appPath.replace(/["$`\\]/g, "")}"`,
		`rm -rf ${q(prev)} ${q(aside)}`,
		"INPLACE=0",
		`if ditto ${q(appPath)} ${q(prev)} 2>>"$LOG"; then`,
		`  if rsync -a --delete ${q(stagedApp + "/")} ${q(appPath + "/")} 2>>"$LOG"; then INPLACE=1`,
		`  else say "in-place update refused"; rsync -a --delete ${q(prev + "/")} ${q(appPath + "/")} 2>/dev/null; fi`,
		"else",
		'  say "backup refused"',
		"fi",
		'if [ "$INPLACE" = 1 ]; then',
		renamed
			? `  if rm -rf ${q(target)} && mv ${q(appPath)} ${q(target)}; then APP=${q(target)}; killall Dock 2>/dev/null; else say "rename failed"; APP=${q(appPath)}; fi`
			: `  APP=${q(appPath)}; cmp -s ${q(icon(prev))} ${q(icon(appPath))} || killall Dock 2>/dev/null`,
		'  finish "$APP"',
		`  rm -rf ${q(prev)}`,
		"  result updated",
		"else",
		'  say "swapping the whole bundle"',
		`  rm -rf ${q(prev)}`,
		`  if mv ${q(appPath)} ${q(aside)} 2>>"$LOG"; then`,
		`    if { [ ${q(target)} = ${q(appPath)} ] || rm -rf ${q(target)}; } && mv ${q(stagedApp)} ${q(target)} 2>>"$LOG"; then`,
		`      APP=${q(target)}; finish "$APP"; rm -rf ${q(aside)}; killall Dock 2>/dev/null; result replaced`,
		"    else",
		`      mv ${q(aside)} ${q(appPath)}; APP=${q(appPath)}; result failed`,
		"    fi",
		"  else",
		`    APP=${q(appPath)}; result failed`,
		"  fi",
		"fi",
		relaunch ? 'open "$APP"' : ":",
		"",
	].join("\n");
}

async function download(url, dest, expectedSha512) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`);
	const hash = crypto.createHash("sha512");
	const out = fs.createWriteStream(dest);
	for await (const chunk of res.body) {
		hash.update(chunk);
		if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
	}
	await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
	const got = hash.digest("base64");
	if (expectedSha512 && got !== expectedSha512) throw new Error("download failed: sha512 mismatch");
}

function run(cmd, args) {
	return new Promise((resolve, reject) =>
		execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve(stdout))),
	);
}

/**
 * Download + stage an update described by electron-updater's UpdateInfo.
 * `releaseBase` is the release's download URL prefix (…/releases/download/vX.Y.Z/).
 * Resolves to { version, stagedApp }.
 */
async function downloadAndStage(info, { releaseBase, arch = process.arch, log = () => {} }) {
	const file = pickMacZip(info?.files, arch);
	if (!file) throw new Error(`no macOS ${arch} zip in the update feed`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-update-"));
	const zip = path.join(dir, "update.zip");
	const url = /^https?:/.test(file.url) ? file.url : releaseBase + encodeURIComponent(file.url);
	log(`mac self-update: downloading ${url}`);
	await download(url, zip, file.sha512);
	const staging = path.join(dir, "app");
	fs.mkdirSync(staging);
	await run("/usr/bin/ditto", ["-x", "-k", zip, staging]);
	fs.rmSync(zip, { force: true });
	const app = fs.readdirSync(staging).find((n) => n.endsWith(".app"));
	if (!app) throw new Error("update zip held no .app");
	log(`mac self-update: staged ${info.version}`);
	return { version: info.version, stagedApp: path.join(staging, app) };
}

/** Spawn the detached swap script; the caller then quits the app. */
function spawnInstaller({ stagedApp, appPath, relaunch, version, logFile, resultFile, log = () => {} }) {
	const script = path.join(path.dirname(path.dirname(stagedApp)), "install.sh");
	fs.writeFileSync(script, installScript({ pid: process.pid, appPath, stagedApp, relaunch, version, logFile, resultFile }), { mode: 0o755 });
	const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
	child.unref();
	log(`mac self-update: installer spawned (relaunch=${relaunch})`);
}

/** Is the app running from a quarantine copy macOS made (read-only)? */
function isTranslocated(appPath) {
	return /\/AppTranslocation\//.test(appPath);
}

/** Can the running bundle be replaced (its parent dir writable)? */
function canReplace(appPath) {
	if (isTranslocated(appPath)) return false;
	try {
		fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Read and remove the last install's outcome ({ version, outcome } or null). */
function takeInstallResult(resultFile) {
	try {
		const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
		fs.rmSync(resultFile, { force: true });
		return r && typeof r.outcome === "string" ? r : null;
	} catch {
		return null;
	}
}

module.exports = { pickMacZip, appBundlePath, installScript, downloadAndStage, spawnInstaller, canReplace, isTranslocated, takeInstallResult };
