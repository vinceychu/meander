/**
 * Meander (fork of LearnHarness) — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the LH_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600 — server-managed since
 *     the auth-keys wave (2026-09-19): the child reads/writes it DIRECTLY
 *     (LH_AUTH_FILE below) and reflects values into its own env. The old
 *     spawn-time env injection retired with that wave — a copy made here
 *     would shadow every settings-page key change until restart.
 */

const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, nativeImage, session, shell } = require("electron");
const dataLocation = require("./data-location.cjs");
const macSelfUpdate = require("./mac-self-update.cjs");
const linuxDesktopEntry = require("./linux-desktop-entry.cjs");
const serveMode = require("./serve-mode.cjs");
const { createChatGPT, fileStore } = require("./chatgpt.cjs");
const { attachChatGPTChild, trustedSender, chatGPTControl } = require("./chatgpt-ipc.cjs");
const { createSubscriptions, loadSubscriptionSDK } = require("./subscriptions.cjs");
const { attachSubscriptionChild, subscriptionControl } = require("./subscription-ipc.cjs");
const { desktopAPIHeaders } = require("./desktop-api.cjs");
const { openWebSubscriptionBrowser } = require("./web-subscription-browser.cjs");
const { randomBytes } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "Meander";
// FORK (2026-10-27): renamed to Meander, but the data folder keeps its
// LearnHarness name — existing sessions, graph, keys and settings stay put.
const DATA_FOLDER_NAME = "LearnHarness";

// APP NAME → userData (owner, 2026-10-10): the Application Support dir is
// exactly "LearnHarness" in dev AND packaged. Packaged Electron would
// otherwise derive it from package.json "name" (now lowercase
// "learnharness"), and productName metadata alone doesn't reach app.name.
// Must run before the LH_DEV_URL suffix below — dev becomes
// "LearnHarness-dev".
app.setName(DATA_FOLDER_NAME);
app.setPath("userData", app.getPath("userData")); // pin the folder before renaming
app.setName(PRODUCT_NAME);
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
// Fork (2026-10-26): the data folder is CHOOSABLE (File → Choose Data
// Folder…) so a synced folder can carry everything across devices —
// electron/data-location.cjs. Default stays userData/data.
const DATA_DIR = () => dataLocation.resolveDataDir(app.getPath("userData"));

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev LH_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// ─── Browser-service helper (Wave E stage 3, owner 2026-10-10) ────────
// The render engines for agent jobs: PDFs and SVGs rasterize natively
// (pdfjs+Skia, resvg — no browser); DEMOS execute JS and need one. The
// app's own Chromium serves that via this helper — the server spawns
//   <this binary> --browser-service
// and connects over CDP (system Chrome stays the fallback). Handshake:
// the helper prints "BROWSER_SERVICE_CDP <port>" on stdout once the CDP
// endpoint listens. Lifetime: parent IPC disconnect/death = quit.
// MUST run before the single-instance lock — a helper is a second
// instance of this very binary, and before the LH_DEV_URL redirect — the
// helper owns no user data at all.
if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	// Own the helper's entire startup lifetime, including the readiness wait.
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF. Use the
			// real Node IPC channel, and refuse to start an unowned helper.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			// A hidden window keeps the app lifecycle ordinary on every
			// platform (no window-all-closed handler is installed here).
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier. Confirm the
			// endpoint before both production and smoke clients see the handshake.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return; // Parent disconnect is normal.
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	// Dev shell (LH_DEV_URL) runs BESIDE the packaged app, not instead of it:
	// its own userData so (a) the single-instance lock — checked below — doesn't
	// silently kill it, and (b) it never reads/writes the real app's
	// localStorage, auth.json, or logs. Must run before the lock check.
	if (process.env.LH_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	// The whole normal boot — lock included — lives in this else: a helper is
	// a SECOND instance of this very binary on purpose (the running app owns
	// the lock), so it must never reach this check.
	// `--serve` (2026-10-27): server only, no window, no single-instance
	// lock — it runs beside the desktop app, which then attaches to it.
	if (process.argv.includes("--serve")) {
		void serveMain();
	} else if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on("second-instance", (_event, argv) => {
			// `learnharness --find` (a desktop-environment shortcut) opens
			// Find Everything in the running instance (fork, 2026-10-26).
			if (argv.includes("--find")) {
				openFindEverything();
				return;
			}
			const win = BrowserWindow.getAllWindows()[0];
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		});
		main();
	}
}

