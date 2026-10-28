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

/** The swap script (pure — tested as text).
 *
 * Updates the bundle IN PLACE (rsync into the same directory) and, if the
 * new build has a different name, renames that same directory. The Dock
 * remembers apps by their file identity, so an in-place update + rename
 * keeps the Dock pin; replacing the bundle with a new copy would leave a
 * "?" in the Dock. A name or icon change also restarts the Dock once so it
 * redraws (macOS caches both). A full copy of the old bundle is kept as
 * <name>.app.previous until the update succeeds, and restored if it fails. */
function installScript({ pid, appPath, stagedApp, relaunch }) {
	const prev = `${appPath}.previous`;
	const target = path.join(path.dirname(appPath), path.basename(stagedApp));
	const renamed = target !== appPath;
	const icon = (app) => `${app}/Contents/Resources/icon.icns`;
	return [
		"#!/bin/sh",
		`while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.3; done`,
		`rm -rf ${q(prev)}`,
		`ditto ${q(appPath)} ${q(prev)} || exit 1`,
		`if rsync -a --delete ${q(stagedApp + "/")} ${q(appPath + "/")}; then`,
		renamed ? `  rm -rf ${q(target)} && mv ${q(appPath)} ${q(target)}` : "  :",
		`  xattr -cr ${q(target)} 2>/dev/null`,
		`  codesign --force --deep --sign - ${q(target)} 2>/dev/null`,
		`  touch ${q(target)}`,
		renamed
			? "  killall Dock 2>/dev/null"
			: `  cmp -s ${q(icon(prev))} ${q(icon(target))} || killall Dock 2>/dev/null`,
		`  rm -rf ${q(prev)}`,
		"else",
		`  rsync -a --delete ${q(prev + "/")} ${q(appPath + "/")} && rm -rf ${q(prev)}`,
		"fi",
		relaunch ? `if [ -d ${q(target)} ]; then open ${q(target)}; else open ${q(appPath)}; fi` : ":",
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
function spawnInstaller({ stagedApp, appPath, relaunch, log = () => {} }) {
	const script = path.join(path.dirname(stagedApp), "install.sh");
	fs.writeFileSync(script, installScript({ pid: process.pid, appPath, stagedApp, relaunch }), { mode: 0o755 });
	const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
	child.unref();
	log(`mac self-update: installer spawned (relaunch=${relaunch})`);
}

/** Can the running bundle be replaced (its parent dir writable)? */
function canReplace(appPath) {
	try {
		fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

module.exports = { pickMacZip, appBundlePath, installScript, downloadAndStage, spawnInstaller, canReplace };
