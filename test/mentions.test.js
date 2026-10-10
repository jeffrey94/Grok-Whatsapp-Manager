import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatParticipants, findMentionTokens, resolveMentions } from "../src/whatsapp/mentions.js";
import { BaileysTransport } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, recordingLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";

const GROUP = "120363000000000001@g.us";
const STAFF_PN = "60100000001";
const BORROWER_PN = "60100000002";
const STRANGER_PN = "60100000009";

const pnGroup = {
  id: GROUP,
  addressingMode: "pn",
  participants: [
    { id: `${STAFF_PN}@s.whatsapp.net`, lid: "11111111111111@lid" },
    { id: `${BORROWER_PN}@s.whatsapp.net` },
  ],
};

const lidGroup = {
  id: GROUP,
  addressingMode: "lid",
  participants: [
    { id: "11111111111111@lid", phoneNumber: `${STAFF_PN}@s.whatsapp.net` },
    { id: "22222222222222@lid" }, // phone number hidden
  ],
};

test("finds @digits and @+digits tokens, ignores e-mails, short numbers and handles", () => {
  assert.deepEqual(findMentionTokens(`@${STAFF_PN} and @+${BORROWER_PN}, (@${STAFF_PN})`), [STAFF_PN, BORROWER_PN]);
  assert.deepEqual(findMentionTokens(`mail a@${STAFF_PN}.com, @12345, @hiowner, RM1,000 @ 5%`), []);
  assert.deepEqual(findMentionTokens(`@${STAFF_PN}x`), []);
  assert.deepEqual(findMentionTokens(undefined), []);
});

test("PN-addressed group: phone JIDs, '+' normalised, strangers untouched", async () => {
  const text = `@+${STAFF_PN}, your relationship manager, will follow up. cc @${BORROWER_PN} and @${STRANGER_PN}`;
  const result = await resolveMentions(text, { chatId: GROUP, meta: pnGroup });
  assert.equal(result.text, `@${STAFF_PN}, your relationship manager, will follow up. cc @${BORROWER_PN} and @${STRANGER_PN}`);
  assert.deepEqual(result.mentions, [`${STAFF_PN}@s.whatsapp.net`, `${BORROWER_PN}@s.whatsapp.net`]);
});

test("LID-addressed group: phone token rewritten to the participant's LID", async () => {
  const result = await resolveMentions(`@${STAFF_PN} will follow up`, { chatId: GROUP, meta: lidGroup });
  assert.equal(result.text, "@11111111111111 will follow up");
  assert.deepEqual(result.mentions, ["11111111111111@lid"]);
});

test("LID group with hidden phone: resolved via Baileys' LID map or configured member ids, only if a participant", async () => {
  const viaMap = await resolveMentions(`hi @${BORROWER_PN}`, {
    chatId: GROUP,
    meta: lidGroup,
    lookupLid: async (pn) => (pn === `${BORROWER_PN}@s.whatsapp.net` ? "22222222222222:3@lid" : null),
  });
  assert.equal(viaMap.text, "hi @22222222222222");
  assert.deepEqual(viaMap.mentions, ["22222222222222@lid"]);

  const viaConfig = await resolveMentions(`hi @${BORROWER_PN}`, { chatId: GROUP, meta: lidGroup, knownIdSets: [[`+${BORROWER_PN}`, "22222222222222@lid"]] });
  assert.deepEqual(viaConfig.mentions, ["22222222222222@lid"]);

  // The map knows the stranger, but they are not in the group: no mention.
  const stranger = await resolveMentions(`hi @${STRANGER_PN}`, { chatId: GROUP, meta: lidGroup, lookupLid: async () => "33333333333333@lid" });
  assert.deepEqual(stranger, { text: `hi @${STRANGER_PN}`, mentions: [] });

  const broken = await resolveMentions(`hi @${BORROWER_PN}`, { chatId: GROUP, meta: lidGroup, lookupLid: async () => { throw new Error("boom"); } });
  assert.deepEqual(broken.mentions, []);
});

