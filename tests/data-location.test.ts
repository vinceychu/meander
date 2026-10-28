/**
 * DATA LOCATION + PRESENCE PINS (fork, 2026-10-26): the per-device folder
 * choice and the per-host heartbeat files (electron/data-location.cjs).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const loc = require("../electron/data-location.cjs") as {
	resolveDataDir(u: string): string;
	defaultDataDir(u: string): string;
	isCustomDataDir(u: string): boolean;
	writeDataDir(u: string, d: string | null): void;
	hasData(d: string): boolean;
	otherActiveDevices(d: string, now?: number): string[];
	startPresence(d: string): () => void;
	STALE_MS: number;
};

describe("data location", () => {
	it("defaults to userData/data, remembers a choice, resets", () => {
		const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ud-"));
		assert.equal(loc.resolveDataDir(userData), path.join(userData, "data"));
		assert.equal(loc.isCustomDataDir(userData), false);
		loc.writeDataDir(userData, "/sync/LearnHarness");
		assert.equal(loc.resolveDataDir(userData), "/sync/LearnHarness");
		assert.equal(loc.isCustomDataDir(userData), true);
		loc.writeDataDir(userData, null);
		assert.equal(loc.resolveDataDir(userData), path.join(userData, "data"));
	});
	it("ignores a relative or corrupt choice", () => {
		const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ud-"));
		fs.writeFileSync(path.join(userData, "data-location.json"), JSON.stringify({ dataDir: "relative/dir" }));
		assert.equal(loc.resolveDataDir(userData), path.join(userData, "data"));
	});
});

describe("presence", () => {
	it("sees fresh heartbeats from OTHER hosts only, and cleans its own up", () => {
		const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-"));
		const stop = loc.startPresence(data);
		assert.deepEqual(loc.otherActiveDevices(data), [], "own heartbeat is not 'another device'");
		const now = Date.now();
		fs.writeFileSync(path.join(data, ".devices", "macbook.json"), JSON.stringify({ host: "macbook", at: now }));
		fs.writeFileSync(path.join(data, ".devices", "old-pc.json"), JSON.stringify({ host: "old-pc", at: now - loc.STALE_MS - 1 }));
		assert.deepEqual(loc.otherActiveDevices(data, now), ["macbook"]);
		stop();
		assert.deepEqual(
			fs.readdirSync(path.join(data, ".devices")).sort(),
			["macbook.json", "old-pc.json"],
		);
	});
});

describe("mac self-update (fork, 2026-10-27)", async () => {
	const mac = (await import("../electron/mac-self-update.cjs")).default as typeof import("../electron/mac-self-update.cjs");
	it("picks the zip for this CPU", () => {
		const files = [
			{ url: "LearnHarness-0.3.9-mac.zip" },
			{ url: "LearnHarness-0.3.9-arm64-mac.zip" },
			{ url: "LearnHarness-0.3.9.dmg" },
		];
		assert.equal(mac.pickMacZip(files, "x64")?.url, "LearnHarness-0.3.9-mac.zip");
		assert.equal(mac.pickMacZip(files, "arm64")?.url, "LearnHarness-0.3.9-arm64-mac.zip");
		assert.equal(mac.pickMacZip([{ url: "x.dmg" }], "x64"), null);
	});
	it("finds the bundle from the executable path", () => {
		assert.equal(mac.appBundlePath("/Applications/LearnHarness.app/Contents/MacOS/LearnHarness"), "/Applications/LearnHarness.app");
		assert.equal(mac.appBundlePath("/usr/bin/node"), null);
	});
	it("updates in place, keeps a rollback copy, re-signs, relaunches only when asked", () => {
		const s = mac.installScript({ pid: 42, appPath: "/Applications/Meander.app", stagedApp: "/tmp/u/app/Meander.app", relaunch: true });
		assert.match(s, /while kill -0 42/);
		assert.match(s, /ditto '\/Applications\/Meander.app' '\/Applications\/Meander.app.previous'/);
		assert.match(s, /rsync -a --delete '\/tmp\/u\/app\/Meander.app\/' '\/Applications\/Meander.app\/'/, "same directory: the Dock pin survives");
		assert.doesNotMatch(s, /then\s+if rm -rf .* && mv '\/Applications\/Meander.app'/, "no rename when the name is unchanged");
		assert.match(s, /codesign --force --deep --sign - "\$1"/);
		assert.match(s, /cmp -s .*icon.icns.* \|\| killall Dock/, "Dock refreshes only when the icon changed");
		assert.match(s, /open "\$APP"/);
		assert.doesNotMatch(mac.installScript({ pid: 1, appPath: "/A.app", stagedApp: "/B/A.app", relaunch: false }), /open /);
	});
	it("a renamed build renames the SAME bundle (Dock pin kept) and refreshes the Dock", () => {
		const s = mac.installScript({ pid: 7, appPath: "/Applications/LearnHarness.app", stagedApp: "/tmp/u/app/Meander.app", relaunch: true });
		assert.match(s, /rsync -a --delete '\/tmp\/u\/app\/Meander.app\/' '\/Applications\/LearnHarness.app\/'/);
		assert.match(s, /mv '\/Applications\/LearnHarness.app' '\/Applications\/Meander.app'; then APP='\/Applications\/Meander.app'; killall Dock/);
	});
	it("spots a quarantine (translocated) copy, which can't update itself", () => {
		assert.equal(mac.isTranslocated("/private/var/folders/x/AppTranslocation/ABC/d/Meander.app"), true);
		assert.equal(mac.canReplace("/private/var/folders/x/AppTranslocation/ABC/d/Meander.app"), false);
		assert.equal(mac.isTranslocated("/Applications/Meander.app"), false);
	});
	it("quotes paths with spaces and quotes", () => {
		const s = mac.installScript({ pid: 1, appPath: "/Users/me/My Apps/It's.app", stagedApp: "/t/x.app", relaunch: false });
		assert.match(s, /'\/Users\/me\/My Apps\/It'\\''s.app'/);
	});
});

// Runs the real swap script against a fake /Applications, with the macOS-only
// tools (ditto, xattr, codesign, killall, open) stubbed. A read-only bundle
// stands in for macOS App Management refusing writes inside it.
describe("mac self-update script, run for real", { skip: process.platform === "win32" }, async () => {
	const mac = (await import("../electron/mac-self-update.cjs")).default as typeof import("../electron/mac-self-update.cjs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { execFileSync } = await import("node:child_process");

	function setup(oldName: string) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-macswap-"));
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		stub("ditto", 'cp -a "$1" "$2"');
		for (const t of ["xattr", "codesign", "killall"]) stub(t, `echo "${t} $*" >> "${root}/calls"`);
		stub("open", `echo "open $*" >> "${root}/calls"`);
		const apps = path.join(root, "Applications");
		const bundle = (dir: string, v: string) => {
			fs.mkdirSync(path.join(dir, "Contents", "Resources"), { recursive: true });
			fs.writeFileSync(path.join(dir, "Contents", "version"), v);
			fs.writeFileSync(path.join(dir, "Contents", "Resources", "icon.icns"), `icon-${v}`);
		};
		const appPath = path.join(apps, oldName);
		bundle(appPath, "old");
		const stagedApp = path.join(root, "tmp", "app", "Meander.app");
		bundle(stagedApp, "new-build"); // different size: rsync skips same-size, same-mtime files
		/** Make a tool refuse (exit 1) when its last argument matches `re`, as
		 *  App Management does with "Operation not permitted". */
		const refuse = (tool: string, re: string) =>
			stub(tool, `for a; do last="$a"; done\ncase "$last" in ${re}) echo "${tool}: Operation not permitted" >&2; exit 1;; esac\nexec /usr/bin/${tool} "$@"`);
		const run = () => {
			const script = mac.installScript({ pid: 999999, appPath, stagedApp, relaunch: true, version: "9.9.9", logFile: path.join(root, "log"), resultFile: path.join(root, "result.json") });
			fs.writeFileSync(path.join(root, "install.sh"), script);
			execFileSync("/bin/sh", [path.join(root, "install.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
			return {
				result: JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")),
				calls: fs.readFileSync(path.join(root, "calls"), "utf8"),
				apps: fs.readdirSync(apps).sort(),
				version: (name: string) => fs.readFileSync(path.join(apps, name, "Contents", "version"), "utf8"),
			};
		};
		return { root, appPath, apps, refuse, run };
	}

	it("normal update: in place, re-signed, relaunched, nothing left behind", () => {
		const { root, run } = setup("Meander.app");
		const r = run();
		assert.deepEqual(r.result, { version: "9.9.9", outcome: "updated" });
		assert.deepEqual(r.apps, ["Meander.app"]);
		assert.equal(r.version("Meander.app"), "new-build");
		assert.match(r.calls, /codesign --force --deep --sign - .*Applications\/Meander.app/);
		assert.match(r.calls, /killall Dock/, "icon changed → Dock refresh");
		assert.match(r.calls, /open .*Applications\/Meander.app/);
		fs.rmSync(root, { recursive: true, force: true });
	});
	it("writes inside the bundle refused: swaps whole bundles instead (and renames)", () => {
		const { root, apps, refuse, run } = setup("LearnHarness.app");
		refuse("rsync", `${apps}/LearnHarness.app/`);
		const r = run();
		assert.deepEqual(r.result, { version: "9.9.9", outcome: "replaced" });
		assert.deepEqual(r.apps, ["Meander.app"]);
		assert.equal(r.version("Meander.app"), "new-build");
		assert.match(r.calls, /open .*Applications\/Meander.app/);
		fs.rmSync(root, { recursive: true, force: true });
	});
	it("everything refused: the old app stays intact, is relaunched, and the result says failed", () => {
		const { root, apps, refuse, run } = setup("Meander.app");
		refuse("rsync", `${apps}/Meander.app/`);
		refuse("mv", "*previous-version.app");
		const r = run();
		assert.deepEqual(r.result, { version: "9.9.9", outcome: "failed" });
		assert.deepEqual(r.apps, ["Meander.app"]);
		assert.equal(r.version("Meander.app"), "old");
		assert.match(r.calls, /open .*Applications\/Meander.app/);
		assert.deepEqual(mac.takeInstallResult(path.join(root, "result.json")), { version: "9.9.9", outcome: "failed" });
		assert.equal(mac.takeInstallResult(path.join(root, "result.json")), null, "read once");
		fs.rmSync(root, { recursive: true, force: true });
	});
});
