import test from "node:test";
import assert from "node:assert/strict";
import { LoopGuard, SlidingWindowLimiter } from "../src/core/loop-guard.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("sliding window limiter", () => {
  const c = clock();
  const limiter = new SlidingWindowLimiter(2, 60_000, c.now);
  assert.equal(limiter.tryTake("a"), true);
  assert.equal(limiter.tryTake("a"), true);
  assert.equal(limiter.tryTake("a"), false);
  assert.equal(limiter.tryTake("b"), true);
  c.advance(60_001);
  assert.equal(limiter.tryTake("a"), true);
});

test("never accepts own messages or bots", () => {
  const guard = new LoopGuard();
  assert.deepEqual(guard.checkInbound({ fromMe: true, chatId: "c" }), { ok: false, reason: "own-message" });
  assert.equal(guard.checkInbound({ chatId: "c", sender: { jid: "1@lid" } }, ["1@lid"]).reason, "own-message");
  assert.equal(guard.checkInbound({ chatId: "c", sender: { jid: "2@s.whatsapp.net", lid: "1@lid" } }, ["1@lid"]).reason, "own-message");
  assert.equal(guard.checkInbound({ chatId: "c", isBot: true, sender: { jid: "x@bot" } }).reason, "bot-sender");
  assert.equal(guard.checkInbound({ chatId: "c", sender: { jid: "2@lid" }, text: "hi" }).ok, true);
});

test("echo of our own recent reply is dropped (bot-to-bot loop guard)", () => {
  const c = clock();
  const guard = new LoopGuard({}, { now: c.now });
  guard.recordOutboundText("g@g.us", "Your quote QT-2026-0001 is ready.");
  assert.equal(guard.checkInbound({ chatId: "g@g.us", sender: { jid: "2@lid" }, text: "your quote  QT-2026-0001 is ready." }).reason, "echo-of-own-reply");
  assert.equal(guard.checkInbound({ chatId: "other@g.us", sender: { jid: "2@lid" }, text: "Your quote QT-2026-0001 is ready." }).ok, true);
  c.advance(5 * 60_000 + 1);
  assert.equal(guard.checkInbound({ chatId: "g@g.us", sender: { jid: "2@lid" }, text: "Your quote QT-2026-0001 is ready." }).ok, true);
});

test("inbound flood limits count turns per sender and per chat", () => {
  const c = clock();
  const guard = new LoopGuard({ inboundPerSenderPerMinute: 2, inboundPerChatPerMinute: 3 }, { now: c.now });
  assert.equal(guard.takeInboundTurn("g", "a").ok, true);
  assert.equal(guard.takeInboundTurn("g", "a").ok, true);
  assert.equal(guard.takeInboundTurn("g", "a").reason, "inbound-sender-rate");
  assert.equal(guard.takeInboundTurn("g", "b").ok, true);
  assert.equal(guard.takeInboundTurn("g", "c").reason, "inbound-chat-rate");
  c.advance(60_001);
  assert.equal(guard.takeInboundTurn("g", "a").ok, true);
});

test("reply-only: no outbound without an open reply window; window expires", () => {
  const c = clock();
  const guard = new LoopGuard({ replyWindowMs: 1_000 }, { now: c.now });
  assert.deepEqual(guard.takeOutbound("dm@s.whatsapp.net"), { ok: false, reason: "no-reply-window" });
  guard.openReplyWindow("dm@s.whatsapp.net");
  assert.equal(guard.takeOutbound("dm@s.whatsapp.net").ok, true);
  c.advance(1_001);
  assert.equal(guard.takeOutbound("dm@s.whatsapp.net").reason, "no-reply-window");
});

test("outbound limits per chat and global", () => {
  const c = clock();
  const guard = new LoopGuard({ outboundPerChatPerMinute: 2, outboundGlobalPerMinute: 3 }, { now: c.now });
  for (const chat of ["a", "b"]) guard.openReplyWindow(chat);
  assert.equal(guard.takeOutbound("a").ok, true);
  assert.equal(guard.takeOutbound("a").ok, true);
  assert.equal(guard.takeOutbound("a").reason, "outbound-chat-rate");
  assert.equal(guard.takeOutbound("b").ok, true);
  assert.equal(guard.takeOutbound("b").reason, "outbound-global-rate");
  c.advance(60_001);
  assert.equal(guard.takeOutbound("a").ok, true);
});
