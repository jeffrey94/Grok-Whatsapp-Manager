import test from "node:test";
import assert from "node:assert/strict";
import { installConsoleGuard, sanitizeConsoleArgs } from "../src/console-guard.js";

class SessionEntry {
  constructor() {
    this.registrationId = 898929241;
    this.currentRatchet = {
      ephemeralKeyPair: { pubKey: Buffer.from("05aa", "hex"), privKey: Buffer.from("deadbeefcafebabe", "hex") },
      rootKey: Buffer.from("0123456789abcdef", "hex"),
    };
  }
}

function fakeConsole() {
  const out = [];
  const target = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) target[level] = (...args) => out.push([level, args]);
  return { target, out };
}

test("item 5: libsignal session dumps never reach the log; plain bridge lines pass through untouched", () => {
  const { target, out } = fakeConsole();
  installConsoleGuard({ target, now: () => new Date("2026-09-29T10:00:00Z") });
  target.log("2026-09-29T10:00:00.000Z INFO wa-bridge: WhatsApp connected account=••••6789");
  target.info("Closing session:", new SessionEntry());
  target.info("Opening session:", new SessionEntry());
  target.warn("Session already closed", new SessionEntry());
  target.warn("Closing open session in favor of incoming prekey bundle");
  target.error("Session error:Error: Bad MAC", "Error: Bad MAC\n    at x");
  target.log("something", { privKey: Buffer.from("aa", "hex") });
  const printed = out.map(([, args]) => args.map(String).join(" ")).join("\n");
  assert.doesNotMatch(printed, /privKey|rootKey|deadbeef|de ad be ef|<Buffer|SessionEntry|registrationId/);
  assert.equal(out[0][1][0], "2026-09-29T10:00:00.000Z INFO wa-bridge: WhatsApp connected account=••••6789", "bridge logger lines unchanged");
  assert.ok(printed.includes("WARN wa-bridge: console libsignal: Session already closed (session details redacted)"));
  assert.ok(printed.includes("Closing open session in favor of incoming prekey bundle"), "string-only warnings without key material pass through");
  assert.ok(printed.includes("Session error:Error: Bad MAC"));
  assert.ok(printed.includes("INFO wa-bridge: console something [redacted object]"));
  assert.equal(out.length, 5, "info-level Closing/Opening session dumps are dropped entirely");
});

test("item 5: sanitizeConsoleArgs redacts buffers, objects and pre-formatted dumps", () => {
  assert.equal(sanitizeConsoleArgs("log", ["plain", 1, true]), undefined, "undefined = print unchanged");
  assert.equal(sanitizeConsoleArgs("info", ["Closing session:", new SessionEntry()]), null);
  assert.equal(sanitizeConsoleArgs("info", ["Closing session:", new SessionEntry()], { verbose: true }), "libsignal: Closing session (session details redacted)");
  assert.equal(sanitizeConsoleArgs("log", ["x", Buffer.from("ff", "hex")]), "x [redacted bytes]");
  assert.equal(sanitizeConsoleArgs("log", ["  privKey: <Buffer 30 45>"]), "[redacted]");
});
