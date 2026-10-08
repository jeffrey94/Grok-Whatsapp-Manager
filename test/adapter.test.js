import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaileysTransport, NeedsPairingError, socketOptions } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, recordingLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";

function setup({ paired = true, groups = [], socketGroups = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-adapter-"));
  const authDir = path.join(dir, "auth");
  if (paired) writePairedCreds(authDir);
  const statusPath = path.join(dir, "state", "status.json");
  const status = new StatusFile(statusPath);
  const log = recordingLog();
  const events = [];
  const makeSocket = fakeSocketFactory({ groups: socketGroups });
  const opened = [];
  const transport = new BaileysTransport({
    authDir,
    groups,
    log,
    status,
    onEvent: (event) => events.push(event),
    onOpen: () => opened.push(Date.now()),
    makeSocket,
    authStateFactory: fakeAuthStateFactory(),
    backoff: { baseMs: 5, maxMs: 20 },
    groupsListPath: path.join(dir, "state", "groups.json"),
  });
  const readStatus = async () => { await status.queue; return StatusFile.read(statusPath); };
  const socketAt = async (index) => { await waitFor(() => makeSocket.sockets.length > index); return makeSocket.sockets[index]; };
  return { socketAt, dir, authDir, statusPath, status, log, events, makeSocket, transport, readStatus, opened };
}

test("socket options: not always-online, no history sync, ignore status/newsletter/broadcast", () => {
  const options = socketOptions({ auth: {}, logger: {}, getMessage: async () => undefined, cachedGroupMetadata: async () => undefined });
  assert.equal(options.markOnlineOnConnect, false);
  assert.equal(options.syncFullHistory, false);
  assert.equal(options.shouldSyncHistoryMessage(), true);
  assert.equal(options.shouldIgnoreJid("status@broadcast"), true);
  assert.equal(options.shouldIgnoreJid("123@newsletter"), true);
  assert.equal(options.shouldIgnoreJid("60123456789@s.whatsapp.net"), false);
});

test("refuses to start without a paired session and writes needs-pairing", async () => {
  const ctx = setup({ paired: false });
  await assert.rejects(ctx.transport.start(), NeedsPairingError);
  assert.equal(ctx.makeSocket.sockets.length, 0, "no socket was created");
  assert.equal((await ctx.readStatus()).state, "needs-pairing");
  assert.equal((statSync(ctx.authDir).mode & 0o777).toString(8), "700");
});

test("on open: connected status, group visibility check warns about missing groups", async () => {
  const ctx = setup({
    groups: [{ jid: "120363000000000001@g.us", name: "Quotes" }, { jid: "120363000000000002@g.us", name: "Jobs" }],
    socketGroups: { "120363000000000001@g.us": { id: "120363000000000001@g.us", subject: "Acme Quotes" } },
  });
  const stopped = ctx.transport.start();
  const sock = await ctx.socketAt(0);
  sock.open();
  await waitFor(async () => (await ctx.readStatus())?.groupsCheck === "missing");
  const status = await ctx.readStatus();
  assert.equal(status.state, "connected");
  assert.deepEqual(status.groupsVisible, ["120363000000000001@g.us"]);
  assert.deepEqual(status.groupsMissing, ["120363000000000002@g.us"]);
  assert.ok(ctx.log.lines.some((line) => /WARNING configured group NOT visible.*120363000000000002@g\.us \(Jobs\)/.test(line)));
  assert.equal(ctx.transport.chatName("120363000000000001@g.us"), "Acme Quotes");
  assert.deepEqual(ctx.transport.selfIds(), ["60111111111@s.whatsapp.net", "99999999999999@lid"]);
  assert.equal(ctx.opened.length, 1);
  // Group id discovery: local mode-600 list of joined groups for config.json.
  const listPath = path.join(ctx.dir, "state", "groups.json");
  await waitFor(() => { try { statSync(listPath); return true; } catch { return false; } });
  assert.equal((statSync(listPath).mode & 0o777).toString(8), "600");
  assert.deepEqual(JSON.parse(readFileSync(listPath, "utf8")).groups, [
    { jid: "120363000000000001@g.us", subject: "Acme Quotes", configured: true },
  ]);
  await ctx.transport.stop();
  assert.equal((await stopped).state, "stopped");
  assert.equal(sock.ended, true);
});

test("logged out: stop, alert in status file, no reconnect loop", async () => {
  const ctx = setup();
  const stopped = ctx.transport.start();
  (await ctx.socketAt(0)).open();
  (await ctx.socketAt(0)).close(401);
  const result = await stopped;
  assert.deepEqual(result, { state: "logged-out", terminal: true });
  const status = await ctx.readStatus();
  assert.equal(status.state, "logged-out");
  assert.equal(status.alert, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctx.makeSocket.sockets.length, 1, "no new socket after logout");
  assert.ok(ctx.log.lines.some((line) => line.startsWith("error ALERT")));
});

test("connection replaced and forbidden are terminal too", async () => {
  for (const [code, state] of [[440, "connection-replaced"], [403, "forbidden"]]) {
    const ctx = setup();
    const stopped = ctx.transport.start();
    (await ctx.socketAt(0)).close(code);
    assert.equal((await stopped).state, state);
  }
});

test("transient close reconnects with backoff; restartRequired reconnects at once", async () => {
  const ctx = setup();
  void ctx.transport.start();
  (await ctx.socketAt(0)).close(408);
  await waitFor(() => ctx.makeSocket.sockets.length === 2);
  assert.equal((await ctx.readStatus()).state, "reconnecting");
  (await ctx.socketAt(1)).close(515);
  assert.equal(ctx.makeSocket.sockets.length, 3, "restartRequired reconnects synchronously");
  (await ctx.socketAt(2)).open();
  await waitFor(async () => (await ctx.readStatus())?.state === "connected");
  assert.equal(ctx.transport.attempts, 0);
  await ctx.transport.stop();
});

test("a QR request while running means unpaired: terminal needs-pairing, QR never shown", async () => {
  const ctx = setup();
  const stopped = ctx.transport.start();
  (await ctx.socketAt(0)).ev.emit("connection.update", { qr: "2@secret-qr-payload" });
  assert.equal((await stopped).state, "needs-pairing");
  assert.equal(ctx.log.lines.some((line) => line.includes("secret-qr-payload")), false);
});

test("only live 'notify' upserts reach the bridge; skipped types are dropped", async () => {
  const ctx = setup();
  void ctx.transport.start();
  const sock = await ctx.socketAt(0);
  sock.open();
  const ts = Math.floor(Date.now() / 1000);
  sock.deliver([{ key: { remoteJid: "60123456789@s.whatsapp.net", id: "H1" }, messageTimestamp: ts, message: { conversation: "old" } }], "append");
  sock.deliver([
    { key: { remoteJid: "status@broadcast", id: "S1", participant: "60123456789@s.whatsapp.net" }, message: { conversation: "status" } },
    { key: { remoteJid: "60123456789@s.whatsapp.net", id: "N1" }, messageTimestamp: ts, message: { conversation: "new" } },
  ]);
  await waitFor(() => ctx.events.length === 1);
  assert.equal(ctx.events[0].id, "N1");
  await ctx.transport.stop();
});

test("sends wait briefly for a reconnect and remember our message ids", async () => {
  const ctx = setup();
  void ctx.transport.start();
  const sock = await ctx.socketAt(0);
  const pending = ctx.transport.sendText("60123456789@s.whatsapp.net", "hello");
  setTimeout(() => sock.open(), 20);
  const { id } = await pending;
  assert.equal(id, "BOTMSG1");
  assert.equal(ctx.transport.wasSentByUs("BOTMSG1"), true);
  await ctx.transport.sendFile("60123456789@s.whatsapp.net", { bytes: Buffer.from("%PDF"), filename: "q.pdf", mimetype: "application/pdf" });
  assert.deepEqual(Object.keys(sock.sent[1].content).sort(), ["document", "fileName", "mimetype"]);
  await ctx.transport.sendFile("60123456789@s.whatsapp.net", { bytes: Buffer.from("png"), filename: "a.png", mimetype: "image/png" });
  assert.ok(sock.sent[2].content.image);
  await ctx.transport.stop();
});

test("group-participants change refreshes cached group metadata (new members get the sender key)", async () => {
  const ctx = setup();
  const jid = "120363000000000001@g.us";
  ctx.transport.groupMeta.set(jid, { id: jid, subject: "G", participants: [{ id: "a@lid" }] });
  const fresh = { id: jid, subject: "G", participants: [{ id: "a@lid" }, { id: "b@lid" }] };
  await ctx.transport.refreshGroup(jid, { groupMetadata: async () => fresh }, "participants");
  assert.equal(ctx.transport.groupMeta.get(jid).participants.length, 2);
  // fetch failure leaves the cache empty so Baileys fetches fresh metadata itself
  await ctx.transport.refreshGroup(jid, { groupMetadata: async () => { throw new Error("boom"); } }, "participants");
  assert.equal(ctx.transport.groupMeta.has(jid), false);
});
