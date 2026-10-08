/**
 * Streaming delivery, reply timeouts and late (after-turn) agent messages.
 * Offline: an in-memory gateway behind GrokClient's fetchImpl and a fake
 * WhatsApp transport. Nothing contacts WhatsApp or the real gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_NOTICE, WhatsAppBridge, chatFromNonce } from "../src/bridge.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter } from "../src/core/routing.js";
import { GrokClient } from "../src/grok-client.js";
import { JsonStateStore } from "../src/state.js";
import { recordingLog, waitFor } from "./helpers/fake-baileys.js";

const AGENT = "agent-pj";
const OTHER_AGENT = "agent-other";
const GROUP = "120363000000000004@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const OWNER = "60123456789@s.whatsapp.net";
const SELF = "60111111111@s.whatsapp.net";

/** In-memory gateway. `status` is what listAgents reports for AGENT. */
function fakeGateway() {
  const gw = {
    entries: [],
    status: { isRunning: false, isRunningTurn: false, isComposingMessage: false },
    seq: 0,
    prompts: [],
    onPrompt: undefined,
    id(prefix) { gw.seq += 1; return `${prefix}${gw.seq}`; },
    reply(text, extra = {}) {
      const entry = { id: gw.id("s"), kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: text }, ...extra };
      gw.entries.push(entry);
      return entry;
    },
    desktopPrompt(text) {
      gw.entries.push({ id: gw.id("u"), kind: "message", role: "user", clientNonce: "desktop-uuid", content: text, timestampMs: Date.now() });
    },
  };
  const handlers = {
    listAgents: () => ({ agents: [{ id: AGENT, name: "PJ", ...gw.status }, { id: OTHER_AGENT, name: "Other", isRunning: false }] }),
    sendPrompt: (body) => {
      gw.prompts.push(body);
      gw.entries.push({ id: gw.id("u"), kind: "message", role: "user", clientNonce: body.clientNonce, content: body.prompt, timestampMs: Date.now() });
      gw.onPrompt?.(body);
      return { accepted: true };
    },
    getAgentTranscriptTail: ({ id, limit }) => ({ entries: id === AGENT ? gw.entries.slice(-limit) : [] }),
    getAgentTranscript: ({ id }) => ({ entries: id === AGENT ? gw.entries : [] }),
  };
  gw.fetchImpl = async (url, init) => {
    const method = url.split("/api/")[1];
    const body = JSON.parse(init.body || "{}");
    const result = handlers[method]?.(body);
    return { ok: Boolean(handlers[method]), status: handlers[method] ? 200 : 404, json: async () => ({ result }) };
  };
  return gw;
}

function fakeTransport() {
  const sent = [];
  return {
    sent,
    selfIds: () => [SELF],
    sendText: async (chatId, text, options = {}) => { sent.push({ chatId, text, quoted: options.quoted?.key?.id }); return { id: `B${sent.length}` }; },
    sendFile: async (chatId, file) => { sent.push({ chatId, file: file.filename }); return { id: `B${sent.length}` }; },
    setTyping: async () => {},
    chatName: () => "Test Group",
  };
}

async function setup({ replyTimeoutMs = 5_000, groups, statePath, now } = {}) {
  const dir = statePath ? path.dirname(statePath) : mkdtempSync(path.join(tmpdir(), "wa-late-"));
  const gw = fakeGateway();
  const state = new JsonStateStore(statePath ?? path.join(dir, "bridge-state.json"));
  await state.load();
  const router = new ChatRouter({
    defaultAgent: OTHER_AGENT,
    dms: [{ id: OWNER, agent: AGENT }],
    groups: groups ?? [
      { jid: GROUP, name: "Test Group", agent: AGENT, mode: "mention" },
      { jid: OTHER_GROUP, name: "Other", agent: OTHER_AGENT, mode: "mention" },
    ],
  });
  const log = recordingLog();
  const transport = fakeTransport();
  const grok = new GrokClient("http://127.0.0.1:1340", "t", { fetchImpl: gw.fetchImpl, pollIntervalMs: 10, replyTimeoutMs });
  const bridge = new WhatsAppBridge({
    grok, state, router, guard: new LoopGuard(), transport, log,
    options: { sendDelayMs: 0, stableReplyMs: 40, lateDeliveryPollMs: 10, typingIndicator: false, ...(now ? { now } : {}) },
  });
  return { dir, gw, state, bridge, transport, log, statePath: state.filename };
}

