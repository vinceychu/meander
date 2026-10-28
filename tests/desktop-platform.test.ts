/** Platform window chrome + packaging policy, without launching Electron. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

/** Decline the single-instance lock so normal boot never spawns a server.
 * Then call the REAL createWindow with a stub Electron API and inspect its
 * constructor options. No rewritten copy of the production logic. */
function windowOptions(platform: string, env: Record<string, string> = {}) {
	class FakeWindow {
		constructor(readonly options: unknown) {}
		webContents = { on() {}, setWindowOpenHandler() {} };
		loadURL() {}
		once() {}
	}
	const electron = {
		app: { setName() {}, getPath: () => "/fixture/LearnHarness", setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : mainRequire(id),
		process: { platform, argv: [], env, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context) as FakeWindow;
	// The options originate in a VM realm; normalize prototypes for assertions.
	return JSON.parse(JSON.stringify(win.options));
}

describe("desktop window chrome", () => {
	it("macOS keeps the proven traffic lights and does not enable WCO", () => {
		const options = windowOptions("darwin");
		assert.equal(options.titleBarStyle, "hiddenInset");
		assert.deepEqual(options.trafficLightPosition, { x: 16, y: 22.5 });
		assert.equal(options.titleBarOverlay, undefined);
		assert.equal(options.autoHideMenuBar, undefined);
	});

	for (const platform of ["win32", "linux"]) {
		it(`${platform} uses native-height right-side controls with an Alt-accessible menu`, () => {
			const options = windowOptions(platform);
			assert.equal(options.titleBarStyle, "hidden");
			assert.deepEqual(options.titleBarOverlay, { color: "#141414", symbolColor: "#e5e5e5" });
			assert.equal(Object.hasOwn(options.titleBarOverlay, "height"), false, "omit height so the OS selects its native default");
			assert.equal(options.trafficLightPosition, undefined);
			assert.equal(options.autoHideMenuBar, true);
			assert.equal(options.webPreferences.contextIsolation, true);
			assert.equal(options.webPreferences.sandbox, true);
			assert.equal(options.webPreferences.nodeIntegration, false);
		});
	}

	it("only the external dev shell receives the web subscription transport marker", () => {
		assert.equal(windowOptions("darwin").webPreferences.additionalArguments, undefined);
		assert.deepEqual(windowOptions("darwin", { LH_DEV_URL: "http://localhost:3000" }).webPreferences.additionalArguments, ["--lh-web-subscriptions"]);
	});

	it("dev preload routes opaque sign-in actions through its narrow external-browser channel", async () => {
		let bridge!: { subscriptionTransport: string; openSubscriptionBrowser(action: string): Promise<void> };
		const invoked: unknown[][] = [];
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
			process: { platform: "darwin", argv: ["--lh-web-subscriptions"] },
			require: () => ({ contextBridge: { exposeInMainWorld: (_: string, value: typeof bridge) => { bridge = value; } }, ipcRenderer: { on() {}, invoke: async (...args: unknown[]) => { invoked.push(args); } } }),
		});
		assert.equal(bridge.subscriptionTransport, "web");
		const action = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
		await bridge.openSubscriptionBrowser(action);
		assert.deepEqual(invoked, [["lh:subscriptions:web-browser", action]]);
	});

	it("preload exposes OS identity without exposing Node/Electron to the renderer", () => {
		let bridge: Record<string, unknown> = {};
		const context = {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lh");
						bridge = api;
					},
				},
				ipcRenderer: { on() {} },
			}),
		};
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), context);
		assert.equal(bridge.platform, "win32");
		assert.deepEqual(Object.keys(bridge).sort(), [
			"chatgpt", "checkForUpdates", "expandWindow", "getUpdateState", "getZoom", "installUpdate", "onOpenSettings", "onUpdateStatus", "onZoom", "platform", "subscriptions",
		]);
		assert.deepEqual(Object.keys(bridge.subscriptions as object).sort(), ["cancel", "consent", "disconnect", "login", "onChange", "open", "respond", "retry", "status"]);
	});
});