let serverProcess = null;
let chatgpt = null;
let chatgptChild = null;
let subscriptions = null;
let subscriptionChild = null;
// Per-launch request capability, never OAuth tokens and never renderer state.
let desktopAPISecret = null;
// The --serve instance this window attached to (then: no own server child).
let attachedServer = null;
let reopenWindow = null;
const trustedAppWindows = new Set();

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race
// in an event handler): the window + child server are the product, and
// anything main-side is recoverable by logging it. Log-and-continue.
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600 —
 *  SERVER-MANAGED since the auth-keys wave (2026-09-19). This shell no
 *  longer reads or injects it: the child gets LH_AUTH_FILE below and does
 *  its own read/reflect/write, so a key saved in the settings page takes
 *  effect on the next model call — no restart. Real environment variables
 *  still win over the file inside the child (its documented rule). */

function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded (EPIPE hardening, 2026-10-10): a packaged
	// app launched with a consumer-owned pipe (a launcher that exits, a
	// piped run) must not die on its next log line when the pipe breaks.
	// The file below stays the durable channel.
	try {
		console.log(`[lh ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

/** desktop:false = the --serve instance: no per-launch desktop secret (the
 *  phone's browser can't hold one); it binds 127.0.0.1 and only reaches
 *  the owner's devices through `tailscale serve`. */
function startServer(port, { desktop = true } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Only the macOS backend needs this: Next's native title setter
			// otherwise checks this Node-mode process in as a foreground app.
			process.platform === "darwin"
				? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
				: [serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					LH_DATA_DIR: DATA_DIR(),
					// The auth/keys store — the child reads AND writes this file itself
					// (no env injection anymore: a spawn-time copy would shadow every
					// settings-page key change until restart; env wins over file).
					LH_AUTH_FILE: AUTH_FILE(),
					...(desktop ? { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: desktopAPISecret } : {}),
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		serverProcess = child;
		chatgptChild = attachChatGPTChild(child, chatgpt);
		subscriptionChild = attachSubscriptionChild(child, subscriptions);
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
			chatgptChild?.dispose();
			chatgptChild = null;
			subscriptionChild?.dispose();
			subscriptionChild = null;
			chatgpt?.close();
			subscriptions?.close();
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	chatgpt?.close();
	subscriptions?.close();
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's LH wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/sidebar.tsx.
		// Dragging comes from the renderer's .lh-drag bands (app/globals.css).
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default
				// height. Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				// The renderer reserves the actual width via env(titlebar-area-*).
				titleBarOverlay: { color: "#141414", symbolColor: "#e5e5e5" },
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			...(process.env.LH_DEV_URL || attachedServer ? { additionalArguments: ["--lh-web-subscriptions"] } : {}),
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The app background (#141414) fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: "#141414",
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "lh:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	trustedAppWindows.add(win);
	win.once("closed", () => trustedAppWindows.delete(win));
	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and
	// clipboard-sanitized-write — the copy affordances in the transcript
	// (md-blocks copy corners) call navigator.clipboard.writeText(), which
	// Chromium only honors with that permission (chrome-melt tweaks wave,
	// 2026-09-19; before this grant every copy silently rejected). Still
	// loopback-origin only — Electron's default is auto-approve-everything,
	// and we do not ship that.
	// "local-fonts": the appearance section's reading-font picker (2026-09-26).
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the
	// renderer's --lh-zoom must never go stale. The fallback catcher below
	// covers ⌘= / layout variants the menu's ⌘Plus may not claim — menu-
	// claimed keys never reach before-input-event, so exactly one of the
	// two applies any given zoom keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("lh:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* ── Zoom (owner round 7, 2026-10-05): ⌘±/⌘0 as an OWNED ladder ──────────
 * The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer
 * never learns the factor, and the native traffic lights (physical-fixed,
 * hiddenInset) drift out of relation to the scaled chrome: the graph
 * button rides away from them zoomed in, content slides under them
 * zoomed out. Here zoom is explicit: a factor ladder, applied through
 * setZoomFactor, and broadcast to the renderer ("lh:zoom" — it publishes
 * --lh-zoom so gutter lengths can divide by it and stay PHYSICAL-
 * constant). The traffic lights themselves stay at their construction
 * position ({x:16, y:22.5} — Electron 44 has NO runtime setter, only
 * the BrowserWindow option), which is HIG-correct anyway: native lights
 * hug the window corner while the web chrome compensates around them.
 * Vertical note: at large factors the taller bands' content centers
 * drift below the fixed lights — accepted (the alternative, moving the
 * lights, is impossible without rebuilding the window). */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update (Wave C, owner 2026-10-10: silent download + restart ─────
 * banner; checks at startup + every 24h) ─────────────────────────────────
 *
 * Feed: GitHub Releases (electron-builder.yml publish → app-update.yml,
 * baked + signed into the bundle). macOS needs the app signed (it is —
 * Developer ID) and updates ride the zip target (Squirrel.Mac); blockmaps
 * give differential downloads for free. Windows uses NSIS; Linux uses
 * AppImage or DebUpdater (6.8.9 supports deb; installation can request
 * administrator permission via the package manager — owner 2026-10-11).
 *
 * Hard rules:
 *  - DEV NEVER UPDATES: !app.isPackaged skips the updater entirely — the
 *    dev world runs `next dev` and has no signed bundle.
 *  - THE UPDATER CAN NEVER TAKE THE APP DOWN: every event and check is
 *    caught and logged (feed down, disk full, bad signature — all just
 *    log lines; the app keeps working, update or no update).
 *  - LH_UPDATE_FEED (env): overrides the baked GitHub feed with a generic
 *    local server — the pre-release verification drill (serve
 *    latest-mac.yml + zip + blockmap from any localhost HTTP dir and
 *    watch a real installed copy find/download/restart). Test-only seam.
 *
 * Install path: the downloaded update applies on quit (autoInstallOnAppQuit
 * — Squirrel.Mac stages natively and swaps on relaunch). The renderer
 * banner asks for an immediate restart via "lh:update-install"; we kill
 * the child server FIRST — deterministic ordering: the server lives
 * inside the .app bundle Squirrel is about to replace (extraResources),
 * and before-quit alone would race the swap. */
// Every 4 hours (2026-10-27; was 24h): a published fix reaches open apps the same day.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let autoUpdater = null; // electron-updater's, packaged builds only
// Observational only: this snapshot NEVER gates a check, download or install.
// The revision lets late subscribers reject an older in-flight IPC snapshot.
let updateState = { status: "idle", version: null, revision: 0 };

function reportUpdateStatus(status, version = null) {
	try {
		// A later check/error must not hide an update already staged for quit.
		if (updateState.status === "downloaded" && status !== "downloaded") return;
		updateState = { status, version: typeof version === "string" ? version : null, revision: updateState.revision + 1 };
		for (const win of BrowserWindow.getAllWindows()) {
			try {
				win.webContents.send("lh:update-status", updateState);
			} catch {
				/* window mid-teardown — snapshot retrieval covers a later load */
			}
		}
	} catch {
		/* Status reporting must never interrupt the updater. */
	}
}

/** Read the SAME data directory passed to the packaged server. Only an
 * explicit false opts out; absent/corrupt/unreadable settings keep updates ON.
 * Re-read for each automatic check so saving the toggle needs no restart. */
function automaticUpdatesEnabled() {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
		return settings?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater) return;
	if (!manual && !automaticUpdatesEnabled()) {
		log("auto-update: automatic check skipped (turned off in Settings)");
		return;
	}
	// Do not gate on display state: a stale spinner/error must never disable
	// future background checks. electron-updater owns its in-flight work.
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// A declined check (e.g. an unsupported package) establishes no
			// latest-version claim. Real results arrive through updater events.
			if (!result) reportUpdateStatus("idle");
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			reportUpdateStatus("error");
		});
}

function installUpdateNow() {
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	if (macStaged) {
		installMacUpdate(true);
		app.quit();
		return;
	}
	autoUpdater?.quitAndInstall();
}

// ─── Fork: macOS self-update (electron/mac-self-update.cjs) ───────────────
const FORK_RELEASES = "https://github.com/vinceychu/meander/releases/download/";
let macStaged = null; // { version, stagedApp } once a download is unpacked
let macStaging = false;

async function stageMacUpdate(info) {
	if (macStaging || macStaged?.version === info?.version) return;
	const appPath = macSelfUpdate.appBundlePath(process.execPath);
	if (!appPath || !macSelfUpdate.canReplace(appPath)) {
		log(`mac self-update: can't replace ${appPath ?? process.execPath} — install the new version by hand`);
		reportUpdateStatus("error");
		if (appPath && macSelfUpdate.isTranslocated(appPath)) void askToMoveToApplications();
		return;
	}
	macStaging = true;
	try {
		macStaged = await macSelfUpdate.downloadAndStage(info, { releaseBase: `${FORK_RELEASES}v${info.version}/`, log });
		reportUpdateStatus("downloaded", macStaged.version);
	} catch (err) {
		log(`mac self-update failed: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	} finally {
		macStaging = false;
	}
}

/** Hand the staged bundle to the swap script (runs after this process exits). */
function installMacUpdate(relaunch) {
	if (!macStaged) return;
	const appPath = macSelfUpdate.appBundlePath(process.execPath);
	if (appPath) {
		const logs = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(logs, { recursive: true });
		macSelfUpdate.spawnInstaller({
			stagedApp: macStaged.stagedApp,
			appPath,
			relaunch,
			version: macStaged.version,
			logFile: path.join(logs, "mac-update.log"),
			resultFile: MAC_UPDATE_RESULT(),
			log,
		});
	}
	macStaged = null;
}

const MAC_UPDATE_RESULT = () => path.join(app.getPath("userData"), "mac-update-result.json");
const APP_MANAGEMENT_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles";

/** At launch: how did the last self-update go? If macOS refused it (App
 *  Management, macOS 13+), ask once for the permission; the next check
 *  downloads and installs again. */
async function reportLastMacUpdate() {
	const r = macSelfUpdate.takeInstallResult(MAC_UPDATE_RESULT());
	if (!r) return;
	log(`mac self-update: last install of ${r.version || "?"} — ${r.outcome}`);
	if (r.outcome !== "failed") return;
	const { response } = await dialog.showMessageBox({
		type: "info",
		message: "Meander needs your OK once to update itself",
		detail:
			"macOS blocked the update. In System Settings → Privacy & Security → App Management, turn on Meander, then quit and reopen Meander. Updates install by themselves after that.",
		buttons: ["Open Settings", "Later"],
		defaultId: 0,
		cancelId: 1,
	});
	if (response === 0) void shell.openExternal(APP_MANAGEMENT_PANE);
}

/** macOS runs a downloaded app from a read-only copy until it is moved. */
async function askToMoveToApplications() {
	if (askToMoveToApplications.asked) return;
	askToMoveToApplications.asked = true;
	await dialog.showMessageBox({
		type: "info",
		message: "Move Meander to your Applications folder",
		detail: "Meander can only update itself from Applications. Quit Meander, drag it into Applications in Finder, and open it from there.",
		buttons: ["OK"],
	});
}

function setupAutoUpdater() {
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		reportUpdateStatus("disabled");
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		reportUpdateStatus("disabled");
		return;
	}
	const feed = process.env.LH_UPDATE_FEED;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: LH_UPDATE_FEED override → ${feed}`);
	}
	// FORK (2026-10-27): the fork's Mac builds are ad-hoc signed, which
	// Squirrel.Mac refuses to install — on macOS electron-updater only
	// checks, and mac-self-update.cjs downloads, stages and swaps.
	// LH_SQUIRREL_MAC=1 restores Squirrel for a Developer-ID-signed build.
	const macSelf = process.platform === "darwin" && !process.env.LH_SQUIRREL_MAC;
	autoUpdater.autoDownload = !macSelf;
	autoUpdater.autoInstallOnAppQuit = !macSelf;
	// Route every updater log line through the shell's own log (userData/
	// logs/main.log) — feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("checking-for-update", () => reportUpdateStatus("checking"));
	autoUpdater.on("update-available", (info) => {
		reportUpdateStatus("downloading", info?.version);
		if (macSelf) void stageMacUpdate(info);
	});
	autoUpdater.on("update-not-available", () => reportUpdateStatus("up-to-date"));
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		reportUpdateStatus("downloaded", info?.version);
	});
	autoUpdater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	});
}