let msgSeq = 0;
function mention(text, chatId = GROUP) {
  msgSeq += 1;
  return {
    id: `M${msgSeq}`,
    chatId,
    sender: { jid: "123456789012345@lid" },
    kind: "text",
    text: `@60111111111 ${text}`,
    mentionedJids: [SELF],
    timestamp: Math.floor(Date.now() / 1000),
    raw: { key: { id: `M${msgSeq}`, remoteJid: chatId } },
  };
}

const texts = (ctx) => ctx.transport.sent.map((item) => item.text);

test("chatFromNonce only accepts nonces this bridge created", () => {
  assert.equal(chatFromNonce(`whatsapp:${GROUP}:3EB0ABC`), GROUP);
  assert.equal(chatFromNonce(`whatsapp:${OWNER}:X:b3`), OWNER);
  assert.equal(chatFromNonce("telegram:123:4"), undefined);
  assert.equal(chatFromNonce("desktop-uuid"), undefined);
  assert.equal(chatFromNonce(undefined), undefined);
});

test("item 1+3: ack is delivered while the turn runs; turn ends when isRunningTurn goes false even though a background task keeps isRunning true", async () => {
  const ctx = await setup({ replyTimeoutMs: 10_000 });
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    setTimeout(() => ctx.gw.reply("On it, running this in the background"), 20);
  };
  const started = Date.now();
  const done = ctx.bridge.handleEvent(mention("check the stock"));
  await waitFor(() => ctx.transport.sent.length === 1);
  assert.equal(ctx.gw.status.isRunningTurn, true, "delivered while the agent was still in its turn (streaming)");
  assert.equal(ctx.transport.sent[0].chatId, GROUP);
  assert.equal(ctx.transport.sent[0].quoted, `M${msgSeq}`, "first streamed part quotes the trigger");
  // The turn ends; a background subagent keeps the agent "running".
  ctx.gw.status = { isRunning: true, isRunningTurn: false, isComposingMessage: false };
  const result = await done;
  assert.equal(result.handled, "prompt");
  assert.ok(Date.now() - started < 3_000, "did not wait for the reply timeout");
  assert.deepEqual(texts(ctx), ["On it, running this in the background"], "delivered exactly once");
  assert.ok(ctx.log.lines.some((line) => /Delivered chat=120363000000000004@g\.us entry=s\d+ parts=1$/.test(line)));
});

test("item 1+3: several SendToUser messages stream out one by one in order", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    setTimeout(() => ctx.gw.reply("one"), 10);
    setTimeout(() => ctx.gw.reply("two"), 120);
    setTimeout(() => { ctx.gw.reply("three"); ctx.gw.status = { isRunning: false, isRunningTurn: false }; }, 240);
  };
  const done = ctx.bridge.handleEvent(mention("go"));
  await waitFor(() => ctx.transport.sent.length === 1);
  assert.deepEqual(texts(ctx), ["one"], "first message went out before the others existed");
  await done;
  assert.deepEqual(texts(ctx), ["one", "two", "three"]);
  assert.equal(ctx.transport.sent[1].quoted, undefined, "only the first part is quoted");
});

test("item 1: legacy gateway (no isRunningTurn) timing out still delivers the ack, sends no error notice, and later messages are forwarded", async () => {
  const ctx = await setup({ replyTimeoutMs: 300 });
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isComposingMessage: false }; // never goes idle, no isRunningTurn
    setTimeout(() => ctx.gw.reply("ack: working on it"), 20);
  };
  const event = mention("long job");
  await ctx.bridge.ingest(event);
  assert.deepEqual(texts(ctx), ["ack: working on it"]);
  assert.equal(texts(ctx).includes(ERROR_NOTICE), false, "no error notice when the agent already answered");
  assert.ok(ctx.log.lines.some((line) => /Turn wait timed out chat=120363000000000004@g\.us delivered=1; later agent messages will still be forwarded/.test(line)));
  assert.equal(ctx.state.getPromptContext(AGENT, `whatsapp:${GROUP}:${event.id}`), undefined, "turn retired");

  // The background task finishes: the agent posts the result in a hidden turn (no prompt entry).
  ctx.gw.status = { isRunning: false };
  ctx.gw.reply("Result: 42 units in stock");
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["ack: working on it", "Result: 42 units in stock"]);
  assert.equal(ctx.transport.sent[1].chatId, GROUP);
  assert.ok(ctx.log.lines.some((line) => /Delivered chat=120363000000000004@g\.us entry=s\d+ parts=1 late=yes/.test(line)));
  // Polling again never duplicates anything.
  await ctx.bridge.pollLateOnce();
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 2);
});

test("item 1: a timeout with nothing sent still posts the error notice", async () => {
  const ctx = await setup({ replyTimeoutMs: 200 });
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true }; };
  await ctx.bridge.ingest(mention("silent long job"));
  assert.deepEqual(texts(ctx), [ERROR_NOTICE]);
});

