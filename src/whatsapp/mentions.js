import { bareJid, normalizeUserId } from "../core/routing.js";

/**
 * Outgoing @mentions. WhatsApp shows a real (blue, notifying) tag only when the
 * text contains "@<user digits>" AND the message carries the matching JID in
 * contextInfo.mentionedJid (Baileys: `mentions: [...]`).
 *
 * Agents write "@<phone digits>" (or "@+<phone digits>"). For every such token
 * that belongs to a participant of THIS chat we attach the JID:
 *   - LID-addressed group: the participant's "<lid>@lid", and the token in the
 *     text is rewritten to "@<lid digits>" so the client renders the name;
 *   - otherwise "<digits>@s.whatsapp.net" (token normalised to "@<digits>").
 * Numbers that are not in the chat are left exactly as written and never
 * mentioned (no pinging strangers).
 */

// "@60123456789" or "@+60123456789"; not part of an e-mail/handle/longer number.
const MENTION_TOKEN_RE = /(^|[^0-9A-Za-z_@.+\-/])@(\+?)(\d{7,15})(?![0-9A-Za-z_])/g;

/** Unique digit strings of the "@<7-15 digits>" tokens in text (a leading + is allowed). */
export function findMentionTokens(text) {
  if (typeof text !== "string" || !text.includes("@")) return [];
  const found = new Set();
  for (const match of text.matchAll(MENTION_TOKEN_RE)) found.add(match[3]);
  return [...found];
}

const isLid = (jid) => typeof jid === "string" && jid.endsWith("@lid");
const isPn = (jid) => typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
const userOf = (jid) => jid.split("@")[0];

/**
 * Who can be tagged in a chat, as { pn?, lid? } entries (bare JIDs).
 * Group: the participants from group metadata. DM: the other person.
 */
export function chatParticipants({ chatId, meta }) {
  const chat = bareJid(chatId);
  if (!chat) return [];
  if (!chat.endsWith("@g.us")) return [isLid(chat) ? { lid: chat } : isPn(chat) ? { pn: chat } : {}].filter((entry) => entry.pn || entry.lid);
  return (meta?.participants ?? []).map((participant) => {
    const ids = [participant?.id, participant?.phoneNumber, participant?.lid, participant?.jid].map(bareJid).filter(Boolean);
    return { pn: ids.find(isPn), lid: ids.find(isLid), primary: bareJid(participant?.id) };
  }).filter((entry) => entry.pn || entry.lid);
}

/**
 * @param {string} text outgoing text
 * @param {object} ctx
 * @param {string} ctx.chatId
 * @param {object} [ctx.meta] Baileys group metadata (participants, addressingMode)
 * @param {Array<Set<string>|string[]>} [ctx.knownIdSets] extra pn<->lid pairs (configured member ids)
 * @param {(pnJid: string) => Promise<string|null|undefined>} [ctx.lookupLid] Baileys' PN -> LID map
 * @returns {Promise<{ text: string, mentions: string[] }>}
 */
export async function resolveMentions(text, { chatId, meta, knownIdSets = [], lookupLid } = {}) {
  const tokens = findMentionTokens(text);
  if (!tokens.length) return { text, mentions: [] };
  const people = chatParticipants({ chatId, meta });
  if (!people.length) return { text, mentions: [] };
  const chat = bareJid(chatId);
  const lidAddressed = chat.endsWith("@g.us")
    ? (meta?.addressingMode ? meta.addressingMode === "lid" : people.filter((entry) => isLid(entry.primary)).length * 2 > people.length)
    : isLid(chat);
  const byLid = new Map(people.filter((entry) => entry.lid).map((entry) => [entry.lid, entry]));
  const byPn = new Map(people.filter((entry) => entry.pn).map((entry) => [entry.pn, entry]));

  const pairedLid = async (pn) => {
    for (const ids of knownIdSets) {
      const list = [...(ids ?? [])].map((id) => normalizeUserId(id)).filter(Boolean);
      if (list.includes(pn)) {
        const lid = list.find((id) => isLid(id) && byLid.has(id));
        if (lid) return lid;
      }
    }
    if (typeof lookupLid !== "function") return undefined;
    try {
      const lid = bareJid(await lookupLid(pn) ?? undefined);
      return lid && byLid.has(lid) ? lid : undefined;
    } catch {
      return undefined;
    }
  };

  const replacements = new Map(); // digits -> { jid, user }
  for (const digits of tokens) {
    const pn = `${digits}@s.whatsapp.net`;
    let person = byPn.get(pn);
    if (!person && byLid.has(`${digits}@lid`)) person = byLid.get(`${digits}@lid`); // agent already wrote the LID
    if (!person && byLid.size) {
      const lid = await pairedLid(pn);
      if (lid) person = { ...byLid.get(lid), pn };
    }
    if (!person) continue; // not in this chat: never mention
    const lid = person.lid;
    const jid = lidAddressed && lid ? lid : (person.pn ?? lid);
    if (!jid) continue;
    replacements.set(digits, { jid, user: userOf(jid) });
  }
  if (!replacements.size) return { text, mentions: [] };

  const out = text.replace(MENTION_TOKEN_RE, (match, lead, _plus, digits) => {
    const hit = replacements.get(digits);
    return hit ? `${lead}@${hit.user}` : match;
  });
  return { text: out, mentions: [...new Set([...replacements.values()].map((hit) => hit.jid))] };
}