test("an agent that already wrote the LID digits still gets a real mention", async () => {
  const result = await resolveMentions("ping @22222222222222", { chatId: GROUP, meta: lidGroup });
  assert.deepEqual(result, { text: "ping @22222222222222", mentions: ["22222222222222@lid"] });
});

test("addressing mode inferred from participant ids when metadata has none", async () => {
  const { addressingMode, ...meta } = lidGroup;
  assert.equal(addressingMode, "lid");
  const result = await resolveMentions(`@${STAFF_PN}`, { chatId: GROUP, meta });
  assert.deepEqual(result.mentions, ["11111111111111@lid"]);
});

test("DMs: only the other person can be mentioned; no metadata means no mentions", async () => {
  const dm = await resolveMentions(`@${STAFF_PN} @${STRANGER_PN}`, { chatId: `${STAFF_PN}@s.whatsapp.net` });
  assert.deepEqual(dm.mentions, [`${STAFF_PN}@s.whatsapp.net`]);
  const lidDm = await resolveMentions(`@${STAFF_PN}`, { chatId: "11111111111111@lid", lookupLid: async () => "11111111111111@lid" });
  assert.deepEqual(lidDm, { text: "@11111111111111", mentions: ["11111111111111@lid"] });
  const noMeta = await resolveMentions(`@${STAFF_PN}`, { chatId: GROUP });
  assert.deepEqual(noMeta, { text: `@${STAFF_PN}`, mentions: [] });
  assert.deepEqual(chatParticipants({ chatId: "nonsense" }), []);
});

function transportWith(socketGroups, groups = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-mentions-"));
  const authDir = path.join(dir, "auth");
  writePairedCreds(authDir);
  const makeSocket = fakeSocketFactory({ groups: socketGroups });
  const log = recordingLog();
  const transport = new BaileysTransport({
    authDir, groups, log, status: new StatusFile(path.join(dir, "state", "status.json")),
    onEvent: () => {}, makeSocket, authStateFactory: fakeAuthStateFactory(), backoff: { baseMs: 5, maxMs: 20 },
  });
  return { transport, makeSocket, log };
}

test("transport sendText attaches mentions from cached group metadata (fake socket, nothing sent anywhere)", async () => {
  const { transport, makeSocket, log } = transportWith({ [GROUP]: lidGroup }, [{ jid: GROUP }]);
  transport.start();
  await waitFor(() => makeSocket.sockets.length === 1);
  const sock = makeSocket.sockets[0];
  sock.open();
  await waitFor(() => transport.connected && transport.groupMeta.has(GROUP));
  assert.ok(log.lines.some((line) => line.includes(`Group ${GROUP} addressing=lid participants=2`)));

  await transport.sendText(GROUP, `@${STAFF_PN}, your relationship manager, will follow up on this.`);
  assert.deepEqual(sock.sent.at(-1).content, { text: "@11111111111111, your relationship manager, will follow up on this.", mentions: ["11111111111111@lid"] });

  await transport.sendText(GROUP, `Hello @${STRANGER_PN}`);
  assert.deepEqual(sock.sent.at(-1).content, { text: `Hello @${STRANGER_PN}` });

  await transport.sendText(GROUP, "plain text, no tags");
  assert.deepEqual(sock.sent.at(-1).content, { text: "plain text, no tags" });
  await transport.stop();
});

test("transport fetches group metadata when not cached, and never throws on lookup errors", async () => {
  const { transport, makeSocket } = transportWith({});
  transport.start();
  await waitFor(() => makeSocket.sockets.length === 1);
  const sock = makeSocket.sockets[0];
  sock.groupMetadata = async () => pnGroup;
  sock.open();
  await waitFor(() => transport.connected);
  await transport.sendText(GROUP, `@${BORROWER_PN} hi`);
  assert.deepEqual(sock.sent.at(-1).content, { text: `@${BORROWER_PN} hi`, mentions: [`${BORROWER_PN}@s.whatsapp.net`] });

  transport.groupMeta.clear();
  sock.groupMetadata = async () => { throw new Error("offline"); };
  await transport.sendText(GROUP, `@${BORROWER_PN} hi`);
  assert.deepEqual(sock.sent.at(-1).content, { text: `@${BORROWER_PN} hi` });
  await transport.stop();
});
