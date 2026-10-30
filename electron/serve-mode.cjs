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

// ─── Shared brain over Tailscale (2026-10-28) ──────────────────────────────
// A desktop app with no server of its own on this machine looks for one on
// the owner's tailnet (e.g. the PC that runs `--serve`) and uses it, so the
// Mac, the phone and the PC share one Meander: same notes, chats and tools,
// with the tools running on the machine that has the GPU / lab cluster.
// The tailnet is private to the owner's devices and encrypted end to end.
// The last server found is remembered and tried first; when none answers
// (offline, Tailscale off), the app runs its own local server as before.

const TAILSCALE_CLIS = [
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	"/usr/local/bin/tailscale",
	"/opt/homebrew/bin/tailscale",
	"/usr/bin/tailscale",
];

function brainFile(userData) {
	return path.join(userData, "brain.json");
}

/** Only tailnet MagicDNS hosts over http (no path): what tailscale serve publishes. */
function isTailnetUrl(url) {
	return typeof url === "string" && /^http:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(url);
}

function rememberedBrain(userData) {
	try {
		const { url } = JSON.parse(fs.readFileSync(brainFile(userData), "utf8"));
		return isTailnetUrl(url) ? url : null;
	} catch {
		return null;
	}
}

function rememberBrain(userData, url) {
	try {
		fs.writeFileSync(brainFile(userData), JSON.stringify({ url, at: new Date().toISOString() }));
	} catch {
		/* best effort */
	}
}

/** Online tailnet peers as http://<magicdns-name> URLs (pure — tested). */
function peerUrls(status) {
	return Object.values(status?.Peer ?? {})
		.filter((p) => p?.Online && typeof p.DNSName === "string" && p.DNSName)
		.map((p) => `http://${p.DNSName.replace(/\.$/, "")}`)
		.filter(isTailnetUrl);
}

function tailscaleStatus(execFile, cli = TAILSCALE_CLIS.find((c) => fs.existsSync(c))) {
	if (!cli) return Promise.resolve(null);
	return new Promise((resolve) =>
		execFile(cli, ["status", "--json"], { timeout: 4000 }, (err, stdout) => {
			try {
				resolve(err ? null : JSON.parse(stdout));
			} catch {
				resolve(null);
			}
		}),
	);
}

/** The shared Meander server on the tailnet, or null.
 * @param {string} userData
 * @param {{ execFile?: Function, cli?: string, probe?: (url: string, timeoutMs?: number) => Promise<boolean>, log?: (m: string) => void }} [opts]
 * @returns {Promise<string | null>} */
async function findTailnetBrain(userData, { execFile = require("node:child_process").execFile, cli, probe = isUp, log = () => {} } = {}) {
	const known = rememberedBrain(userData);
	if (known && (await probe(known, 2500))) return known;
	const status = await tailscaleStatus(execFile, cli);
	const urls = peerUrls(status).filter((u) => u !== known);
	if (urls.length === 0) return null;
	const found = await new Promise((resolve) => {
		let left = urls.length;
		for (const u of urls)
			void probe(u, 2500).then((ok) => {
				if (ok) resolve(u);
				else if (--left === 0) resolve(null);
			});
	});
	if (found) {
		log(`shared brain found on the tailnet: ${found}`);
		rememberBrain(userData, found);
	}
	return found;
}

/** Keys typed into this device before it used the shared brain live in
 *  its own auth.json; copy any the brain lacks so they never "vanish".
 *  The brain's own keys always win (never overwritten). */
async function shareLocalKeys(brainUrl, authFile, { fetch = globalThis.fetch, log = () => {} } = {}) {
	let local;
	try {
		local = JSON.parse(fs.readFileSync(authFile, "utf-8"));
	} catch {
		return [];
	}
	if (!local || typeof local !== "object") return [];
	const res = await fetch(`${brainUrl}/api/keys`);
	if (!res.ok) return [];
	const present = new Set(((await res.json()).keys ?? []).filter((k) => k.present).map((k) => k.id));
	const shared = [];
	for (const [id, value] of Object.entries(local)) {
		if (typeof value !== "string" || present.has(id)) continue;
		const put = await fetch(`${brainUrl}/api/keys/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (put.ok) shared.push(id);
	}
	if (shared.length) log(`shared brain: added this device's keys ${shared.join(", ")}`);
	return shared;
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

module.exports = { isTailnetUrl, peerUrls, rememberedBrain, rememberBrain, findTailnetBrain, shareLocalKeys, DEFAULT_PORT, serveFile, servePort, writeServeUrl, clearServeUrl, readServeUrl, isUp, attachableServer, watchReplaced };