/** One result surface for manual checks. Preload buffers the navigation
 * request until React subscribes, including when all macOS windows closed. */
function checkForUpdatesFromMenu() {
	try {
		const win = BrowserWindow.getAllWindows()[0] ?? reopenWindow?.();
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
			const openSettings = () => {
				try { win.webContents.send("lh:open-settings", "general"); } catch { /* window closed */ }
			};
			if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", openSettings);
			else openSettings();
		}
	} catch {
		/* Navigation failure must not prevent the manual check. */
	}
	checkForUpdates({ manual: true });
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	win.webContents.send("lh:zoom", factor);
}

// ─── Fork additions (2026-10-26): find-everything hotkey + data folder ────

/** Raise the window and open the Find Everything palette (the renderer
 *  listens for lh:kbd-find-everything — components/find-everything.tsx). */
function openFindEverything() {
	fireInRenderer("lh:kbd-find-everything");
}

/** Raise the window and dispatch a window event in the renderer (once loaded). */
function fireInRenderer(event, detail) {
	if (BrowserWindow.getAllWindows().length === 0) reopenWindow?.();
	const win = BrowserWindow.getAllWindows()[0];
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	const js = `window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, { detail: ${JSON.stringify(detail ?? null)} }))`;
	const fire = () => void win.webContents.executeJavaScript(js).catch(() => {});
	if (win.webContents.isLoading()) win.webContents.once("did-finish-load", fire);
	else fire();
}

