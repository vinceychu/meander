/**
 * The shared Meander is served over plain http inside the tailnet, where
 * browsers withhold secure-context APIs like crypto.randomUUID. Browser-side
 * code must not depend on them (2026-10-29: every send died there).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newMessageId } from "../src/core/native-messages.ts";

describe("works on a non-secure (http) page", () => {
	it("mints message ids without crypto.randomUUID", () => {
		const original = crypto.randomUUID;
		Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
		try {
			const a = newMessageId();
			const b = newMessageId();
			assert.match(a, /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
			assert.notEqual(a, b);
		} finally {
			Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
		}
	});
});
