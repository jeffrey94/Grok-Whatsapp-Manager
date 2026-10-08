import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditPrivateDir, ensurePrivateDir, readSessionInfo, writePrivateJson } from "../src/whatsapp/secure-fs.js";

const root = mkdtempSync(path.join(tmpdir(), "wa-secure-"));
const mode = (file) => (statSync(file).mode & 0o777).toString(8);

test("ensurePrivateDir tightens auth dir to 700 and files to 600", () => {
  const auth = path.join(root, "auth");
  mkdirSync(path.join(auth, "sub"), { recursive: true });
  writeFileSync(path.join(auth, "creds.json"), "{}");
  writeFileSync(path.join(auth, "sub", "key.json"), "{}");
  chmodSync(auth, 0o755);
  chmodSync(path.join(auth, "creds.json"), 0o644);
  assert.ok(auditPrivateDir(auth).length > 0);
  ensurePrivateDir(auth);
  assert.equal(mode(auth), "700");
  assert.equal(mode(path.join(auth, "creds.json")), "600");
  assert.equal(mode(path.join(auth, "sub", "key.json")), "600");
  assert.deepEqual(auditPrivateDir(auth), []);
});

test("ensurePrivateDir refuses symlinks", () => {
  const dir = path.join(root, "linky");
  mkdirSync(dir);
  symlinkSync("/etc/hostname", path.join(dir, "evil.json"));
  assert.throws(() => ensurePrivateDir(dir), /symlink/);
  symlinkSync(path.join(root, "auth"), path.join(root, "auth-link"));
  assert.throws(() => ensurePrivateDir(path.join(root, "auth-link")), /not a symlink/);
});

test("readSessionInfo reports pairing without exposing secrets", () => {
  const auth = path.join(root, "session");
  mkdirSync(auth);
  assert.deepEqual(readSessionInfo(auth), { exists: false, registered: false });
  writeFileSync(path.join(auth, "creds.json"), JSON.stringify({ registered: false, noiseKey: "secret" }), { mode: 0o600 });
  assert.equal(readSessionInfo(auth).registered, false);
  writeFileSync(path.join(auth, "creds.json"), JSON.stringify({ registered: true, me: { id: "60123456789:7@s.whatsapp.net" }, noiseKey: "secret" }), { mode: 0o600 });
  const info = readSessionInfo(auth);
  assert.equal(info.registered, true);
  assert.equal(info.account, "•••••••6789");
  assert.equal(JSON.stringify(info).includes("secret"), false);
});

test("writePrivateJson writes mode 600 atomically", async () => {
  const file = path.join(root, "state", "status.json");
  await writePrivateJson(file, { state: "connected" });
  assert.equal(mode(file), "600");
  assert.equal(mode(path.dirname(file)), "700");
});