/** File → Learn a Folder… (fork, 2026-10-27): pick a folder, then the
 *  palette offers a lesson over it or importing its notes into the graph. */
async function learnFolder() {
	const win = BrowserWindow.getAllWindows()[0];
	const picked = await dialog.showOpenDialog(win, { title: "Learn a Folder", properties: ["openDirectory"] });
	if (!picked.canceled && picked.filePaths[0]) fireInRenderer("lh:learn-folder", picked.filePaths[0]);
}

/** Open an app route (or download an API file) on the running server. */
function appUrl(route) {
	const win = BrowserWindow.getAllWindows()[0];
	const current = win?.webContents.getURL();
	if (!win || !current || !/^https?:/.test(current)) return null;
	return { win, url: new URL(route, current).href };
}

/** System-wide: Ctrl/Cmd+Shift+Space opens Find Everything from anywhere
 *  on the desktop. (On Linux/Wayland some compositors block global keys —
 *  bind a desktop shortcut to `learnharness --find` instead.) */
function registerGlobalFind() {
	const ok = globalShortcut.register("CommandOrControl+Shift+Space", openFindEverything);
	log(ok ? "global shortcut: CommandOrControl+Shift+Space" : "global shortcut unavailable (taken or unsupported)");
}

function relaunch() {
	app.relaunch();
	app.exit(0);
}

