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
		assert.match(s, /ditto '\/Applications\/Meander.app' '\/Applications\/Meander.app.previous' \|\| exit 1/);
		assert.match(s, /rsync -a --delete '\/tmp\/u\/app\/Meander.app\/' '\/Applications\/Meander.app\/'/, "same directory: the Dock pin survives");
		assert.doesNotMatch(s, /mv '\/Applications\/Meander.app'/, "no rename when the name is unchanged");
		assert.match(s, /codesign --force --deep --sign - '\/Applications\/Meander.app'/);
		assert.match(s, /cmp -s .*icon.icns.* \|\| killall Dock/, "Dock refreshes only when the icon changed");
		assert.match(s, /rsync -a --delete '\/Applications\/Meander.app.previous\/' '\/Applications\/Meander.app\/'/, "rolls back if the update fails");
		assert.match(s, /open '\/Applications\/Meander.app'/);
		assert.doesNotMatch(mac.installScript({ pid: 1, appPath: "/A.app", stagedApp: "/B/A.app", relaunch: false }), /open /);
	});
	it("a renamed build renames the SAME bundle (Dock pin kept) and refreshes the Dock", () => {
		const s = mac.installScript({ pid: 7, appPath: "/Applications/LearnHarness.app", stagedApp: "/tmp/u/app/Meander.app", relaunch: true });
		assert.match(s, /rsync -a --delete '\/tmp\/u\/app\/Meander.app\/' '\/Applications\/LearnHarness.app\/'/);
		assert.match(s, /mv '\/Applications\/LearnHarness.app' '\/Applications\/Meander.app'/);
		assert.match(s, /^  killall Dock/m);
		assert.match(s, /open '\/Applications\/Meander.app'/);
	});
	it("quotes paths with spaces and quotes", () => {
		const s = mac.installScript({ pid: 1, appPath: "/Users/me/My Apps/It's.app", stagedApp: "/t/x.app", relaunch: false });
		assert.match(s, /'\/Users\/me\/My Apps\/It'\\''s.app'/);
	});
});
