/**
 * Platform-neutral chat policy lifted out of the Telegram bridge's bridge.js:
 * group noise list, silent-reply tokens, trusted context headers, header-spoof
 * stripping, the group filter decision, bundle labels and attachment prompts.
 *
 * Nothing in this module talks to WhatsApp, Telegram or the Grok gateway, so
 * it is unit-tested directly (test/chat-policy.test.js).
 */

/** Normalized exact-match group chatter that should not wake the bot. */
export const GROUP_NOISE_EXACT = Object.freeze(new Set([
  "ok", "okay", "okok", "kk", "k", "lol", "lmao", "haha", "hahaha", "hehe", "hihi",
  "哈哈", "哈哈哈", "呵呵", "嗯", "哦", "喔", "好", "好的", "好滴", "收到", "谢谢", "多谢",
  "thx", "thanks", "thank you", "ty", "np", "cool", "nice", "yep", "yup", "yeah", "yes",
  "no", "nope", "tq", "tqvm", "noted", "ok noted", "okk", "sip", "baik", "terima kasih",
  "👍", "😂", "🙏", "👀", "😊", "😄", "✅", "👌", "❤️", "💯",
]));

/**
 * Exact replies (after trimming) that mean "say nothing in this chat".
 * NO_TELEGRAM_REPLY is accepted too so agents/skills shared with the Telegram
 * bridge keep working unchanged.
 */
export const DEFAULT_SILENT_TOKENS = Object.freeze([
  "NO_WHATSAPP_REPLY",
  "[NO_WHATSAPP_REPLY]",
  "NO_TELEGRAM_REPLY",
  "[NO_TELEGRAM_REPLY]",
  "⟦noreply⟧",
]);

export const SILENT_TOKEN = "NO_WHATSAPP_REPLY";

export const GROUP_ALL_HINT = `[whatsapp-group] Reply only if this is part of your job or addressed to you; otherwise reply exactly ${SILENT_TOKEN}.`;