test("item 2: unsolicited messages go to the chat the agent last served; silent token, desktop turns, other chats and old messages are not forwarded", async () => {
  let clock = Date.now();
  const ctx = await setup({ now: () => clock });
  ctx.gw.onPrompt = () => { ctx.gw.reply("sure"); };
  await ctx.bridge.handleEvent(mention("hello"));
  assert.deepEqual(texts(ctx), ["sure"]);
  await ctx.bridge.pollLateOnce(); // first pass sets the cursor; the turn's entry is not re-sent
  assert.equal(ctx.transport.sent.length, 1);

  ctx.gw.reply("NO_WHATSAPP_REPLY");
  ctx.gw.reply("background result");
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["sure", "background result"], "silent token suppressed, real message delivered");

  // A desktop conversation with the same agent never leaks into WhatsApp.
  ctx.gw.desktopPrompt("private desktop question");
  ctx.gw.reply("private desktop answer");
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 2);
  assert.equal(ctx.transport.sent.every((item) => item.chatId === GROUP), true);

  // Past the window (60 min after the chat's prompt) nothing more is delivered.
  clock += 61 * 60_000;
  ctx.gw.entries.push({ id: "late-x", kind: "send-message", timestampMs: clock, message: { type: "text", content: "too late" } });
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 2);
});

test("item 2: late messages after a WhatsApp prompt follow that prompt's chat, and survive a bridge restart without duplicates", async () => {
  const first = await setup();
  first.gw.onPrompt = () => { first.gw.reply("ack"); };
  await first.bridge.handleEvent(mention("start job"));
  await first.bridge.pollLateOnce();
  first.gw.reply("partial result");
  await first.bridge.pollLateOnce();
  assert.deepEqual(texts(first), ["ack", "partial result"]);

  // Restart: new bridge, same state file, same transcript.
  const second = await setup({ statePath: first.statePath });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0, "nothing re-sent after restart");
  second.gw.reply("final result");
  await second.bridge.pollLateOnce();
  assert.deepEqual(texts(second), ["final result"]);
  assert.equal(second.transport.sent[0].chatId, GROUP);
});

test("item 2: a chat that is no longer configured for the agent never receives late messages", async () => {
  const first = await setup();
  first.gw.onPrompt = () => { first.gw.reply("ack"); };
  await first.bridge.handleEvent(mention("start job"));
  await first.bridge.pollLateOnce();

  // Restart with config where the group now belongs to another agent.
  const second = await setup({
    statePath: first.statePath,
    groups: [{ jid: GROUP, name: "Test Group", agent: OTHER_AGENT, mode: "mention" }],
  });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  second.gw.reply("result for a chat that moved");
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0);
  assert.ok(second.log.lines.some((line) => /Late message not delivered .*reason=chat-not-configured-for-agent/.test(line)));
});

test("item 2: the follower leaves an agent alone while its live turn is running (no double delivery, order kept)", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    setTimeout(() => ctx.gw.reply("a"), 10);
    setTimeout(() => { ctx.gw.reply("b"); ctx.gw.status = { isRunning: false, isRunningTurn: false }; }, 150);
  };
  const lateLoop = new AbortController();
  // Seed a served record so the follower is polling during the turn.
  await ctx.state.setLastServed(AGENT, { chatId: GROUP, at: Date.now() });
  const loop = ctx.bridge.runLateDelivery({ signal: lateLoop.signal });
  await ctx.bridge.handleEvent(mention("go"));
  ctx.gw.reply("c");
  await waitFor(() => ctx.transport.sent.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 80));
  lateLoop.abort();
  await loop;
  assert.deepEqual(texts(ctx), ["a", "b", "c"]);
});

test("item 3: recovered turn after a restart does not resend entries delivered before it (legacy per-turn keys)", async () => {
  const ctx = await setup();
  const nonce = `whatsapp:${GROUP}:OLD1`;
  ctx.gw.entries.push({ id: "t3u", kind: "message", role: "user", clientNonce: nonce, timestampMs: Date.now() });
  ctx.gw.entries.push({ id: "t3s0", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "old ack" } });
  ctx.gw.entries.push({ id: "t3s1", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "new part" } });
  await ctx.state.completeDeliveryProgress(`wa:${AGENT}:${nonce}:t3s0`, { nextPart: 1 });
  await ctx.state.setPromptContext(AGENT, nonce, { contextKey: nonce, clientNonce: nonce, origin: "whatsapp", chatId: GROUP, createdAt: Date.now() - 15 * 60_000 });
  await ctx.bridge.recoverPending();
  assert.deepEqual(texts(ctx), ["new part"]);
});
