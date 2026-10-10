import { createHash } from "node:crypto";

/** Fixed-size sliding window counter keyed by an arbitrary string. */
export class SlidingWindowLimiter {
  constructor(limit, windowMs = 60_000, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Would one more hit fit inside the limit? Does not record. */
  wouldAllow(key) {
    if (!Number.isFinite(this.limit) || this.limit <= 0) return true;
    return this.#recent(key).length < this.limit;
  }

  /** How many more hits fit right now (Infinity when unlimited). */
  remaining(key) {
    if (!Number.isFinite(this.limit) || this.limit <= 0) return Infinity;
    return Math.max(0, this.limit - this.#recent(key).length);
  }

  /** Give back the most recent hit (the send it paid for never happened). */
  refund(key) {
    const list = this.#recent(key);
    if (!list.length) return false;
    list.pop();
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return true;
  }

  /** Ms until one more hit would fit (0 = now). */
  waitMs(key) {
    if (this.wouldAllow(key)) return 0;
    const list = this.#recent(key);
    return Math.max(0, list[list.length - this.limit] + this.windowMs - this.now() + 1);
  }

  /** Record a hit if it fits; returns true when recorded. */
  tryTake(key) {
    if (!this.wouldAllow(key)) return false;
    const list = this.#recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    return true;
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  outboundPerChatPerMinute: 6,
  outboundGlobalPerMinute: 20,
  inboundPerSenderPerMinute: 8,
  inboundPerChatPerMinute: 20,
  // Reply-only: the bridge may only send into a chat that sent an accepted
  // message within this window. It never starts a conversation.
  replyWindowMs: 15 * 60_000,
  echoWindowMs: 5 * 60_000,
});

function digest(text) {
  return createHash("sha256").update(String(text).replace(/\s+/g, " ").trim().toLocaleLowerCase()).digest("base64url");
}

/**
 * Loop guard and rate limits.
 * - never accept our own messages (fromMe or sender == own id)
 * - never accept messages from bots (Meta AI / @bot ids, bot-flagged messages)
 * - drop inbound text that echoes something we sent to the same chat recently
 *   (another bot parroting us back would otherwise loop)
 * - inbound flood limits per sender and per chat
 * - outbound limits per chat and globally, and reply-only gating
 */
export class LoopGuard {
  constructor(limits = {}, { now = () => Date.now() } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
    this.outboundChat = new SlidingWindowLimiter(this.limits.outboundPerChatPerMinute, 60_000, now);
    this.outboundGlobal = new SlidingWindowLimiter(this.limits.outboundGlobalPerMinute, 60_000, now);
    this.inboundSender = new SlidingWindowLimiter(this.limits.inboundPerSenderPerMinute, 60_000, now);
    this.inboundChat = new SlidingWindowLimiter(this.limits.inboundPerChatPerMinute, 60_000, now);
    this.replyWindows = new Map();
    this.lastInbound = new Map();
    this.recentOutbound = new Map();
  }

  /**
   * Cheap per-message checks, applied before bundling.
   * @returns {{ ok: boolean, reason?: string }}
   */
  checkInbound(event, selfIds = []) {
    if (!event) return { ok: false, reason: "empty" };
    if (event.fromMe) return { ok: false, reason: "own-message" };
    const senderIds = [event.sender?.jid, event.sender?.pn, event.sender?.lid].filter(Boolean);
    if (senderIds.some((id) => selfIds.includes(id))) return { ok: false, reason: "own-message" };
    if (event.isBot) return { ok: false, reason: "bot-sender" };
    if (typeof event.text === "string" && event.text.trim().length >= 12 && this.#isEcho(event.chatId, event.text)) {
      return { ok: false, reason: "echo-of-own-reply" };
    }
    return { ok: true };
  }

  /**
   * Flood limits, applied once per agent turn (a 10-photo album is one turn).
   * @returns {{ ok: boolean, reason?: string }}
   */
  takeInboundTurn(chatId, senderJid = "unknown") {
    const senderKey = `${chatId}|${senderJid}`;
    if (!this.inboundSender.wouldAllow(senderKey)) return { ok: false, reason: "inbound-sender-rate" };
    if (!this.inboundChat.wouldAllow(chatId)) return { ok: false, reason: "inbound-chat-rate" };
    this.inboundSender.tryTake(senderKey);
    this.inboundChat.tryTake(chatId);
    return { ok: true };
  }

  /** Open (or extend) the reply window for a chat after accepting an inbound message. */
  openReplyWindow(chatId, at = this.now()) {
    const until = at + this.limits.replyWindowMs;
    if ((this.replyWindows.get(chatId) ?? 0) < until) this.replyWindows.set(chatId, until);
    if ((this.lastInbound.get(chatId) ?? 0) < at) this.lastInbound.set(chatId, at);
  }

  /**
   * Reply window check. `windowMs` lets agent replies that arrive late (a
   * background task finishing) use a longer window than the default; it is
   * still measured from the chat's last accepted inbound message, so the
   * bridge never starts a conversation on its own.
   */
  hasReplyWindow(chatId, { windowMs } = {}) {
    if ((this.replyWindows.get(chatId) ?? 0) > this.now()) return true;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
    const at = this.lastInbound.get(chatId);
    return at !== undefined && at + windowMs > this.now();
  }

  /** Reserve one outbound send for a chat. @returns {{ ok: boolean, reason?: string }} */
  takeOutbound(chatId, { windowMs } = {}) {
    if (!this.hasReplyWindow(chatId, { windowMs })) return { ok: false, reason: "no-reply-window" };
    if (!this.outboundChat.wouldAllow(chatId)) return { ok: false, reason: "outbound-chat-rate" };
    if (!this.outboundGlobal.wouldAllow("*")) return { ok: false, reason: "outbound-global-rate" };
    this.outboundChat.tryTake(chatId);
    this.outboundGlobal.tryTake("*");
    return { ok: true };
  }

  /** A send that took a slot failed (socket closed, timeout): it must not count against the rate. */
  refundOutbound(chatId) {
    this.outboundChat.refund(chatId);
    this.outboundGlobal.refund("*");
  }

  /** Ms until both the per-chat and the global outbound limit allow one more send. */
  outboundWaitMs(chatId) {
    return Math.max(this.outboundChat.waitMs(chatId), this.outboundGlobal.waitMs("*"));
  }

  /** Outbound sends still available for this chat in the current minute (per-chat and global). */
  outboundBudget(chatId) {
    return Math.min(this.outboundChat.remaining(chatId), this.outboundGlobal.remaining("*"));
  }

  recordOutboundText(chatId, text) {
    if (typeof text !== "string" || !text.trim()) return;
    const list = (this.recentOutbound.get(chatId) ?? []).filter((item) => item.at > this.now() - this.limits.echoWindowMs);
    list.push({ at: this.now(), hash: digest(text) });
    this.recentOutbound.set(chatId, list.slice(-20));
  }

  #isEcho(chatId, text) {
    const list = this.recentOutbound.get(chatId) ?? [];
    const hash = digest(text);
    return list.some((item) => item.at > this.now() - this.limits.echoWindowMs && item.hash === hash);
  }
}
