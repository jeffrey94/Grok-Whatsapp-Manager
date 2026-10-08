import {
  getContentType,
  isJidBot,
  isJidBroadcast,
  isJidMetaAI,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
} from "baileys";
import { bareJid } from "../core/routing.js";

/**
 * Turn a Baileys WAMessage into the bridge's platform-neutral event, or explain
 * why it is skipped. Pure function (no socket), so it is tested with mock
 * Baileys messages.
 *
 * event = {
 *   id, chatId, isGroup, fromMe, timestamp,
 *   sender: { jid, alt, pn, lid, name },
 *   kind: "text"|"image"|"video"|"voice"|"audio"|"document"|"sticker"|"unsupported",
 *   text, media?: { mimetype, filename, size, seconds },
 *   mentionedJids: string[], quoted?: { id, participant }, forwarded, isBot, album,
 * }
 * The original WAMessage is attached as a non-enumerable `raw` property
 * (needed for media download and quoting; never logged or persisted).
 */

const SKIP_TYPES = new Set([
  "protocolMessage", // revokes, edits, ephemeral settings, history sync notices
  "reactionMessage",
  "encReactionMessage",
  "pollUpdateMessage",
  "albumMessage", // album header; the photos follow as their own messages
  "keepInChatMessage",
  "pinInChatMessage",
  "callLogMesssage",
  "callLogMessage",
  "scheduledCallCreationMessage",
  "senderKeyDistributionMessage",
  "messageHistoryBundle",
  "botInvokeMessage",
]);

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickIds(primary, alt) {
  const ids = [bareJid(primary), bareJid(alt)].filter(Boolean);
  return {
    jid: ids[0],
    alt: ids[1],
    pn: ids.find((id) => id.endsWith("@s.whatsapp.net")),
    lid: ids.find((id) => id.endsWith("@lid")),
  };
}

/** Meta AI (@bot) and WhatsApp's official bot numbers, per Baileys' own helpers. */
function isBotJid(jid) {
  if (typeof jid !== "string") return false;
  return Boolean(isJidMetaAI(jid) || isJidBot(jid) || isJidBot(jid.replace(/@s\.whatsapp\.net$/, "@c.us")));
}

/** @returns {{ event?: object, skip?: string }} */
export function normalizeMessage(message) {
  const key = message?.key;
  const remoteJid = key?.remoteJid;
  if (!remoteJid) return { skip: "no-remote-jid" };
  if (isJidStatusBroadcast(remoteJid)) return { skip: "status-broadcast" };
  if (isJidNewsletter(remoteJid)) return { skip: "newsletter" };
  if (isJidBroadcast(remoteJid)) return { skip: "broadcast-list" };
  if (remoteJid.endsWith("@call") || remoteJid.endsWith("@bot")) return { skip: "unsupported-chat" };
  if (message.messageStubType && !message.message) return { skip: "system-stub" };

  const content = normalizeMessageContent(message.message);
  if (!content) return { skip: "no-content" };
  const type = getContentType(content);
  if (!type) return { skip: "no-content-type" };
  if (SKIP_TYPES.has(type)) return { skip: `type:${type}` };

  const isGroup = Boolean(isJidGroup(remoteJid));
  const senderRaw = isGroup ? pickIds(key.participant, key.participantAlt) : pickIds(remoteJid, key.remoteJidAlt);
  const body = content[type];
  const contextInfo = (body && typeof body === "object" ? body.contextInfo : undefined) ?? undefined;

  let kind;
  let text = "";
  let media;
  switch (type) {
    case "conversation":
      kind = "text";
      text = typeof content.conversation === "string" ? content.conversation : "";
      break;
    case "extendedTextMessage":
      kind = "text";
      text = body?.text ?? "";
      break;
    case "imageMessage":
      kind = "image";
      text = body?.caption ?? "";
      media = { mimetype: body?.mimetype || "image/jpeg", filename: `whatsapp-photo-${key.id}.jpg` };
      break;
    case "videoMessage":
    case "ptvMessage":
      kind = "video";
      text = body?.caption ?? "";
      media = { mimetype: body?.mimetype || "video/mp4", filename: `whatsapp-video-${key.id}.mp4` };
      break;
    case "audioMessage":
      kind = body?.ptt ? "voice" : "audio";
      media = {
        mimetype: body?.mimetype || "audio/ogg; codecs=opus",
        filename: body?.ptt ? `whatsapp-voice-${key.id}.ogg` : `whatsapp-audio-${key.id}${/mpeg|mp3/.test(body?.mimetype ?? "") ? ".mp3" : ".ogg"}`,
      };
      break;
    case "documentMessage":
      kind = "document";
      text = body?.caption ?? "";
      media = {
        mimetype: body?.mimetype || "application/octet-stream",
        filename: (typeof body?.fileName === "string" && body.fileName.trim()) || `whatsapp-file-${key.id}.bin`,
      };
      break;
    case "stickerMessage":
      kind = "sticker";
      break;
    default:
      kind = "unsupported";
  }
  if (media) {
    media.size = toNumber(body?.fileLength);
    if (body?.seconds) media.seconds = toNumber(body.seconds);
  }

  const mentionedJids = Array.isArray(contextInfo?.mentionedJid)
    ? contextInfo.mentionedJid.map(bareJid).filter(Boolean)
    : [];
  const quoted = contextInfo?.stanzaId
    ? { id: contextInfo.stanzaId, participant: bareJid(contextInfo.participant) }
    : undefined;
  const forwarded = Boolean(contextInfo?.isForwarded || toNumber(contextInfo?.forwardingScore) > 0);
  const isBot = isBotJid(key.participant) || isBotJid(remoteJid)
    || Boolean(content.botInvokeMessage || content.messageContextInfo?.botMetadata);
  const album = Boolean(content.messageContextInfo?.messageAssociation?.parentMessageKey
    || body?.contextInfo?.messageAssociation?.parentMessageKey);

  const event = {
    id: key.id,
    chatId: bareJid(remoteJid),
    isGroup,
    fromMe: key.fromMe === true,
    timestamp: toNumber(message.messageTimestamp),
    sender: { ...senderRaw, name: typeof message.pushName === "string" ? message.pushName : undefined },
    kind,
    text: typeof text === "string" ? text : "",
    ...(media ? { media } : {}),
    mentionedJids,
    ...(quoted ? { quoted } : {}),
    forwarded,
    isBot,
    album,
  };
  Object.defineProperty(event, "raw", { value: message, enumerable: false });
  return { event };
}
