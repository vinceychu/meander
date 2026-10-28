/**
 * UPDATE-CHAIN INVARIANTS (2026-10-27). Installed copies of Meander update
 * themselves forever only if these never change — renaming the app or
 * swapping its icon must touch NONE of them. If one of these fails, the
 * change would strand existing installs (lost data folder, lost sign-ins,
 * or an update feed they can't find). Display name, icon, version, copy:
 * all free to change.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { desktopEntryText, execPath, DESKTOP_ID } from "../electron/linux-desktop-entry.cjs";

const builder = fs.readFileSync("electron-builder.yml", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const main = fs.readFileSync("electron/main.cjs", "utf8");

describe("update-chain invariants", () => {
	it("app id stays (macOS ties preferences + microphone permission to it)", () => {
		assert.match(builder, /^appId: com\.learnharness\.LearnHarness$/m);
	});
	it("data folder name stays (sessions, graph, keys, sign-ins live there)", () => {
		assert.match(main, /const DATA_FOLDER_NAME = "LearnHarness";/);
		assert.match(main, /app\.setName\(DATA_FOLDER_NAME\);\napp\.setPath\("userData", app\.getPath\("userData"\)\);/);
	});
	it("package name + desktop id stay (Linux binary, window class, launcher file)", () => {
		assert.equal(pkg.name, "learnharness");
		assert.equal(pkg.desktopName, "learnharness.desktop");
		assert.equal(DESKTOP_ID, "learnharness");
	});
	it("the update feed is this repo, and the Mac self-updater downloads from the same place", () => {
		assert.match(builder, /^publish:[\s\S]*?- provider: github\n\s+owner: vinceychu\n\s+repo: meander$/m);
		assert.match(main, /const FORK_RELEASES = "https:\/\/github\.com\/vinceychu\/meander\/releases\/download\/";/);
	});
	it("the Linux build ships the icon the launcher sync installs", () => {
		assert.match(builder, /^linux:[\s\S]*?extraResources:\n\s+- from: build\/icon\.png\n\s+to: icon\.png$/m);
	});
	it("automatic updates stay on for packaged builds", () => {
		assert.match(main, /\n\tsetupAutoUpdater\(\);\n/);
	});
});

describe("Linux launcher entry", () => {
	it("follows the build's name but keeps the stable icon + window class", () => {
		const text = desktopEntryText({ name: "Meander", comment: "c", appImage: "/home/v/Applications/LearnHarness.AppImage" });
		assert.match(text, /^Name=Meander$/m);
		assert.match(text, /^Exec=\/home\/v\/Applications\/LearnHarness\.AppImage %U$/m);
		assert.match(text, /^Icon=learnharness$/m);
		assert.match(text, /^StartupWMClass=learnharness$/m);
		assert.match(text, /^Exec=\/home\/v\/Applications\/LearnHarness\.AppImage --find$/m);
	});
	it("quotes paths with spaces", () => {
		assert.equal(execPath("/home/v/My Apps/x.AppImage"), '"/home/v/My Apps/x.AppImage"');
	});
});

describe("launcher sync writes only on change", async () => {
	const os = await import("node:os");
	const path = await import("node:path");
	const { syncDesktopEntry } = await import("../electron/linux-desktop-entry.cjs");
	it("writes entry + icon once, then nothing until they differ", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-home-"));
		const icon = path.join(home, "src.png");
		fs.writeFileSync(icon, "png-v1");
		const args = { home, appImage: "/a/Meander.AppImage", name: "Meander", comment: "c", iconSource: icon };
		assert.deepEqual(syncDesktopEntry(args), { entryChanged: true, iconChanged: true });
		assert.deepEqual(syncDesktopEntry(args), { entryChanged: false, iconChanged: false });
		fs.writeFileSync(icon, "png-v2");
		assert.deepEqual(syncDesktopEntry({ ...args, name: "Renamed" }), { entryChanged: true, iconChanged: true });
		assert.match(fs.readFileSync(path.join(home, ".local/share/applications/learnharness.desktop"), "utf8"), /^Name=Renamed$/m);
		assert.equal(fs.readFileSync(path.join(home, ".local/share/icons/hicolor/512x512/apps/learnharness.png"), "utf8"), "png-v2");
	});
});
