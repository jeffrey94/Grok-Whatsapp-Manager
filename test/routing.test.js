import test from "node:test";
import assert from "node:assert/strict";
import { ChatRouter, bareJid, normalizeGroupJid, normalizeUserId } from "../src/core/routing.js";

const router = new ChatRouter({
  defaultAgent: "agent-default",
  dms: [
    { id: "60123456789@s.whatsapp.net" },
    { id: "555000111222333@lid", agent: "agent-lid-owner" },
  ],
  groups: [
    { jid: "120363000000000001@g.us", agent: "agent-quotes", mode: "mention", keywords: ["quote"] },
    { jid: "120363000000000002@g.us", agent: "agent-jobs", mode: "all", allowSenders: ["60170000001"] },
  ],
  ignoreSenders: ["60199999999"],
});

test("id normalization", () => {
  assert.equal(normalizeUserId("+60 12-345 6789"), "60123456789@s.whatsapp.net");
  assert.equal(normalizeUserId("60123456789:12@s.whatsapp.net"), "60123456789@s.whatsapp.net");
  assert.equal(normalizeUserId("123@lid"), undefined, "too short");
  assert.equal(normalizeUserId("12345678@lid"), "12345678@lid");
  assert.equal(normalizeUserId("abc"), undefined);
  assert.equal(normalizeGroupJid("120363000000000001@g.us"), "120363000000000001@g.us");
  assert.equal(normalizeGroupJid("60123456789@s.whatsapp.net"), undefined);
  assert.equal(bareJid("60123:4@c.us"), "60123@s.whatsapp.net");
});

test("DM allowlisted by phone routes to default agent", () => {
  const route = router.route({ chatId: "60123456789@s.whatsapp.net", sender: { jid: "60123456789@s.whatsapp.net" } });
  assert.deepEqual(route, { ok: true, kind: "dm", agent: "agent-default", dmId: "60123456789@s.whatsapp.net", queueKey: "agent:agent-default" });
});

test("agentForChat reports the configured agent only for chats in config", () => {
  assert.equal(router.agentForChat("60123456789@s.whatsapp.net"), "agent-default");
  assert.equal(router.agentForChat("555000111222333@lid"), "agent-lid-owner");
  assert.equal(router.agentForChat("60999999999@s.whatsapp.net"), undefined);
  assert.equal(router.agentForChat("120363999999999999@g.us"), undefined);
  assert.equal(router.agentForChat("120363000000000001@g.us"), "agent-quotes");
});

test("DM arriving as LID is matched through the alternate PN id", () => {
  const route = router.route({ chatId: "777000111222333@lid", sender: { jid: "777000111222333@lid", alt: "60123456789@s.whatsapp.net", pn: "60123456789@s.whatsapp.net" } });
  assert.equal(route.ok, true);
  assert.equal(route.agent, "agent-default");
});

test("DM allowlisted by LID can carry its own agent", () => {
  const route = router.route({ chatId: "555000111222333@lid", sender: { jid: "555000111222333@lid" } });
  assert.equal(route.agent, "agent-lid-owner");
});

test("unknown DM, unknown group, ignored sender and broadcast are rejected", () => {
  assert.equal(router.route({ chatId: "60100000000@s.whatsapp.net", sender: { jid: "60100000000@s.whatsapp.net" } }).reason, "dm-not-allowlisted");
  assert.equal(router.route({ chatId: "120363999999999999@g.us", sender: { jid: "1@lid" } }).reason, "group-not-allowlisted");
  assert.equal(router.route({ chatId: "120363000000000001@g.us", sender: { jid: "60199999999@s.whatsapp.net" } }).reason, "ignored-sender");
  assert.equal(router.route({ chatId: "status@broadcast", sender: {} }).reason, "unsupported-chat-type");
});

test("group maps to exactly one agent; allowSenders restricts who can prompt", () => {
  const quotes = router.route({ chatId: "120363000000000001@g.us", sender: { jid: "11111111111@lid" } });
  assert.equal(quotes.kind, "group");
  assert.equal(quotes.agent, "agent-quotes");
  assert.equal(quotes.group.mode, "mention");
  assert.equal(quotes.queueKey, "agent:agent-quotes");
  assert.equal(router.route({ chatId: "120363000000000002@g.us", sender: { jid: "22222222222@lid" } }).reason, "sender-not-allowed-in-group");
  const tech = router.route({ chatId: "120363000000000002@g.us", sender: { jid: "22222222222@lid", alt: "60170000001@s.whatsapp.net" } });
  assert.equal(tech.agent, "agent-jobs");
  assert.equal(tech.group.mode, "all");
});