async function chooseDataFolder() {
	const userData = app.getPath("userData");
	const current = DATA_DIR();
	const picked = await dialog.showOpenDialog({
		title: "Choose Data Folder",
		message: "Pick a folder inside Syncthing, Dropbox, iCloud Drive, OneDrive or Google Drive to share your learning across devices.",
		properties: ["openDirectory", "createDirectory"],
	});
	if (picked.canceled || !picked.filePaths[0]) return;
	const target = picked.filePaths[0];
	if (path.resolve(target) === path.resolve(current)) return;
	if (dataLocation.hasData(target)) {
		const { response } = await dialog.showMessageBox({
			type: "question",
			buttons: ["Use It", "Cancel"],
			defaultId: 0,
			message: "This folder already holds Meander data.",
			detail: `Probably synced from another device. Meander will switch to it and restart. Your current data stays where it is:\n${current}`,
		});
		if (response !== 0) return;
	} else if (dataLocation.hasData(current)) {
		const { response } = await dialog.showMessageBox({
			type: "question",
			buttons: ["Copy and Switch", "Switch Without Copying", "Cancel"],
			defaultId: 0,
			cancelId: 2,
			message: "Copy your current data into the new folder?",
			detail: `From ${current}\nto ${target}\n\nThe original is left untouched as a backup.`,
		});
		if (response === 2) return;
		if (response === 0) {
			try {
				fs.cpSync(current, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}.devices`) });
			} catch (err) {
				dialog.showErrorBox("Copy failed", String(err));
				return;
			}
		}
	}
	dataLocation.writeDataDir(userData, target);
	relaunch();
}

async function useDefaultDataFolder() {
	const { response } = await dialog.showMessageBox({
		type: "question",
		buttons: ["Switch and Restart", "Cancel"],
		message: "Use the default data folder on this device?",
		detail: `${dataLocation.defaultDataDir(app.getPath("userData"))}\n\nThe synced folder is left untouched.`,
	});
	if (response !== 0) return;
	dataLocation.writeDataDir(app.getPath("userData"), null);
	relaunch();
}

/** Warn when another device has the same synced folder open right now. */
async function checkOtherDevices() {
	const others = dataLocation.otherActiveDevices(DATA_DIR());
	if (others.length === 0) return true;
	const { response } = await dialog.showMessageBox({
		type: "warning",
		buttons: ["Open Anyway", "Quit"],
		defaultId: 1,
		cancelId: 1,
		message: `Meander looks open on ${others.join(", ")}.`,
		detail:
			"Your data folder is shared through sync. Using two devices at the same moment can create sync conflicts in your sessions. Close it there first, or open anyway if that device is actually off.",
	});
	return response === 0;
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual checks report their result in Settings → General.
				{ label: "Check for Updates…", click: () => checkForUpdatesFromMenu() },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{
					label: "Find Everything…",
					accelerator: "CommandOrControl+P",
					click: () => openFindEverything(),
				},
				{ label: "Learn a Folder…", click: () => void learnFolder() },
				{
					label: "Study Stats",
					click: () => {
						const t = appUrl("/stats");
						if (t) void t.win.loadURL(t.url);
					},
				},
				{
					label: "Export to Anki…",
					click: () => {
						const t = appUrl("/api/review/anki");
						if (t) t.win.webContents.downloadURL(t.url);
					},
				},
				{ type: "separator" },
				{ label: "Choose Data Folder…", click: () => void chooseDataFolder() },
				{ label: "Show Data Folder", click: () => void shell.openPath(DATA_DIR()) },
				{
					label: "Use Default Data Folder",
					enabled: dataLocation.isCustomDataDir(app.getPath("userData")),
					click: () => void useDefaultDataFolder(),
				},
				{ type: "separator" },
				{
					label: "Open Tools Folder",
					click: () => {
						const dir = path.join(DATA_DIR(), "tools");
						fs.mkdirSync(dir, { recursive: true });
						void shell.openPath(dir);
					},
				},
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel
				// silently; these broadcast the factor and re-seat the
				// traffic lights. The renderer's --lh-zoom depends on
				// hearing every change.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** `--serve`: the always-on server for phones + this machine's desktop app
 *  (electron/serve-mode.cjs). Exits non-zero if the server dies and zero
 *  after an update, so its systemd unit (Restart=always) brings it back on
 *  the current version. */
/** macOS shows the icon it cached, not the bundle's current one, until told
 *  otherwise — after an update the Dock, About box and ⌘Tab can keep the old
 *  icon. So on every start: set the Dock icon and About panel from this
 *  build; and once per NEW icon, touch the bundle and restart the Dock so
 *  the cached icon (shown while the app is closed) refreshes too. The Dock
 *  blinks for a second that one time. */
function refreshMacIdentity() {
	try {
		const iconPath = path.join(process.resourcesPath, "icon-mac.png");
		const icon = nativeImage.createFromPath(iconPath);
		if (!icon.isEmpty()) app.dock?.setIcon(icon);
		app.setAboutPanelOptions({
			applicationName: PRODUCT_NAME,
			applicationVersion: app.getVersion(),
			version: "",
			copyright: "Copyright © 2026 Vincent Chu",
			...(fs.existsSync(iconPath) ? { iconPath } : {}),
		});
		const bundle = macSelfUpdate.appBundlePath(process.execPath);
		const icns = path.join(process.resourcesPath, "icon.icns");
		if (!bundle || !fs.existsSync(icns)) return;
		const hash = require("node:crypto").createHash("sha1").update(fs.readFileSync(icns)).digest("hex");
		const stampFile = path.join(app.getPath("userData"), "icon-stamp.json");
		let stamp = null;
		try {
			stamp = JSON.parse(fs.readFileSync(stampFile, "utf8")).hash;
		} catch {}
		if (stamp === hash) return;
		setTimeout(() => {
			execFile("/usr/bin/touch", [bundle], () => {
				execFile("/usr/bin/killall", ["Dock"], () => {
					try {
						fs.writeFileSync(stampFile, JSON.stringify({ hash, at: new Date().toISOString() }));
					} catch {}
					log(`mac icon cache refreshed (${hash.slice(0, 8)})`);
				});
			});
		}, 3000);
	} catch (err) {
		log(`mac identity refresh skipped: ${err?.message ?? err}`);
	}
}

async function serveMain() {
	// Never leave the server child behind holding the port: stop it, wait
	// for it to exit (SIGKILL after 5s), then exit with `code`.
	let stopping = false;
	const stopAndExit = (code) => {
		if (stopping) return;
		stopping = true;
		const child = serverProcess;
		serverProcess = null;
		if (!child || child.exitCode !== null) return app.exit(code);
		const force = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.once("exit", () => {
			clearTimeout(force);
			app.exit(code);
		});
		child.kill("SIGTERM");
	};
	// Electron turns SIGTERM/SIGINT into an app quit before Node's handlers
	// run, so the quit itself must wait for the child too.
	app.on("before-quit", (event) => {
		if (stopping) return;
		event.preventDefault();
		stopAndExit(0);
	});
	process.on("SIGTERM", () => stopAndExit(0));
	process.on("SIGINT", () => stopAndExit(0));
	process.on("SIGHUP", () => stopAndExit(0));
	await app.whenReady();
	const userData = app.getPath("userData");
	const port = serveMode.servePort(process.argv);
	const url = `http://127.0.0.1:${port}`;
	if (await serveMode.isUp(url)) {
		log(`serve: a Meander server already answers on ${url}`);
		app.exit(0);
		return;
	}
	log(`serve: starting on ${url} · data dir: ${DATA_DIR()}`);
	const child = await startServer(port, { desktop: false });
	child.on("exit", () => {
		if (!stopping) app.exit(1); // crashed: systemd restarts us
	});
	await waitUntilUp(url);
	serveMode.writeServeUrl(userData, url);
	app.on("will-quit", () => serveMode.clearServeUrl(userData));
	log(`serve: up on ${url}`);

	setupAutoUpdater();
	// Headless: install as soon as an update is downloaded; systemd restarts us.
	autoUpdater?.on("update-downloaded", () => {
		log("serve: update downloaded — installing and exiting for restart");
		const child = serverProcess;
		stopping = true;
		serverProcess = null;
		const install = () => autoUpdater.quitAndInstall(true, false);
		if (!child || child.exitCode !== null) return install();
		const force = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.once("exit", () => {
			clearTimeout(force);
			install();
		});
		child.kill("SIGTERM");
	});
	checkForUpdates();
	setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	// The desktop app may update the shared AppImage first: restart onto it.
	if (process.env.APPIMAGE) {
		serveMode.watchReplaced(process.env.APPIMAGE, () => {
			log("serve: the app file was updated — exiting for restart");
			stopAndExit(0);
		});
	}
}

async function main() {
	app.on("window-all-closed", () => {
		chatgpt?.pause();
		subscriptions?.pause();
		// macOS convention: the app stays resident, reactivated from the Dock.
		if (process.platform !== "darwin") app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", killServer);
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Multi-device presence (fork, 2026-10-26) — packaged app only (dev
	// uses the repo's data/).
	if (!process.env.LH_DEV_URL) {
		if (!(await checkOtherDevices())) {
			app.exit(0);
			return;
		}
		const stopPresence = dataLocation.startPresence(DATA_DIR());
		app.on("will-quit", stopPresence);
	}
	app.on("will-quit", () => globalShortcut.unregisterAll());

	// Dev mode: point at a running `next dev` server (LH_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	const devUrl = process.env.LH_DEV_URL;
	// A running `--serve` instance owns this data folder: attach to it
	// rather than start a second server on the same files.
	attachedServer = devUrl ? null : await serveMode.attachableServer(app.getPath("userData"));
	const external = devUrl ?? attachedServer;
	const url = external ?? `http://127.0.0.1:${await freePort()}`;
	if (!external) {
		desktopAPISecret = randomBytes(32).toString("hex");
		const ownedOrigin = new URL(url).origin;
		// All URLs, not only /api: remove the header again on external redirects.
		session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ requestHeaders: desktopAPIHeaders(details, ownedOrigin, desktopAPISecret, [...trustedAppWindows]) });
		});
		chatgpt = createChatGPT({
			store: fileStore(path.join(app.getPath("userData"), "chatgpt-credentials.json")),
			openExternal: (target) => shell.openExternal(target),
			onChange: (value) => {
				chatgptChild?.send(value);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("lh:chatgpt:changed");
			},
		});
		subscriptions = createSubscriptions({
			directory: app.getPath("userData"),
			loadSDK: () => loadSubscriptionSDK(path.dirname(serverEntry())),
			openExternal: (target) => shell.openExternal(target),
			onChange: (snapshot) => {
				subscriptionChild?.send(snapshot);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("lh:subscriptions:changed");
			},
		});
		await subscriptions.ready;
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(devUrl ? `dev mode: ${devUrl}` : `attached to the Meander server at ${attachedServer}`);
	}

	// Renderer controls contain no token/URL/code operation. The separate server
	// child is the only recipient of credential leases over inherited IPC.
	ipcMain.handle("lh:chatgpt:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) return { error: "Untrusted desktop request." };
		if (!chatgpt || !serverProcess?.connected) return { available: false, pending: false, activeId: null, accounts: [], error: "ChatGPT sign-in requires the desktop app's private server connection. Browser-only and externally launched development servers keep API-key connections." };
		return chatGPTControl(command, chatgpt);
	});

	ipcMain.handle("lh:subscriptions:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		if (!subscriptions || !serverProcess?.connected) {
			if (command?.op === "status") return [];
			throw new Error("Subscription sign-in requires the desktop app's private server connection.");
		}
		return subscriptionControl(command, subscriptions);
	});

	// The dev shell has no browser tabs. Only a one-use action on its own
	// Next server may be resolved here; never accept an arbitrary external URL.
	ipcMain.handle("lh:subscriptions:web-browser", async (event, action) => {
		if (!external || !trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted development request.");
		await openWebSubscriptionBrowser(action, new URL(url).origin, { openExternal: (target) => shell.openExternal(target) });
	});

	installMenu();
	if (process.platform === "darwin" && app.isPackaged) {
		refreshMacIdentity();
		void reportLastMacUpdate();
	}

	// Linux AppImage: keep the app-menu entry + icon in step with this build,
	// so a rename or new icon shows up after an update (linux-desktop-entry.cjs).
	if (process.platform === "linux" && app.isPackaged && process.env.APPIMAGE) {
		linuxDesktopEntry.syncDesktopEntry({
			home: require("node:os").homedir(),
			appImage: process.env.APPIMAGE,
			name: PRODUCT_NAME,
			comment: "Learn anything with an AI teacher that remembers what you know",
			iconSource: path.join(process.resourcesPath, "icon.png"),
			log,
		});
	}

	// Auto-update (Wave C): wire the updater before the window so the
	// banner channel is live from first paint; the first check and the 24h
	// interval fire after it below. setupAutoUpdater's contract: failures
	// are log lines — this can never block boot.
	// FORK (2026-10-27): the baked-in feed is THIS fork's GitHub releases
	// (electron-builder.yml publish → vinceychu/meander), never upstream's.
	setupAutoUpdater();
	// An update staged but never restarted into installs on quit (like
	// autoInstallOnAppQuit does on Linux), without relaunching.
	app.on("will-quit", () => installMacUpdate(false));
	ipcMain.on("lh:update-install", () => installUpdateNow());
	ipcMain.handle("lh:update:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return updateState;
	});
	ipcMain.handle("lh:update:check", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		checkForUpdates({ manual: true });
	});

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	// The renderer's first paint can race did-finish-load — it asks for
	// the current factor itself (mirrors "lh:zoom" pushes).
	ipcMain.handle("lh:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	ipcMain.on("lh:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	reopenWindow = () => { chatgpt?.resume(); subscriptions?.resume(); return createWindow(url); };
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
	});
	createWindow(url);
	log(`window open: ${url}`);
	registerGlobalFind();
	if (process.argv.includes("--find")) openFindEverything();
	// Startup + 24h checks stay main-owned and read the current preference.
	// No renderer subscription is required; late loads retrieve the snapshot.
	if (autoUpdater) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}