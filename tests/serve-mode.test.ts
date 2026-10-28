/**
 * SERVE MODE PINS (2026-10-27): the always-on server's port parsing, the
 * attach handshake (serve.json + a live Meander probe), and the
 * restart-on-update watcher (electron/serve-mode.cjs).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import serve from "../electron/serve-mode.cjs";

describe("serve mode", () => {
	it("parses --port=N, defaulting to 8710", () => {
		assert.equal(serve.servePort([]), 8710);
		assert.equal(serve.servePort(["--serve", "--port=9001"]), 9001);
		assert.equal(serve.servePort(["--port=nope"]), 8710);
		assert.equal(serve.servePort(["--port=70000"]), 8710);
	});

	it("serve.json only ever points at a loopback server", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-serve-"));
		serve.writeServeUrl(dir, "http://127.0.0.1:8710");
		assert.equal(serve.readServeUrl(dir), "http://127.0.0.1:8710");
		fs.writeFileSync(serve.serveFile(dir), JSON.stringify({ url: "http://evil.example:80" }));
		assert.equal(serve.readServeUrl(dir), null);
		fs.writeFileSync(serve.serveFile(dir), "not json");
		assert.equal(serve.readServeUrl(dir), null);
	});

	it("clearServeUrl removes only this process's record", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-serve-"));
		fs.writeFileSync(serve.serveFile(dir), JSON.stringify({ url: "http://127.0.0.1:1", pid: -1 }));
		serve.clearServeUrl(dir);
		assert.ok(fs.existsSync(serve.serveFile(dir)), "another process's record stays");
		serve.writeServeUrl(dir, "http://127.0.0.1:1");
		serve.clearServeUrl(dir);
		assert.equal(fs.existsSync(serve.serveFile(dir)), false);
	});

	it("attaches only to a live server that answers as Meander", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-serve-"));
		let body = '{"name":"Meander"}';
		const srv = http.createServer((req, res) => {
			res.writeHead(req.url === "/manifest.webmanifest" ? 200 : 404).end(body);
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
		try {
			assert.equal(await serve.attachableServer(dir), null, "no serve.json → spawn own server");
			serve.writeServeUrl(dir, url);
			assert.equal(await serve.attachableServer(dir), url);
			body = '{"name":"Something else"}';
			assert.equal(await serve.attachableServer(dir), null, "a different app on the port is not ours");
		} finally {
			srv.close();
		}
		assert.equal(await serve.attachableServer(dir), null, "a dead server → spawn own");
	});

	it("notices when the app file is replaced (update) and fires once", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-serve-"));
		const file = path.join(dir, "Meander.AppImage");
		fs.writeFileSync(file, "v1");
		let fired = 0;
		const stop = serve.watchReplaced(file, () => fired++, 20);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(fired, 0);
		fs.writeFileSync(file + ".new", "v2-longer");
		fs.renameSync(file + ".new", file);
		await new Promise((r) => setTimeout(r, 80));
		stop();
		assert.equal(fired, 1);
	});
});

describe("shared brain over Tailscale", () => {
	const status = {
		Peer: {
			a: { DNSName: "5090v1.tail8e67fe.ts.net.", Online: true },
			b: { DNSName: "iphone.tail8e67fe.ts.net.", Online: true },
			c: { DNSName: "old-pc.tail8e67fe.ts.net.", Online: false },
			d: { DNSName: "", Online: true },
		},
	};
	const fakeExec = (json: unknown) => ((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, JSON.stringify(json))) as never;

	it("only online peers, as tailnet http URLs", () => {
		assert.deepEqual(serve.peerUrls(status), ["http://5090v1.tail8e67fe.ts.net", "http://iphone.tail8e67fe.ts.net"]);
		assert.equal(serve.isTailnetUrl("http://5090v1.tail8e67fe.ts.net"), true);
		assert.equal(serve.isTailnetUrl("http://evil.example.com"), false);
		assert.equal(serve.isTailnetUrl("http://x.ts.net/path"), false);
	});
	it("finds the peer that answers as Meander, remembers it, tries it first next time", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-"));
		const probed: string[] = [];
		const probe = async (u: string) => (probed.push(u), u.includes("5090v1"));
		const found = await serve.findTailnetBrain(dir, { execFile: fakeExec(status), cli: "/x/tailscale", probe });
		assert.equal(found, "http://5090v1.tail8e67fe.ts.net");
		assert.equal(serve.rememberedBrain(dir), found);
		probed.length = 0;
		assert.equal(await serve.findTailnetBrain(dir, { execFile: fakeExec({}), cli: "/x/tailscale", probe }), found);
		assert.deepEqual(probed, [found], "remembered server answered: no scan");
		fs.rmSync(dir, { recursive: true, force: true });
	});
	it("no Tailscale, or nobody answers: null (the app runs its own server)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-"));
		assert.equal(await serve.findTailnetBrain(dir, { execFile: fakeExec(status), cli: "/x/tailscale", probe: async () => false }), null);
		assert.equal(serve.rememberedBrain(dir), null);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
