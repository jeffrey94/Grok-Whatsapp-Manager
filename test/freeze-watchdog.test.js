/** Freeze fixes in the Baileys adapter: timeouts on WhatsApp calls, stale-socket watchdog, health fields. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaileysTransport, rejectAfter } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, recordingLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";

function setup(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-freeze-"));
  const authDir = path.join(dir, "auth");
  writePairedCreds(authDir);
  const statusPath = path.join(dir, "state", "status.json");
  const status = new StatusFile(statusPath);
  const log = recordingLog();
  const makeSocket = fakeSocketFactory({});
  const transport = new BaileysTransport({
    authDir, groups: [], log, status, onEvent: () => {}, makeSocket,
    authStateFactory: fakeAuthStateFactory(), backoff: { baseMs: 5, maxMs: 20 }, heartbeatMs: 3_600_000, ...extra,
  });
  const readStatus = async () => { await status.queue; return StatusFile.read(statusPath); };
  return { transport, makeSocket, log, readStatus };
}

async function connected(ctx) {
  void ctx.transport.start();
  await waitFor(() => ctx.makeSocket.sockets.length === 1);
  const sock = ctx.makeSocket.sockets[0];
  sock.open();
  await waitFor(() => ctx.transport.connected);
  return sock;
}

test("rejectAfter rejects a promise that never settles and passes through results", async () => {
  await assert.rejects(rejectAfter(new Promise(() => {}), 20, "thing"), /thing timed out after 20ms/);
  assert.equal(await rejectAfter(Promise.resolve(7), 1_000, "x"), 7);
});

test("a hung presence update or sendMessage rejects instead of hanging forever", async () => {
  const ctx = setup({ typingTimeoutMs: 30, sendTimeoutMs: 40 });
  const sock = await connected(ctx);
  sock.sendPresenceUpdate = () => new Promise(() => {});
  sock.sendMessage = () => new Promise(() => {});
  await assert.rejects(ctx.transport.setTyping("120363000000000001@g.us", true), /presence update timed out/);
  await assert.rejects(ctx.transport.sendText("120363000000000001@g.us", "hello"), /sendMessage timed out/);
  await ctx.transport.stop();
});

test("heartbeat writes liveness fields and ends a connected socket that has been silent too long", async () => {
  let now = 1_000_000;
  const ctx = setup({ staleSocketMs: 60_000, now: () => now, healthProbe: () => ({ oldestInboundMs: 5, eventLoopMaxLagMs: 1 }) });
  const sock = await connected(ctx);
  ctx.transport.heartbeatTick();
  let status = await ctx.readStatus();
  assert.equal(status.oldestInboundMs, 5);
  assert.ok(status.lastFrameAt && status.heartbeatAt);
  assert.ok(!sock.ended, "fresh socket is left alone");
  now += 61_000;
  ctx.transport.heartbeatTick();
  assert.ok(sock.ended, "silent socket was ended so Baileys' close -> reconnect path runs");
  assert.ok(ctx.log.lines.some((line) => /silent for 61s/.test(line)));
  await ctx.transport.stop();
});

test("box pause: a wall-clock jump without monotonic progress is logged, refreshes the heartbeat and reconnects", async () => {
  let wall = 5_000_000; let mono = 1_000;
  const ctx = setup({ now: () => wall, monotonic: () => mono, pauseCheckMs: 0 });
  const sock = await connected(ctx);
  ctx.transport.lastClock = { wall, mono };
  wall += 5_000; mono += 5_000;
  assert.equal(ctx.transport.checkPause(), false, "normal tick");
  assert.ok(!sock.ended);
  wall += 240_000; mono += 5_000;
  assert.equal(ctx.transport.checkPause(), true);
  assert.ok(sock.ended, "socket ended so Baileys reconnects right away");
  assert.ok(ctx.log.lines.some((line) => /paused for about 235s/.test(line)));
  const status = await ctx.readStatus();
  assert.equal(status.pausesDetected, 1);
  await ctx.transport.stop();
});
