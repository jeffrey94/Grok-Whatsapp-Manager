import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPairingCode, normalizePairingPhone, pairDevice } from "../src/whatsapp/pairing.js";
import { fakeSocketFactory, quietLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";

// These tests drive the pairing flow with a FAKE socket. No WhatsApp server is
// contacted and no number is linked.

function authStateFactoryThatPairs(authDir) {
  return async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: async () => { writePairedCreds(authDir, "60123456789:9@s.whatsapp.net"); },
  });
}

test("phone and code formatting", () => {
  assert.equal(normalizePairingPhone("+60 12-345 6789"), "60123456789");
  assert.throws(() => normalizePairingPhone("012"), /full international number/);
  assert.equal(formatPairingCode("abcd1234"), "ABCD-1234");
});

test("pairing-code flow: requests a code for the number, stores it mode 600, cleans up after linking", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-pair-"));
  const authDir = path.join(dir, "auth");
  const codePath = path.join(dir, "state", "pairing-code.txt");
  const makeSocket = fakeSocketFactory();
  const out = [];
  const pairing = pairDevice({ authDir, method: "code", phone: "+60 12-345 6789", codePath, log: quietLog, out: (line) => out.push(line), makeSocket, authStateFactory: authStateFactoryThatPairs(authDir) });
  await waitFor(() => makeSocket.sockets.length === 1);
  const sock = makeSocket.sockets[0];
  sock.ev.emit("connection.update", { qr: "2@ignored-in-code-mode" });
  await waitFor(() => existsSync(codePath));
  assert.deepEqual(sock.pairingRequests, ["60123456789"]);
  assert.equal(readFileSync(codePath, "utf8").trim(), "ABCD-1234");
  assert.equal((statSync(codePath).mode & 0o777).toString(8), "600");
  sock.ev.emit("connection.update", { qr: "2@second" });
  assert.equal(sock.pairingRequests.length, 1, "code requested once");
  sock.ev.emit("creds.update", {});
  sock.close(515); // WhatsApp asks for a restart right after pairing
  await waitFor(() => makeSocket.sockets.length === 2);
  makeSocket.sockets[1].open();
  const result = await pairing;
  assert.equal(result.paired, true);
  assert.equal(existsSync(codePath), false, "pairing code file removed");
  assert.ok(out.some((line) => line.includes("Pairing code: ABCD-1234")));
  assert.equal((statSync(authDir).mode & 0o777).toString(8), "700");
});

test("QR flow: renders terminal QR and a mode-600 PNG, gives up after maxQr", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-pair-"));
  const authDir = path.join(dir, "auth");
  const pngPath = path.join(dir, "state", "pair-qr.png");
  const makeSocket = fakeSocketFactory();
  const out = [];
  const pairing = pairDevice({ authDir, method: "qr", pngPath, log: quietLog, out: (line) => out.push(line), makeSocket, authStateFactory: authStateFactoryThatPairs(authDir), maxQr: 2 });
  await waitFor(() => makeSocket.sockets.length === 1);
  const sock = makeSocket.sockets[0];
  sock.ev.emit("connection.update", { qr: "2@fake-qr-one" });
  await waitFor(() => existsSync(pngPath));
  assert.equal((statSync(pngPath).mode & 0o777).toString(8), "600");
  assert.equal(readFileSync(pngPath).subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(out.some((line) => line.includes("\x1b[30;47m")));
  sock.ev.emit("connection.update", { qr: "2@fake-qr-two" });
  await waitFor(() => out.some((line) => line.startsWith("QR 2/2")));
  sock.ev.emit("connection.update", { qr: "2@fake-qr-three" });
  await assert.rejects(pairing, /No scan after several QR codes/);
  assert.equal(existsSync(pngPath), false, "QR image removed when giving up");
  assert.equal(sock.ended, true);
});

test("refuses to overwrite an existing paired session or a half-finished one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-pair-"));
  const authDir = path.join(dir, "auth");
  writePairedCreds(authDir);
  const makeSocket = fakeSocketFactory();
  await assert.rejects(pairDevice({ authDir, method: "qr", log: quietLog, makeSocket }), /already holds a paired session/);
  writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ registered: false }), { mode: 0o600 });
  await assert.rejects(pairDevice({ authDir, method: "qr", log: quietLog, makeSocket }), /half-finished pairing/);
  assert.equal(makeSocket.sockets.length, 0);
});
