#!/usr/bin/env node
/**
 * LIVE-AGENT sample run (NOT part of `npm test`): fake WhatsApp socket + the
 * REAL local Grok gateway. It wakes the agent mapped in the sample config, so
 * it only runs with --yes-wake-real-agent. Nothing is sent to WhatsApp: the
 * socket is test/helpers/fake-baileys.js and never opens a connection.
 *
 *   node scripts/sample-quotes-live.mjs --config config.sample-quotes.json \
 *     --out /workspace/whatsapp-sample --commands /tmp/wa-cmds.jsonl --yes-wake-real-agent
 *
 * Commands are JSON lines appended to --commands, processed one at a time:
 *   {"text":"@bot 报价: ...","mention":true}            staff message (first allowSenders entry)
 *   {"text":"确认","replyTo":"last"}                      reply to the bot's last text message
 *   {"text":"lunch?","from":"stranger"}                  someone not on allowSenders
 *   {"cmd":"quit"}
 * Output: <out>/transcript.md (what the group would see), <out>/run.json,
 * and every document the bridge would post, saved under its WhatsApp file name.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WhatsAppBridge } from "../src/bridge.js";
import { parseArgs } from "../src/cli-args.js";
import { loadConfig } from "../src/config.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter, normalizeUserId } from "../src/core/routing.js";
import { GrokClient } from "../src/grok-client.js";
import { JsonStateStore } from "../src/state.js";
import { BaileysTransport } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, waitFor, writePairedCreds } from "../test/helpers/fake-baileys.js";

const args = parseArgs(process.argv.slice(2));
if (!args["yes-wake-real-agent"]) {
  console.error("Refusing: this wakes a real Grok agent through the local gateway. Pass --yes-wake-real-agent.");
  process.exit(2);
}
process.umask(0o077);
const config = loadConfig(args.config ?? "config.sample-quotes.json");
const outDir = path.resolve(args.out ?? "state/sample-run");
const commandsPath = path.resolve(args.commands ?? path.join(outDir, "commands.jsonl"));
mkdirSync(outDir, { recursive: true });
if (!existsSync(commandsPath)) writeFileSync(commandsPath, "");

const group = config.groups[0];
if (!group) throw new Error("sample config needs one group");
const staffJid = normalizeUserId(group.allowSenders[0] ?? "+60100000001");
const BOT = { pn: "60111111111@s.whatsapp.net", lid: "99999999999999@lid", name: "Acme Bot" };
const STAFF = { lid: "200000000000001@lid", pn: staffJid, name: "Ah Meng (DEMO staff)" };
const STRANGER = { lid: "200000000000099@lid", pn: "60100000099@s.whatsapp.net", name: "Random member (DEMO)" };

const dir = mkdtempSync(path.join(tmpdir(), "wa-sample-live-"));
const authDir = path.join(dir, "auth");
writePairedCreds(authDir, "60111111111:5@s.whatsapp.net");
const lines = [];
const log = {
  debug() {},
  info: (m) => { lines.push(`info ${m}`); console.log(`[bridge] ${m}`); },
  log: (m) => { lines.push(`info ${m}`); console.log(`[bridge] ${m}`); },
  warn: (m) => { lines.push(`warn ${m}`); console.log(`[bridge WARN] ${m}`); },
  error: (m) => { lines.push(`error ${m}`); console.log(`[bridge ERROR] ${m}`); },
};

const state = new JsonStateStore(path.join(dir, "state", "bridge-state.json"));
await state.load();
const router = new ChatRouter(config);
const guard = new LoopGuard(config.limits);
const makeSocket = fakeSocketFactory({
  user: { id: "60111111111:5@s.whatsapp.net", lid: "99999999999999:5@lid" },
  groups: { [group.jid]: { id: group.jid, subject: group.name } },
});
let bridge;
const transport = new BaileysTransport({
  authDir,
  groups: config.groups,
  log,
  status: new StatusFile(path.join(dir, "state", "status.json")),
  onEvent: (event) => bridge.ingest(event),
  makeSocket,
  authStateFactory: fakeAuthStateFactory(),
  downloader: async () => { throw new Error("no media in this sample"); },
});
const grok = new GrokClient(config.gatewayUrl, config.gatewayToken, { pollIntervalMs: 1_000, replyTimeoutMs: config.replyTimeoutMs });

// Record what the agent actually wrote (before WhatsApp formatting) for the report.
const rawReplies = [];
const realWait = grok.waitForReply.bind(grok);
grok.waitForReply = async (agentId, nonce, options) => {
  const reply = await realWait(agentId, nonce, options);
  rawReplies.push({ nonce, entries: (reply.entries ?? []).map((e) => ({ id: e.id, type: e.message?.type, content: e.message?.content, file: e.message?.file_name ?? e.message?.url })) });
  return reply;
};
const prompts = [];
const realSend = grok.sendPrompt.bind(grok);
grok.sendPrompt = async (agentId, prompt, nonce, options) => {
  prompts.push({ agentId, nonce, prompt });
  return realSend(agentId, prompt, nonce, options);
};

bridge = new WhatsAppBridge({
  grok, state, router, guard, transport, log,
  options: {
    silentTokens: config.silentTokens,
    maxMessageAgeSec: config.maxMessageAgeSec,
    sendDelayMs: config.sendDelayMs,
    typingIndicator: config.typingIndicator,
    replyTimeoutMs: config.replyTimeoutMs,
    stableReplyMs: config.stableReplyMs,
    bundling: config.bundling,
  },
});
const results = new Map();
const realHandle = bridge.handleEvent.bind(bridge);
bridge.handleEvent = async (event, options) => {
  const result = await realHandle(event, options);
  const primary = event.bundled?.[0] ?? event;
  results.set(primary.id, result);
  return result;
};

const hhmm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kuala_Lumpur" });
void transport.start();
await waitFor(() => makeSocket.sockets.length === 1, 10_000);
const sock = makeSocket.sockets[0];
const sentAt = [];
const realSendMessage = sock.sendMessage.bind(sock);
sock.sendMessage = async (...a) => { sentAt.push(hhmm()); return realSendMessage(...a); };
sock.open();
await waitFor(() => transport.connected && transport.chatName(group.jid) === group.name, 10_000);
console.log(`[sample] fake WhatsApp connected; group "${group.name}" (${group.jid}) -> agent ${group.agent}`);

const transcript = [];
const botTexts = new Map();
let lastBotTextId;
let sentSeen = 0;
function collectSent() {
  for (; sentSeen < sock.sent.length; sentSeen += 1) {
    const { jid, content, options } = sock.sent[sentSeen];
    const id = `BOTMSG${sentSeen + 1}`;
    const quotedId = options?.quoted?.key?.id;
    const at = sentAt[sentSeen] ?? hhmm();
    if (content.text !== undefined) {
      botTexts.set(id, content.text);
      lastBotTextId = id;
      transcript.push({ at, dir: "out", id, chat: jid, quotedId, text: content.text });
    } else if (content.document) {
      const file = path.join(outDir, path.basename(content.fileName));
      writeFileSync(file, content.document);
      transcript.push({ at, dir: "out", id, chat: jid, quotedId, document: { fileName: content.fileName, mimetype: content.mimetype, bytes: content.document.length, savedTo: file } });
    } else if (content.image) {
      transcript.push({ at, dir: "out", id, chat: jid, quotedId, image: { bytes: content.image.length } });
    }
    console.log(`[sample] BOT -> ${jid}: ${JSON.stringify(transcript.at(-1)).slice(0, 400)}`);
  }
}

let counter = 0;
function incoming(cmd) {
  counter += 1;
  const who = cmd.from === "stranger" ? STRANGER : STAFF;
  const id = `STAFFMSG${counter}`;
  const replyId = cmd.replyTo === "last" ? lastBotTextId : cmd.replyTo;
  const contextInfo = {};
  if (cmd.mention) contextInfo.mentionedJid = [BOT.lid];
  if (replyId) Object.assign(contextInfo, { stanzaId: replyId, participant: BOT.lid, quotedMessage: { conversation: botTexts.get(replyId) ?? "" } });
  const text = String(cmd.text).replace(/^@bot\b/, `@${BOT.lid.split("@")[0]}`);
  const message = {
    key: { remoteJid: group.jid, id, participant: who.lid, participantAlt: who.pn, fromMe: false },
    pushName: who.name,
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { extendedTextMessage: { text, ...(Object.keys(contextInfo).length ? { contextInfo } : {}) } },
  };
  transcript.push({ at: hhmm(), dir: "in", id, from: who.name, fromPhone: `+${who.pn.split("@")[0]}`, text: String(cmd.text).replace(/^@bot\b/, "@Acme Bot"), quotedId: replyId, mention: Boolean(cmd.mention) });
  return { id, message };
}

function writeOutputs() {
  const md = ["# WhatsApp group view (sample, fake socket, real Acme Quotation Bot)", "",
    `Group: **${group.name}** (fake id \`${group.jid}\`) · agent \`${group.agent}\` · mode \`${group.mode}\` · keywords ${JSON.stringify(group.keywords)}`,
    "Nothing here was sent over WhatsApp; the socket is the offline fake. Times are MYT.", ""];
  const label = (qid) => {
    if (!qid) return "";
    const target = transcript.find((t) => t.id === qid);
    const preview = (target?.text ?? "").split("\n")[0].slice(0, 50);
    return `  ↪ _replying to ${target?.dir === "out" ? "Acme Bot" : target?.from ?? qid}: "${preview}…"_\n`;
  };
  for (const t of transcript) {
    if (t.dir === "in") {
      md.push(`**[${t.at}] ${t.from}** (${t.fromPhone})`);
      md.push(label(t.quotedId) + "> " + t.text.split("\n").join("\n> "));
      md.push(`_bridge: ${t.outcome ?? "…"}_`, "");
    } else if (t.text !== undefined) {
      md.push(`**[${t.at}] Acme Bot**`);
      md.push(label(t.quotedId) + "```\n" + t.text + "\n```", "");
    } else if (t.document) {
      md.push(`**[${t.at}] Acme Bot** 📄 document \`${t.document.fileName}\` (${t.document.mimetype}, ${t.document.bytes} bytes)`, "");
    }
  }
  writeFileSync(path.join(outDir, "transcript.md"), md.join("\n") + "\n");
  writeFileSync(path.join(outDir, "run.json"), JSON.stringify({ transcript, prompts, rawReplies, sent: sock.sent.map((s) => ({ jid: s.jid, keys: Object.keys(s.content), quoted: s.options?.quoted?.key?.id })) }, null, 1));
}

let processed = 0;
let stop = false;
while (!stop) {
  const cmds = readFileSync(commandsPath, "utf8").split("\n").filter((l) => l.trim());
  for (; processed < cmds.length && !stop; processed += 1) {
    const cmd = JSON.parse(cmds[processed]);
    if (cmd.cmd === "quit") { stop = true; break; }
    const { id, message } = incoming(cmd);
    console.log(`[sample] STAFF -> group: ${JSON.stringify(cmd)}`);
    sock.deliver([message]);
    const entry = transcript.find((t) => t.id === id);
    const started = Date.now();
    const linesBefore = lines.length;
    await new Promise((r) => setTimeout(r, 300));
    await bridge.drain();
    await new Promise((r) => setTimeout(r, 200));
    await bridge.drain();
    collectSent();
    const result = results.get(id);
    const dropLine = lines.filter((l) => l.includes(`msg=${id}`) && /Drop inbound/.test(l)).at(-1);
    entry.outcome = result
      ? (result.dropped ? `ignored (${result.dropped})` : `sent to agent → ${sock.sent.length ? "delivered" : ""}`)
      : dropLine ? `ignored (${/reason=(\S+)/.exec(dropLine)?.[1]})` : "ignored";
    if (result?.handled === "prompt") {
      const silent = lines.slice(linesBefore).some((l) => l.startsWith("info Silent reply"));
      const replies = transcript.filter((t) => t.dir === "out" && transcript.indexOf(t) > transcript.indexOf(entry)).length;
      entry.outcome = `sent to agent; ${replies ? `${replies} bot message(s) posted` : silent ? `agent replied ${JSON.stringify(rawReplies.at(-1)?.entries?.at(-1)?.content ?? "silent token")} → nothing posted` : "nothing posted"} (${Math.round((Date.now() - started) / 1000)}s)`;
    }
    console.log(`[sample] outcome ${id}: ${entry.outcome}`);
    writeOutputs();
  }
  if (!stop) await new Promise((r) => setTimeout(r, 1_000));
}
await bridge.drain();
collectSent();
writeOutputs();
await transport.stop();
console.log(`[sample] done. transcript: ${path.join(outDir, "transcript.md")}`);
process.exit(0);
