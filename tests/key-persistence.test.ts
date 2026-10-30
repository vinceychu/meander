/**
 * Keys never get lost (2026-10-30): a double paste is saved as the one key,
 * a broken auth.json falls back to its backup copy, and a device's own
 * keys are copied to the shared brain when it attaches.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import serve from "../electron/serve-mode.cjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-key-persist-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Import AFTER the env redirect — module-load-bound seam.
const { authStore } = await import("../src/store/auth.ts");
const { undoubledPaste } = await import("../src/server/keys.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("key persistence", () => {
	it("a key pasted twice is stored once; ordinary keys are untouched", () => {
		const key = "0123456789abcdef0123456789abcdef01234567";
		assert.equal(undoubledPaste("d".repeat(40)), "d".repeat(40)); // not random: not a double paste
		assert.equal(undoubledPaste(key + key), key);
		assert.equal(undoubledPaste(key), key);
		assert.equal(undoubledPaste("abab"), "abab"); // too short to be a doubled key
	});

	it("keys come back from the backup when auth.json is missing or corrupt", () => {
		authStore.setAuthVar("DEEPGRAM_API_KEY", "dg-key-1234567890");
		const backup = path.join(TMP, "auth.backup.json");
		assert.equal((fs.statSync(backup).mode & 0o777).toString(8), "600");
		fs.writeFileSync(process.env.LH_AUTH_FILE!, "{ not json");
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, "dg-key-1234567890");
		fs.rmSync(process.env.LH_AUTH_FILE!);
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, "dg-key-1234567890");
	});

	it("a deleted key stays deleted (the backup follows every write)", () => {
		authStore.deleteAuthVar("DEEPGRAM_API_KEY");
		fs.rmSync(process.env.LH_AUTH_FILE!);
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, undefined);
	});

	it("copies only the keys the shared brain lacks", async () => {
		const file = path.join(TMP, "device-auth.json");
		fs.writeFileSync(file, JSON.stringify({ DEEPGRAM_API_KEY: "dg-local", ANTHROPIC_API_KEY: "sk-ant-local" }));
		const puts: { url: string; body: string }[] = [];
		const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "PUT") {
				puts.push({ url, body: String(init.body ?? "") });
				return new Response("{}", { status: 200 });
			}
			return Response.json({ keys: [{ id: "ANTHROPIC_API_KEY", present: true }, { id: "DEEPGRAM_API_KEY", present: false }] });
		};
		const shared = await serve.shareLocalKeys("http://brain.ts.net", file, { fetch: fakeFetch });
		assert.deepEqual(shared, ["DEEPGRAM_API_KEY"]);
		assert.deepEqual(puts, [{ url: "http://brain.ts.net/api/keys/DEEPGRAM_API_KEY", body: JSON.stringify({ value: "dg-local" }) }]);
	});

	it("no local auth.json: nothing to share, no requests", async () => {
		const shared = await serve.shareLocalKeys("http://brain.ts.net", path.join(TMP, "none.json"), {
			fetch: async () => assert.fail("should not fetch"),
		});
		assert.deepEqual(shared, []);
	});
});