describe("update preload bridge", () => {
	it("buffers the menu request, unsubscribes safely, and uses the matching snapshot/check channels", async () => {
		let bridge!: {
			onOpenSettings: (cb: (section: string) => void) => () => void;
			getUpdateState: () => Promise<unknown>;
			checkForUpdates: () => Promise<void>;
		};
		const handlers = new Map<string, (event: unknown, value: string) => void>();
		const invoked: string[] = [];
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
			process: { platform: "darwin" },
			require: () => ({
				contextBridge: { exposeInMainWorld: (_: string, value: typeof bridge) => { bridge = value; } },
				ipcRenderer: {
					on: (channel: string, listener: (event: unknown, value: string) => void) => handlers.set(channel, listener),
					invoke: async (channel: string) => { invoked.push(channel); },
				},
			}),
		});
		const send = () => handlers.get("lh:open-settings")!({}, "general");
		const seen: string[] = [];
		send(); const off = bridge.onOpenSettings(section => seen.push(section));
		assert.deepEqual(seen, ["general"], "pre-subscription request is delivered once");
		send(); assert.deepEqual(seen, ["general", "general"]);
		off(); send(); assert.equal(seen.length, 2);
		const next: string[] = []; const offNext = bridge.onOpenSettings(section => next.push(section));
		assert.deepEqual(next, ["general"]);
		off(); send(); assert.equal(next.length, 2, "old cleanup cannot remove a newer subscriber");
		offNext();
		await bridge.getUpdateState(); await bridge.checkForUpdates();
		assert.deepEqual(invoked, ["lh:update:get", "lh:update:check"]);
	});
});

describe("desktop packaging policy", () => {
	const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
	const config = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

	it("configuration is accepted by the INSTALLED electron-builder schema", async () => {
		const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
		await validateConfiguration(config, { isEnabled: false });
	});

	it("ships Mac arm64, Windows NSIS x64, and both Linux x64 channels", () => {
		assert.deepEqual(config.mac.target, [
			{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] },
		]);
		assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
		assert.equal(config.win.signExecutable, false);
		assert.equal(config.win.verifyUpdateCodeSignature, false);
		assert.deepEqual(config.linux.target, [
			{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] },
		]);
		assert.equal(config.linux.syncDesktopName, true);
		assert.equal(config.publish[0].releaseType, "draft");
	});

	it("deb has public maintainer metadata and a matching desktop identity", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(pkg.author.name, "Vincent Chu");
		assert.equal(pkg.author.email, "vinceychu@users.noreply.github.com");
		assert.equal(pkg.homepage, "https://github.com/vinceychu/meander");
		assert.equal(pkg.desktopName, "learnharness.desktop");
	});
});

describe("Meander release workflow", () => {
	type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
	type Workflow = {
		on: { push: { tags: string[] } };
		jobs: Record<string, { needs?: string | string[]; "runs-on"?: string; steps: Step[]; strategy?: { matrix: { include: { os: string; platform: string; builder_args: string }[] } } }>;
	};
	const yaml = require("js-yaml") as { load(source: string): Workflow };
	const wf = yaml.load(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));

	it("is the only workflow, triggered by version tags", () => {
		assert.deepEqual(readdirSync(new URL("../.github/workflows/", import.meta.url)), ["release.yml"]);
		assert.deepEqual(wf.on.push.tags, ["v*"]);
	});
	it("gates → one draft → both platforms → publish, in order", () => {
		assert.equal(wf.jobs.draft?.needs, "gates");
		assert.equal(wf.jobs.package?.needs, "draft");
		assert.equal(wf.jobs.publish?.needs, "package");
		const gates = wf.jobs.gates!.steps.map((s) => s.run ?? "");
		assert.ok(gates.some((r) => r.includes("Tag must match") || r.includes("tag $GITHUB_REF_NAME")), "tag must equal package.json version");
	});
	it("uses supported Actions on Node 26 only", () => {
		for (const job of Object.values(wf.jobs)) {
			for (const step of job.steps) {
				if (!step.uses) continue;
				assert.ok(["actions/checkout@v7", "actions/setup-node@v7"].includes(step.uses), step.uses);
				if (step.uses === "actions/setup-node@v7") assert.equal(step.with?.["node-version"], "26");
			}
		}
	});
	it("builds Linux x64 and an ad-hoc-signed Intel Mac (the app self-updates on macOS)", () => {
		const m = wf.jobs.package!.strategy!.matrix.include;
		assert.deepEqual(m.map((e) => e.platform).sort(), ["linux-x64", "mac-x64"]);
		const mac = m.find((e) => e.platform === "mac-x64")!;
		assert.match(mac.builder_args, /--mac --x64/);
		assert.match(mac.builder_args, /-c\.mac\.identity=- /);
		assert.match(mac.builder_args, /-c\.mac\.hardenedRuntime=false/);
	});
	it("refuses to publish without both update feeds", () => {
		const run = wf.jobs.publish!.steps.map((s) => s.run ?? "").join("\n");
		assert.match(run, /latest-linux\.yml latest-mac\.yml/);
		assert.match(run, /--draft=false --latest/);
	});
});
