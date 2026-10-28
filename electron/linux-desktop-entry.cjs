/**
 * LINUX LAUNCHER SYNC (2026-10-27). An AppImage has no installer, so the
 * app-menu entry (~/.local/share/applications/learnharness.desktop) and its
 * icon are plain files outside the AppImage — an update replaces the app but
 * not them. So every launch of a packaged AppImage rewrites both from the
 * running build: a rename or a new icon reaches the launcher on the first
 * start after the update, with no reinstall.
 *
 * Stable on purpose (the update-chain invariants, tests/update-chain.test.ts):
 * the file name learnharness.desktop, Icon=learnharness and
 * StartupWMClass=learnharness. Only Name, Comment and the icon's pixels follow
 * the build. Writes happen only when the content differs; every failure is
 * swallowed — the launcher must never stop the app from starting.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DESKTOP_ID = "learnharness";

/** Quote an Exec path per the Desktop Entry spec when it needs it. */
function execPath(p) {
	return /[\s"'\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p;
}

/** The .desktop text (pure — tested as text). */
function desktopEntryText({ name, comment, appImage }) {
	const exec = execPath(appImage);
	return [
		"[Desktop Entry]",
		"Type=Application",
		`Name=${name}`,
		`Comment=${comment}`,
		`Exec=${exec} %U`,
		`Icon=${DESKTOP_ID}`,
		"Terminal=false",
		"Categories=Education;",
		`StartupWMClass=${DESKTOP_ID}`,
		"Actions=Find;",
		"",
		"[Desktop Action Find]",
		"Name=Find Everything",
		`Exec=${exec} --find`,
		"",
	].join("\n");
}

function writeIfChanged(file, data) {
	try {
		if (fs.readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) return false;
	} catch {
		/* missing → write */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
	return true;
}

/** Bring the launcher entry + icon in line with the running build. */
function syncDesktopEntry({ home, appImage, name, comment, iconSource, log = () => {} }) {
	try {
		const entry = path.join(home, ".local", "share", "applications", `${DESKTOP_ID}.desktop`);
		const iconsRoot = path.join(home, ".local", "share", "icons", "hicolor");
		const icon = path.join(iconsRoot, "512x512", "apps", `${DESKTOP_ID}.png`);
		const entryChanged = writeIfChanged(entry, desktopEntryText({ name, comment, appImage }));
		let iconChanged = false;
		if (iconSource && fs.existsSync(iconSource)) iconChanged = writeIfChanged(icon, fs.readFileSync(iconSource));
		if (iconChanged) {
			// Nudge icon caches; missing tools are fine.
			try {
				fs.utimesSync(iconsRoot, new Date(), new Date());
			} catch {}
			execFile("gtk-update-icon-cache", ["-f", "-t", iconsRoot], () => {});
		}
		if (entryChanged) execFile("update-desktop-database", [path.dirname(entry)], () => {});
		if (entryChanged || iconChanged) log(`launcher synced (entry=${entryChanged}, icon=${iconChanged})`);
		return { entryChanged, iconChanged };
	} catch (err) {
		log(`launcher sync skipped: ${err?.message ?? err}`);
		return { entryChanged: false, iconChanged: false };
	}
}

module.exports = { DESKTOP_ID, desktopEntryText, syncDesktopEntry, execPath };