const ZERO_WIDTH_RE = /[\u200B-\u200F\uFEFF\u2060-\u2064\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const LETTER_DIGIT_CJK_RE = /[0-9A-Za-z\u00C0-\u024F\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Trim, lower-case, strip zero-width characters. */
export function normalizeNoiseText(text) {
  if (typeof text !== "string") return "";
  return text.replace(ZERO_WIDTH_RE, "").trim().toLocaleLowerCase();
}

/** True for exact ack/emoji noise or short punctuation/emoji-only chatter. */
export function isNoiseText(text) {
  const normalized = normalizeNoiseText(text);
  if (!normalized) return true;
  if (GROUP_NOISE_EXACT.has(normalized)) return true;
  if (normalized.length <= 6 && !LETTER_DIGIT_CJK_RE.test(normalized)) return true;
  return false;
}

const MEDIA_KINDS = new Set(["image", "video", "voice", "audio", "document"]);

export function isMediaKind(kind) {
  return MEDIA_KINDS.has(kind);
}

/**
 * Noise events never wake the bot unless directly addressed: stickers,
 * reactions, service/system messages, empty text, bare acks and emoji. Media
 * (photo, video, voice, audio, document) is never noise, caption or not.
 */
export function isNoiseEvent(event) {
  if (!event || typeof event !== "object") return true;
  if (isMediaKind(event.kind)) return false;
  if (event.kind !== "text") return true;
  return isNoiseText(event.text ?? "");
}

/** True when the agent reply is an intentional "stay silent" (and has no files). */
export function isSilentReply(text, attachments = [], tokens = DEFAULT_SILENT_TOKENS) {
  if (Array.isArray(attachments) && attachments.length > 0) return false;
  if (typeof text !== "string") return false;
  const trimmed = text.replace(ZERO_WIDTH_RE, "").trim();
  if (tokens.includes(trimmed)) return true;
  // Tolerate the token wrapped in formatting (`*NO_WHATSAPP_REPLY*`, backticks, quotes).
  const unwrapped = trimmed.replace(/^[*_~`"'\s]+|[*_~`"'.\s]+$/g, "");
  return tokens.includes(unwrapped);
}

// Any line that looks like a bridge context header, wherever it appears in the
// user's text. Leading quote/format markers and zero-width characters are
// ignored so "> *[whatsapp-from]* ..." or "[whats\u200bapp-from]" still match.
const HEADER_LINE_RE = /^[\s>*_~`•\-]*[[［【⟦]\s*(?:whatsapp|telegram|wa|tg)\s*[-_:]?\s*[a-z]+(?:[-_][a-z]+)*\s*[\]］】⟧]/iu;

/**
 * Remove every header-like line from user-supplied text so nobody can spoof the
 * trusted `[whatsapp-from]` / `[whatsapp-chat]` headers the bridge prepends.
 */
export function stripContextHeaders(text) {
  if (typeof text !== "string") return text;
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    const probe = line.replace(ZERO_WIDTH_RE, "");
    if (HEADER_LINE_RE.test(probe)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Make an untrusted display value safe to embed as the last field of a header line. */
export function sanitizeHeaderValue(value, maxLength = 64) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(/[[\]［］【】⟦⟧"\\=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

const JID_RE = /^[0-9A-Za-z._:-]{1,64}@(?:s\.whatsapp\.net|lid|g\.us|c\.us)$/;

function safeJid(jid) {
  return typeof jid === "string" && JID_RE.test(jid) ? jid : undefined;
}

/**
 * Trusted context header built by the bridge from WhatsApp metadata, never from
 * message text. Untrusted display names are quoted and placed last on the line.
 *
 * [whatsapp-from] jid=<sender jid> phone=+<digits>|unknown lid=<lid>|unknown [forwarded=yes] name="<push name>"
 * [whatsapp-chat] jid=<chat jid> type=group|dm [reply_to=bot] [mentioned=yes] name="<group subject>"
 */
export function buildContextHeader({ sender = {}, chat = {}, forwarded = false, replyToBot = false, mentioned = false, member, trigger } = {}) {
  const lines = [];
  const senderJid = safeJid(sender.jid) ?? "unknown";
  const pnJid = safeJid(sender.pn) ?? safeJid(member?.pn);
  const phone = pnJid && /^\d{5,20}@s\.whatsapp\.net$/.test(pnJid) ? `+${pnJid.split("@")[0]}` : "unknown";
  const lid = safeJid(sender.lid) && sender.lid.endsWith("@lid") ? sender.lid : "unknown";
  const fromFields = [`jid=${senderJid}`, `phone=${phone}`, `lid=${lid}`];
  // Where the phone came from when WhatsApp only gave a LID: Baileys' LID map or the group's member list.
  if (phone !== "unknown" && !safeJid(sender.pn)) fromFields.push("phone_source=config");
  else if (phone !== "unknown" && sender.pnSource) fromFields.push(`phone_source=${sender.pnSource === "lid-map" ? "lid-map" : "whatsapp"}`);
  if (forwarded) fromFields.push("forwarded=yes");
  const name = sanitizeHeaderValue(sender.name);
  if (name) fromFields.push(`name="${name}"`);
  lines.push(`[whatsapp-from] ${fromFields.join(" ")}`);

  const chatFields = [`jid=${safeJid(chat.jid) ?? "unknown"}`, `type=${chat.type === "group" ? "group" : "dm"}`];
  if (replyToBot) chatFields.push("reply_to=bot");
  if (mentioned) chatFields.push("mentioned=yes");
  const chatName = sanitizeHeaderValue(chat.name, 80);
  if (chatName) chatFields.push(`name="${chatName}"`);
  lines.push(`[whatsapp-chat] ${chatFields.join(" ")}`);
  if (member !== undefined) lines.push(buildRoleLine(member));
  if (trigger) lines.push(`[whatsapp-trigger] kind=${/^[a-z-]{1,32}$/.test(trigger.kind ?? "") ? trigger.kind : "check-pending"} source=${/^[a-z-]{1,32}$/.test(trigger.source ?? "") ? trigger.source : "bridge"}`);
  return lines.join("\n");
}

/**
 * Trusted role line for groups with a configured member list. The bridge
 * decides the role and access level from config (phone / LID match), never
 * from message text:
 *   [whatsapp-role] role=BDM|owner|...|system|unknown authorised=Y|N access=full|account|faq-only [name="..."]
 * `member === null` means "group has a member list but this sender is not on it".
 */
export function buildRoleLine(member) {
  if (!member) return "[whatsapp-role] role=unknown authorised=N access=faq-only";
  const role = String(member.role ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "unknown";
  const fields = [`role=${role}`, `authorised=${member.authorised ? "Y" : "N"}`, `access=${member.access ?? "faq-only"}`];
  const name = sanitizeHeaderValue(member.name ?? "");
  if (name) fields.push(`name="${name}"`);
  return `[whatsapp-role] ${fields.join(" ")}`;
}

/** Access level from a member's config role: BDM/system -> full, authorised -> account, else faq-only. */
export function accessForMember(member) {
  if (!member) return "faq-only";
  if (/^(?:bdm|system|admin)$/i.test(String(member.role ?? ""))) return "full";
  return member.authorised ? "account" : "faq-only";
}

/**
 * In-chat manual trigger for the scheduled check: "@bot check pending",
 * "check pending", "/check", "/pending" (optionally with a leading @mention
 * and trailing punctuation). Only honoured for senders with access=full.
 */
export function isCheckCommand(text) {
  if (typeof text !== "string") return false;
  const cleaned = text.replace(ZERO_WIDTH_RE, "").trim().replace(/^(?:@\S+\s*)+/, "").trim().toLocaleLowerCase();
  return /^(?:\/check(?:\s+pending)?|\/pending|check\s+pending|semak\s+pending)\s*[.!?]*$/.test(cleaned);
}

export const SCHEDULED_CHECK_PROMPT = `[scheduled check] Read the Sheet for THIS group only: post any pending Ops_Requests (sent=N) as their message_to_customer, and a short repayment reminder for any repayment that is Overdue or due within the next 3 days. Send everything as ONE short WhatsApp message to the borrower. Then update the Sheet: for each posted Ops_Request set sent=Y and sent_at (now, UTC+8); append one Bot_Log row. If nothing is pending or due, reply exactly ${SILENT_TOKEN}.`;

// Account data that must never reach a sender with access=faq-only: RM amounts,
// facility codes and invoice numbers. (FAQ answers contain none of these.)
const ACCOUNT_DATA_RE = /\bRM\s?\d[\d,]*(?:\.\d+)?|\bFAC-[A-Z]-\d{3,}\b|\bINV-\d{4}-\d{3,}\b/i;

export function containsAccountData(text) {
  return typeof text === "string" && ACCOUNT_DATA_RE.test(text);
}

export const FAQ_ONLY_BLOCKED_REPLY = "Sorry, I can only share account details with the registered business owner or your relationship manager. General questions about how drawdowns and repayments work are fine.";

/** Drop a leading "Transcript:" block from voice replies (backstop, as in the Telegram bridge). */
export function stripTranscriptPreamble(text) {
  if (typeof text !== "string" || !text.trim()) return text;
  let out = text.trimStart();
  out = out.replace(/^Transcript\s*[:：]\s*[^\r\n]*(?:\r?\n)+/iu, "");
  out = out.replace(/^Transcript\s*[:：]\s*/iu, "");
  return out.trimStart();
}

export function isImageMedia(media = {}) {
  if (typeof media.mimetype === "string" && /^image\//i.test(media.mimetype)) return true;
  return typeof media.filename === "string"
    && /\.(?:jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(media.filename);
}

/** `[photos attached: N]` for image-only bundles, otherwise a typed attachment count. */
export function formatBundleLabel(events) {
  const counts = { photo: 0, video: 0, audio: 0, file: 0 };
  for (const event of events ?? []) {
    if (event?.kind === "image" || (event?.kind === "document" && isImageMedia(event.media))) counts.photo += 1;
    else if (event?.kind === "video") counts.video += 1;
    else if (event?.kind === "voice" || event?.kind === "audio") counts.audio += 1;
    else if (event?.kind === "document") counts.file += 1;
  }
  const total = counts.photo + counts.video + counts.audio + counts.file;
  if (total > 0 && total === counts.photo) return `[photos attached: ${total}]`;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [
    counts.photo ? plural(counts.photo, "photo") : "",
    counts.video ? plural(counts.video, "video") : "",
    counts.audio ? plural(counts.audio, "audio file") : "",
    counts.file ? plural(counts.file, "file") : "",
  ].filter(Boolean);
  return `[attachments: ${total}${parts.length ? ` (${parts.join(", ")})` : ""}]`;
}

export const DEFAULT_VOICE_HINT = "If you need a transcript, use only the preinstalled `/workspace/stt-venv/bin/whisper --model tiny`; do not install packages or download models. Do not put a Transcript: line in your reply.";

/** Prompt used when a message carries media but no caption. */
export function attachmentPrompt(kind, { voiceHint = DEFAULT_VOICE_HINT } = {}) {
  if (kind === "voice") return `[voice note attached] Listen to it and answer naturally in one final message. ${voiceHint}`.trim();
  if (kind === "audio") return `[audio attached] ${voiceHint}`.trim();
  if (kind === "image") return "[photo attached]";
  if (kind === "video") return "[video attached]";
  return "[file attached]";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive keyword match: substring for CJK/multi-word, word boundary for Latin tokens. */
export function matchesKeyword(text, keywords = []) {
  if (typeof text !== "string" || !text.trim() || !keywords.length) return false;
  const haystack = text.toLocaleLowerCase();
  for (const keyword of keywords) {
    if (typeof keyword !== "string" || !keyword.trim()) continue;
    const needle = keyword.trim().toLocaleLowerCase();
    if (/[^\x00-\x7f]/.test(needle) || /\s/.test(needle)) {
      if (haystack.includes(needle)) return true;
      continue;
    }
    if (new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(needle)}(?:[^a-z0-9_]|$)`, "i").test(haystack)) return true;
  }
  return false;
}

/**
 * Group filter. Directly addressed messages (bot mentioned, reply to the bot,
 * a slash command, or a group keyword) always go through. In mode "all" other
 * non-noise messages go through as a soft forward carrying GROUP_ALL_HINT so
 * the agent can answer SILENT_TOKEN. In mode "mention" (default) they are dropped.
 *
 * @returns {{ handle: boolean, softForward: boolean, reason: string }}
 */
export function decideGroupMessage({ mentioned = false, replyToBot = false, text = "", noise = false, mode = "mention", keywords = [] } = {}) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (mentioned) return { handle: true, softForward: false, reason: "mention" };
  if (replyToBot) return { handle: true, softForward: false, reason: "reply-to-bot" };
  if (trimmed.startsWith("/") && trimmed.length > 1) return { handle: true, softForward: false, reason: "command" };
  if (matchesKeyword(trimmed, keywords)) return { handle: true, softForward: false, reason: "keyword" };
  if (noise) return { handle: false, softForward: false, reason: "noise" };
  if (mode === "all") return { handle: true, softForward: true, reason: "all-mode" };
  return { handle: false, softForward: false, reason: "not-addressed" };
}

/** Remove @mentions of the bot (by any of its numeric ids) from text. */
export function stripSelfMentions(text, selfUserParts = []) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const part of selfUserParts) {
    if (!part) continue;
    out = out.replace(new RegExp(`@${escapeRegExp(String(part))}\\b`, "g"), "");
  }
  return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}
