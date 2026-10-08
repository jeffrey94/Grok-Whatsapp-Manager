import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage } from "../src/whatsapp/normalize.js";

const now = 1_790_000_000;

test("group text with mention, quote, LID participant and PN alt", () => {
  const { event } = normalizeMessage({
    key: { remoteJid: "120363000000000001@g.us", id: "M1", participant: "123456789012345@lid", participantAlt: "60123456789@s.whatsapp.net", fromMe: false },
    pushName: "Ali",
    messageTimestamp: now,
    message: {
      senderKeyDistributionMessage: { groupId: "x" },
      extendedTextMessage: { text: "@6011 quote", contextInfo: { mentionedJid: ["60111111111:3@s.whatsapp.net"], stanzaId: "B1", participant: "99999999999999@lid", isForwarded: true } },
    },
  });
  assert.equal(event.chatId, "120363000000000001@g.us");
  assert.equal(event.isGroup, true);
  assert.equal(event.kind, "text");
  assert.equal(event.text, "@6011 quote");
  assert.deepEqual(event.sender, { jid: "123456789012345@lid", alt: "60123456789@s.whatsapp.net", pn: "60123456789@s.whatsapp.net", lid: "123456789012345@lid", name: "Ali" });
  assert.deepEqual(event.mentionedJids, ["60111111111@s.whatsapp.net"]);
  assert.deepEqual(event.quoted, { id: "B1", participant: "99999999999999@lid" });
  assert.equal(event.forwarded, true);
  assert.equal(event.timestamp, now);
  assert.ok(event.raw, "raw message kept for media download/quoting");
  assert.equal(Object.keys(event).includes("raw"), false, "raw is non-enumerable (never serialized)");
});

test("voice note (ptt) inside an ephemeral wrapper", () => {
  const { event } = normalizeMessage({
    key: { remoteJid: "60123456789@s.whatsapp.net", id: "V1" },
    message: { ephemeralMessage: { message: { audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus", fileLength: 4321, seconds: 7 } } } },
  });
  assert.equal(event.kind, "voice");
  assert.deepEqual(event.media, { mimetype: "audio/ogg; codecs=opus", filename: "whatsapp-voice-V1.ogg", size: 4321, seconds: 7 });
});

test("document with caption wrapper and image", () => {
  const doc = normalizeMessage({
    key: { remoteJid: "60123456789@s.whatsapp.net", id: "D1" },
    message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "price list.pdf", mimetype: "application/pdf", caption: "latest prices" } } } },
  }).event;
  assert.equal(doc.kind, "document");
  assert.equal(doc.text, "latest prices");
  assert.equal(doc.media.filename, "price list.pdf");
  const image = normalizeMessage({ key: { remoteJid: "60123456789@s.whatsapp.net", id: "I1" }, message: { imageMessage: { caption: "site", mimetype: "image/jpeg" } } }).event;
  assert.equal(image.kind, "image");
  assert.equal(image.text, "site");
});

test("status, newsletters, broadcasts, reactions, protocol and album headers are skipped", () => {
  const skip = (remoteJid, message) => normalizeMessage({ key: { remoteJid, id: "x" }, message }).skip;
  assert.equal(skip("status@broadcast", { conversation: "hi" }), "status-broadcast");
  assert.equal(skip("1234@newsletter", { conversation: "hi" }), "newsletter");
  assert.equal(skip("1234@broadcast", { conversation: "hi" }), "broadcast-list");
  assert.equal(skip("60123456789@s.whatsapp.net", { reactionMessage: { text: "👍" } }), "type:reactionMessage");
  assert.equal(skip("60123456789@s.whatsapp.net", { protocolMessage: { type: 0 } }), "type:protocolMessage");
  assert.equal(skip("120363000000000001@g.us", { albumMessage: { expectedImageCount: 3 } }), "type:albumMessage");
  assert.equal(normalizeMessage({ key: {} }).skip, "no-remote-jid");
});

test("own messages and Meta AI are flagged", () => {
  assert.equal(normalizeMessage({ key: { remoteJid: "60123456789@s.whatsapp.net", id: "o", fromMe: true }, message: { conversation: "x" } }).event.fromMe, true);
  assert.equal(normalizeMessage({ key: { remoteJid: "120363000000000001@g.us", id: "b", participant: "867051314767696@bot" }, message: { conversation: "x" } }).event.isBot, true);
});
