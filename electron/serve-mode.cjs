/**
 * SERVE MODE (2026-10-27) — `Meander --serve`: the installed app runs ONLY
 * its server, with no window, so phones (and the desktop app itself) share
 * one Meander over Tailscale. One server per data folder is the rule: two
 * servers writing the same files at once can lose writes (the stores have
 * no cross-process locking), so the desktop app on the same machine
 * ATTACHES to a running serve instance instead of spawning its own.
 *
 *   - binds 127.0.0.1:<port> only; `tailscale serve` publishes it to the
 *     owner's tailnet (private to their devices — never the open internet);
 *   - writes <userData>/serve.json { url } so the desktop app can find it;
 *   - updates itself like the desktop app (the caller wires the updater),
 *     and exits when its AppImage file is replaced so systemd restarts it
 *     on the new version.
 *
 * Plain functions; electron/main.cjs owns the process wiring.
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_PORT = 8710;

function serveFile(userData) {
	return path.join(userData, "serve.json");
}

/** --port=N from argv (default 8710). */
function servePort(argv) {
	const arg = argv.find((a) => a.startsWith("--port="));
	const n = arg ? Number(arg.slice("--port=".length)) : DEFAULT_PORT;
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function writeServeUrl(userData, url) {
	fs.writeFileSync(serveFile(userData), JSON.stringify({ url, pid: process.pid, at: new Date().toISOString() }));
}

function clearServeUrl(userData) {
	try {
		const cur = JSON.parse(fs.readFileSync(serveFile(userData), "utf8"));
		if (cur.pid === process.pid) fs.rmSync(serveFile(userData), { force: true });
	} catch {
		/* nothing to clear */
	}
}

function readServeUrl(userData) {
	try {
		const { url } = JSON.parse(fs.readFileSync(serveFile(userData), "utf8"));
		return typeof url === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : null;
	} catch {
		return null;
	}
}

/** Does a Meander server answer at url within timeoutMs? */
function isUp(url, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const req = http.get(`${url}/manifest.webmanifest`, { timeout: timeoutMs }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve(res.statusCode === 200 && body.includes('"Meander"')));
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
	});
}

/** The serve instance to attach to, if one is running. */
async function attachableServer(userData) {
	const url = readServeUrl(userData);
	return url && (await isUp(url)) ? url : null;
}

/** Call onReplaced() once the file at `file` changes on disk (an update
 *  swapped the AppImage). Polls; returns a stop function. */
function watchReplaced(file, onReplaced, everyMs = 60_000) {
	const stamp = () => {
		try {
			const s = fs.statSync(file);
			return `${s.ino}:${s.mtimeMs}:${s.size}`;
		} catch {
			return null;
		}
	};
	const first = stamp();
	const t = setInterval(() => {
		const now = stamp();
		if (first && now && now !== first) {
			clearInterval(t);
			onReplaced();
		}
	}, everyMs);
	return () => clearInterval(t);
}

module.exports = { DEFAULT_PORT, serveFile, servePort, writeServeUrl, clearServeUrl, readServeUrl, isUp, attachableServer, watchReplaced };
