/**
 * DATA LOCATION + MULTI-DEVICE PRESENCE (fork, 2026-10-26).
 *
 * Sync across devices = point every device's data folder at the same
 * synced folder (Syncthing, Dropbox, iCloud Drive, OneDrive, Google
 * Drive…). The app already keeps every record under ONE folder (the
 * LH_DATA_DIR seam, config.ts); this module only remembers WHICH folder,
 * in userData/data-location.json — a per-device file that never syncs.
 *
 * API keys stay per device (userData/auth.json): secrets never travel
 * through a sync service.
 *
 * Presence: plain-file sync has no locking, and two devices writing the
 * same session at the same moment produce sync conflicts. Each device
 * writes ITS OWN heartbeat file (.devices/<hostname>.json — one writer per
 * file, so the heartbeats themselves can never conflict); at startup a
 * fresh heartbeat from another host means "open elsewhere" → warn.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCATION_FILE = "data-location.json";
const HEARTBEAT_MS = 60_000;
/** A heartbeat older than this is a device that quit without cleanup. */
const STALE_MS = 3 * HEARTBEAT_MS;

function locationFile(userData) {
	return path.join(userData, LOCATION_FILE);
}

function defaultDataDir(userData) {
	return path.join(userData, "data");
}

/** The data folder this device uses: the chosen one, else the default. */
function resolveDataDir(userData) {
	try {
		const { dataDir } = JSON.parse(fs.readFileSync(locationFile(userData), "utf-8"));
		if (typeof dataDir === "string" && path.isAbsolute(dataDir)) return dataDir;
	} catch {
		/* absent or unreadable → default */
	}
	return defaultDataDir(userData);
}

function isCustomDataDir(userData) {
	return resolveDataDir(userData) !== defaultDataDir(userData);
}

function writeDataDir(userData, dataDir) {
	if (dataDir === null) {
		fs.rmSync(locationFile(userData), { force: true });
		return;
	}
	fs.writeFileSync(locationFile(userData), JSON.stringify({ dataDir }, null, 2));
}

/** Does a folder already hold LearnHarness data? */
function hasData(dir) {
	return ["chats", "graph", "settings.json"].some((f) => fs.existsSync(path.join(dir, f)));
}

// ─── Presence ───────────────────────────────────────────────────────────────

function hostId() {
	return os.hostname().replace(/[^\w.-]/g, "_") || "device";
}

function devicesDir(dataDir) {
	return path.join(dataDir, ".devices");
}

/** Other devices whose heartbeat is fresh — "open elsewhere right now". */
function otherActiveDevices(dataDir, now = Date.now()) {
	const out = [];
	let files = [];
	try {
		files = fs.readdirSync(devicesDir(dataDir)).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const f of files) {
		if (f === `${hostId()}.json`) continue;
		try {
			const beat = JSON.parse(fs.readFileSync(path.join(devicesDir(dataDir), f), "utf-8"));
			if (typeof beat.at === "number" && now - beat.at < STALE_MS) out.push(beat.host ?? f.replace(/\.json$/, ""));
		} catch {
			/* half-synced file — ignore */
		}
	}
	return out;
}

/** Start this device's heartbeat; returns a stop() that removes the file. */
function startPresence(dataDir) {
	const file = path.join(devicesDir(dataDir), `${hostId()}.json`);
	const beat = () => {
		try {
			fs.mkdirSync(devicesDir(dataDir), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), platform: process.platform, pid: process.pid, at: Date.now() }));
		} catch {
			/* a read-only or vanished folder must never crash the app */
		}
	};
	beat();
	const timer = setInterval(beat, HEARTBEAT_MS);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		fs.rmSync(file, { force: true });
	};
}

module.exports = {
	resolveDataDir,
	defaultDataDir,
	isCustomDataDir,
	writeDataDir,
	hasData,
	otherActiveDevices,
	startPresence,
	STALE_MS,
};
