/**
 * Allowlist + chat -> agent routing. Config-file driven only: nothing that
 * arrives from WhatsApp can change these maps at runtime.
 *
 * DMs:    allowlisted by phone number (digits, stored as <digits>@s.whatsapp.net)
 *         or by LID (<id>@lid). A DM is accepted when ANY of the sender's known
 *         ids (primary JID, alternate JID) is on the list. Each DM entry may
 *         name its own agent; otherwise the default agent answers.
 * Groups: allowlisted by group JID (<id>@g.us). Each group maps to exactly one
 *         agent (one job per group; WhatsApp has no topics), a mode
 *         ("mention" | "all"), optional keywords and an optional sender list.
 * Queues:  one FIFO per agent. A Grok agent holds a single conversation, so
 *         two chats that share an agent are serialized instead of interleaved.
 */

/** "60123456789:12@s.whatsapp.net" -> "60123456789@s.whatsapp.net" (drop device/agent suffix). */
export function bareJid(jid) {
  if (typeof jid !== "string" || !jid.includes("@")) return undefined;
  const [user, server] = jid.trim().toLowerCase().split("@");
  const bareUser = user.split(":")[0].split("_")[0];
  if (!bareUser || !server) return undefined;
  return `${bareUser}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

/** Accept "+60 12-345 6789", "60123456789", "60123456789@s.whatsapp.net" or "1234@lid". */
export function normalizeUserId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("@")) {
    const jid = bareJid(trimmed);
    if (!jid) return undefined;
    return /^[0-9]{5,20}@(?:s\.whatsapp\.net|lid)$/.test(jid) ? jid : undefined;
  }
  const digits = trimmed.replace(/[\s().-]/g, "").replace(/^\+/, "");
  return /^\d{5,20}$/.test(digits) ? `${digits}@s.whatsapp.net` : undefined;
}

export function normalizeGroupJid(value) {
  const jid = bareJid(value);
  return jid && /^[0-9-]{5,40}@g\.us$/.test(jid) ? jid : undefined;
}

export function senderIds(sender = {}) {
  return [...new Set([sender.jid, sender.pn, sender.lid, sender.alt].map(bareJid).filter(Boolean))];
}

/**
 * Optional per-group member list (people the bot must tell apart):
 *   [{ name, role: "BDM"|"owner"|..., authorised: true|"Y", ids: ["+6012...", "1234@lid"] }]
 * Returns undefined when not configured, else [{ name, role, authorised, access, ids:Set, pn }].
 */
export function normalizeMembers(members) {
  if (!Array.isArray(members) || !members.length) return undefined;
  return members.map((member) => {
    const ids = new Set((member?.ids ?? (member?.id ? [member.id] : [])).map(normalizeUserId).filter(Boolean));
    const role = typeof member?.role === "string" && member.role.trim() ? member.role.trim() : "member";
    const authorised = member?.authorised === true || /^y(?:es)?$/i.test(String(member?.authorised ?? "")) || /^(?:bdm|admin)$/i.test(role);
    const access = /^(?:bdm|admin)$/i.test(role) ? "full" : authorised ? "account" : "faq-only";
    return { name: member?.name, role, authorised, access, ids, pn: [...ids].find((id) => id.endsWith("@s.whatsapp.net")) };
  });
}

/** The configured member a sender is, by any of their ids; null when the group has a list and they are not on it. */
export function memberForSender(group, sender) {
  if (!group?.members) return undefined;
  const ids = senderIds(sender);
  return group.members.find((member) => ids.some((id) => member.ids.has(id))) ?? group.defaultMember ?? null;
}

/**
 * Optional per-group fallback for senders not on the member list, e.g.
 *   "defaultMember": { "name": "Company staff", "role": "company", "authorised": "Y" }
 * BDM/admin roles are never allowed as a fallback (a stranger must not get full access).
 */
export function normalizeDefaultMember(value) {
  if (!value || typeof value !== "object") return undefined;
  const role = typeof value.role === "string" && value.role.trim() ? value.role.trim() : "member";
  if (/^(?:bdm|admin|system)$/i.test(role)) return undefined;
  const authorised = value.authorised === true || /^y(?:es)?$/i.test(String(value.authorised ?? ""));
  return { name: value.name, role, authorised, access: authorised ? "account" : "faq-only", ids: new Set(), fallback: true };
}

export class ChatRouter {
  /**
   * @param {{ defaultAgent: string, dms: Array<{id: string, agent?: string}>, groups: Array<object>, ignoreSenders?: string[] }} config
   */
  constructor({ defaultAgent, dms = [], groups = [], ignoreSenders = [] }) {
    this.defaultAgent = defaultAgent;
    this.dms = new Map();
    for (const entry of dms) {
      const id = normalizeUserId(entry.id);
      if (id) this.dms.set(id, { id, agent: entry.agent || undefined, name: entry.name });
    }
    this.groups = new Map();
    for (const group of groups) {
      const jid = normalizeGroupJid(group.jid);
      if (!jid) continue;
      this.groups.set(jid, {
        jid,
        name: group.name,
        agent: group.agent,
        mode: group.mode === "all" ? "all" : "mention",
        keywords: Array.isArray(group.keywords) ? group.keywords : [],
        allowSenders: new Set((group.allowSenders ?? []).map(normalizeUserId).filter(Boolean)),
        quoteReplies: group.quoteReplies !== false,
        splitReplies: group.splitReplies === true,
        members: normalizeMembers(group.members),
        defaultMember: normalizeMembers(group.members) ? normalizeDefaultMember(group.defaultMember) : undefined,
        allowNudge: group.allowNudge === true,
        checkCommand: group.checkCommand === true,
        faqOnlyGuard: group.faqOnlyGuard !== false,
        faqOnlyBlockedReply: typeof group.faqOnlyBlockedReply === "string" && group.faqOnlyBlockedReply.trim() ? group.faqOnlyBlockedReply.trim() : undefined,
      });
    }
    this.ignoreSenders = new Set(ignoreSenders.map(normalizeUserId).filter(Boolean));
  }

  groupFor(chatId) {
    return this.groups.get(bareJid(chatId));
  }

  /**
   * The agent the CURRENT config routes a chat to (group JID or allowlisted DM
   * id), or undefined when the chat is not in config. Used to gate replies
   * that arrive after their turn: they may only go to a configured chat.
   */
  agentForChat(chatId) {
    const jid = bareJid(chatId);
    if (!jid) return undefined;
    if (jid.endsWith("@g.us")) return this.groups.get(jid)?.agent || undefined;
    const dm = this.dms.get(jid);
    return dm ? (dm.agent || this.defaultAgent) : undefined;
  }

  /**
   * @returns {{ ok: true, kind: "dm"|"group", agent: string, group?: object, queueKey: string }
   *         | { ok: false, reason: string }}
   */
  route(event) {
    const chatId = bareJid(event?.chatId);
    if (!chatId) return { ok: false, reason: "no-chat" };
    const ids = senderIds(event.sender);
    if (ids.some((id) => this.ignoreSenders.has(id))) return { ok: false, reason: "ignored-sender" };
    if (chatId.endsWith("@g.us")) {
      const group = this.groups.get(chatId);
      if (!group) return { ok: false, reason: "group-not-allowlisted" };
      if (group.allowSenders.size && !ids.some((id) => group.allowSenders.has(id))) {
        return { ok: false, reason: "sender-not-allowed-in-group" };
      }
      if (!group.agent) return { ok: false, reason: "group-has-no-agent" };
      return { ok: true, kind: "group", agent: group.agent, group, member: memberForSender(group, event.sender), queueKey: `agent:${group.agent}` };
    }
    if (!/@(?:s\.whatsapp\.net|lid)$/.test(chatId)) return { ok: false, reason: "unsupported-chat-type" };
    // In a DM the chat JID is the sender; check every id we know for them.
    const candidates = [...new Set([chatId, ...ids])];
    const match = candidates.map((id) => this.dms.get(id)).find(Boolean);
    if (!match) return { ok: false, reason: "dm-not-allowlisted" };
    const agent = match.agent || this.defaultAgent;
    return { ok: true, kind: "dm", agent, dmId: match.id, queueKey: `agent:${agent}` };
  }
}
