import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertLoopbackUrl, gatewayToken, loadConfig, parseConfig } from "../src/config.js";

const dir = mkdtempSync(path.join(tmpdir(), "wa-config-"));
const tokenFile = path.join(dir, "gateway.json");
writeFileSync(tokenFile, JSON.stringify({ gatewayToken: "secret-token" }), { mode: 0o600 });

const base = {
  gateway: { url: "http://127.0.0.1:1340", tokenFile },
  defaultAgent: "agent-default",
  dms: ["+60 12-345 6789"],
  groups: [{ jid: "120363000000000001@g.us", agent: "agent-quotes" }],
};

test("gateway must be loopback", () => {
  assert.equal(assertLoopbackUrl("http://127.0.0.1:1340/"), "http://127.0.0.1:1340");
  assert.equal(assertLoopbackUrl("http://localhost:1340"), "http://localhost:1340");
  assert.throws(() => assertLoopbackUrl("http://10.0.0.5:1340"), /loopback/);
  assert.throws(() => assertLoopbackUrl("https://evil.example.com"), /loopback/);
  assert.throws(() => parseConfig({ ...base, gateway: { url: "http://192.168.1.2:1340", tokenFile } }, { readToken: false }), /loopback/);
});

test("gateway token file must be mode 600 and not a symlink", () => {
  assert.equal(gatewayToken(tokenFile), "secret-token");
  const open = path.join(dir, "open.json");
  writeFileSync(open, JSON.stringify({ token: "t" }));
  chmodSync(open, 0o644);
  assert.throws(() => gatewayToken(open), /must not be readable by group or others/);
  const link = path.join(dir, "link.json");
  symlinkSync(tokenFile, link);
  assert.throws(() => gatewayToken(link), /ELOOP|symbolic/);
});

test("parses allowlist, groups, limits and defaults", () => {
  const config = parseConfig({ ...base, limits: { outboundPerChatPerMinute: 3 } }, { baseDir: dir });
  assert.equal(config.gatewayToken, "secret-token");
  assert.deepEqual(config.dms, [{ id: "60123456789@s.whatsapp.net", agent: undefined, name: undefined }]);
  assert.equal(config.groups[0].mode, "mention");
  assert.equal(config.limits.outboundPerChatPerMinute, 3);
  assert.equal(config.limits.outboundGlobalPerMinute, 20);
  assert.equal(config.authDir, path.join(dir, "auth"));
  assert.ok(config.silentTokens.includes("NO_WHATSAPP_REPLY"));
});

test("rejects placeholders, empty allowlist, duplicate groups, bad modes and unknown limits", () => {
  const opts = { readToken: false };
  assert.throws(() => parseConfig({ ...base, defaultAgent: "<default-agent-id>" }, opts), /defaultAgent/);
  assert.throws(() => parseConfig({ ...base, dms: [], groups: [] }, opts), /allowlist is empty/);
  assert.throws(() => parseConfig({ ...base, groups: [base.groups[0], base.groups[0]] }, opts), /listed twice/);
  assert.throws(() => parseConfig({ ...base, groups: [{ ...base.groups[0], mode: "loud" }] }, opts), /mode/);
  assert.throws(() => parseConfig({ ...base, groups: [{ jid: "120363000000000001@g.us" }] }, opts), /one Grok agent/);
  assert.throws(() => parseConfig({ ...base, dms: ["not-a-number"] }, opts), /dms entry/);
  assert.throws(() => parseConfig({ ...base, limits: { sendAnything: 1 } }, opts), /unknown limits/);
});

test("config file itself must be mode 600", () => {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(base), { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => loadConfig(file), /config file must not be readable/);
  chmodSync(file, 0o600);
  assert.equal(loadConfig(file).defaultAgent, "agent-default");
});

test("committed quotes sample config parses once its placeholders are filled, and refuses them unfilled", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../config.example.quotes.json", import.meta.url), "utf8");
  assert.throws(() => parseConfig(JSON.parse(text), { readToken: false }), /defaultAgent|agent id|not a/);
  const filled = text
    .replace("<path-to-mode-600-gateway.json>", tokenFile)
    .replace("<default-agent-id>", "agent-default")
    .replace("<acme-quotation-bot-agent-id>", "agent-quotes")
    .replace("<acme-quotes-group-id>", "120363000000000099")
    .replace("+<owner-phone-digits>", "+60123456789")
    .replace("+<staff-1-phone-digits>", "+60100000001")
    .replace("<staff-1-lid-digits>", "200000000000001");
  const { _comment, ...values } = JSON.parse(filled);
  assert.doesNotMatch(JSON.stringify(values), /<[^>]+>/);
  const config = parseConfig(JSON.parse(filled), { baseDir: dir, readToken: false });
  const [group] = config.groups;
  assert.equal(group.jid, "120363000000000099@g.us");
  assert.equal(group.agent, "agent-quotes");
  assert.equal(group.mode, "mention");
  assert.deepEqual(group.keywords, ["报价", "quote", "quotation"]);
  assert.equal(config.replyTimeoutMs, 600000);
});
