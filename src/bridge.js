import { setTimeout as sleep } from "node:timers/promises";
import { HANDOFF_NOTICE, isTopLevelPromptEntry } from "./grok-client.js";
import {
  DEFAULT_SILENT_TOKENS,
  FAQ_ONLY_BLOCKED_REPLY,
  GROUP_ALL_HINT,
  SCHEDULED_CHECK_PROMPT,
  attachmentPrompt,
  buildContextHeader,
  containsAccountData,
  decideGroupMessage,
  formatBundleLabel,
  isCheckCommand,
  isImageMedia,
  isMediaKind,
  isNoiseEvent,
  isSilentReply,
  stripContextHeaders,
  stripSelfMentions,
  stripTranscriptPreamble,
} from "./core/chat-policy.js";
import { Dispatcher } from "./core/dispatcher.js";
import { bareJid } from "./core/routing.js";
import { smartSplit, splitText, toWhatsAppText } from "./whatsapp/format.js";

export const HELP = [
  "I'm a Grok Bot assistant on WhatsApp. Send text, photos, voice notes or files and I'll reply here.",
  "In groups, mention me or reply to one of my messages.",
  "",
  "/status - is the assistant busy right now?",
  "/help - this message",
  "",
  "Settings, approvals and assistant setup can only be changed in Grok Bot on the desktop.",
].join("\n");

export const APPROVAL_NOTICE = "Grok Bot needs an approval on the desktop app before it can continue this request. Open Grok Bot to approve or deny it. Approvals can't be given from WhatsApp.";
export const ERROR_NOTICE = "I couldn't finish that request. If it was a long job it may still finish in Grok Bot, so check there before sending it again.";

const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
const ATTACHMENT_READ_ATTEMPTS = 5;
const APPROVAL_ENTRY_TYPES = new Set(["auto-review-approval", "local-tool-permission"]);

const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  md: "text/markdown",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

export function guessMimeType(filename = "") {
  const extension = String(filename).toLowerCase().split(".").at(-1);
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** Keep user-supplied file names harmless: no paths, control chars or huge names. */
export function safeFilename(name, fallback = "whatsapp-file.bin") {
  if (typeof name !== "string") return fallback;
  const base = name.split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001F\u007F"<>|:*?]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!base) return fallback;
  return base.length > 120 ? `${base.slice(0, 100)}${base.slice(base.lastIndexOf("."), base.length).slice(0, 20)}` : base;
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}` : `${name}-${count + 1}`;
  });
}

/** "whatsapp:<chatJid>:<msgId>[:bN]" -> "<chatJid>" (only for prompts this bridge sent). */
export function chatFromNonce(nonce) {
  if (typeof nonce !== "string" || !nonce.startsWith("whatsapp:")) return undefined;
  const chat = nonce.slice("whatsapp:".length).split(":")[0];
  return bareJid(chat) === chat && /@(?:g\.us|s\.whatsapp\.net|lid)$/.test(chat) ? chat : undefined;
}

function newTurnState() {
  return { quoteUsed: false, handoffSent: false, sentParts: 0, handled: 0, stopped: false };
}

function normalizeName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

/**
 * WhatsApp <-> Grok Bot bridge core. Platform glue lives in the transport:
 *   transport.selfIds() -> string[]              own bare JIDs (PN and LID)
 *   transport.sendText(chatId, text, { quoted })
 *   transport.sendFile(chatId, { bytes, filename, mimetype }, { quoted })
 *   transport.downloadMedia(event) -> Uint8Array
 *   transport.setTyping?(chatId, on)   transport.chatName?(chatId)
 *   transport.wasSentByUs?(messageId)
 */
export class WhatsAppBridge {
  constructor({ grok, state, router, guard, transport, log = console, options = {} }) {
    this.grok = grok;
    this.state = state;
    this.router = router;
    this.guard = guard;
    this.transport = transport;
    this.log = log;
    this.options = {
      silentTokens: DEFAULT_SILENT_TOKENS,
      maxMessageAgeSec: 600,
      sendDelayMs: 1_200,
      typingIndicator: true,
      smartSplit: { maxParts: 3, minChars: 320, targetChars: 280 },
      quoteInDms: false,
      replyTimeoutMs: 10 * 60_000,
      // How long one turn may hold its agent's queue after the prompt was sent.
      // After that the reply keeps streaming in the background (same delivery
      // locks, so nothing is sent twice) and the next message is handled. 0 = never release.
      turnQueueHoldMs: 120_000,
      // Max wait for a rate-limit slot before an agent reply part is dropped.
      rateWaitMaxMs: 75_000,
      // Agent messages that arrive after their prompt's turn (a background task
      // finishing, or after a reply timeout) still go to the chat the agent last
      // served, for this long after that chat's prompt. 0 disables it.
      lateDeliveryWindowMs: 60 * 60_000,
      lateDeliveryPollMs: 3_000,
      streamReplies: true,
      attachmentReadBackoffMs: (attempt) => 300 + (attempt * 125),
      now: () => Date.now(),
      ...options,
    };
    this.dispatcher = new Dispatcher(this, { bundling: options.bundling, log });
    this.notifiedApprovals = new Set();
    this.agentLocks = new Map();
    this.activeTurns = new Map();
    this.pendingRecovery = new Map();
    // clientNonce -> sender access ("full" | "account" | "faq-only") for groups with a member list.
    this.turnAccess = new Map();
    this.lastScheduledCheck = new Map();
    // msgId -> accepted-at: inbound messages accepted but not yet finished (watchdog).
    this.inflight = new Map();
  }

  /** Age of the oldest accepted inbound message still being handled (0 when idle). */
  oldestInflightMs() {
    let oldest = Infinity;
    for (const at of this.inflight.values()) oldest = Math.min(oldest, at);
    return Number.isFinite(oldest) ? Math.max(0, this.options.now() - oldest) : 0;
  }

  /**
   * Let a live turn hold the agent queue for at most turnQueueHoldMs. The turn
   * itself keeps running; its errors are logged/notified when they happen.
   */
  async holdQueue(turnPromise, { chatId, msgId, onLateError } = {}) {
    const holdMs = this.options.turnQueueHoldMs;
    if (!(holdMs > 0)) return turnPromise;
    let timer;
    const released = Symbol("released");
    const result = await Promise.race([
      turnPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(released), holdMs); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    if (result !== released) return result;
    this.log.warn(`Turn still running after ${holdMs}ms chat=${chatId} msg=${msgId}; releasing the queue, reply continues in background`);
    turnPromise.catch((error) => onLateError?.(error));
    return { released: true };
  }

  rememberTurnAccess(clientNonce, access) {
    if (!access) return;
    this.turnAccess.set(clientNonce, access);
    if (this.turnAccess.size > 500) this.turnAccess.delete(this.turnAccess.keys().next().value);
  }

  /** Serialize every delivery for one agent (live turn + late follower) so nothing is sent twice. */
  withAgentLock(agentId, operation) {
    const previous = this.agentLocks.get(agentId) ?? Promise.resolve();
    const task = previous.then(operation);
    const settled = task.catch(() => {});
    this.agentLocks.set(agentId, settled);
    void settled.then(() => {
      if (this.agentLocks.get(agentId) === settled) this.agentLocks.delete(agentId);
    });
    return task;
  }

  beginTurn(agentId) {
    this.activeTurns.set(agentId, (this.activeTurns.get(agentId) ?? 0) + 1);
  }

  endTurn(agentId) {
    const count = (this.activeTurns.get(agentId) ?? 1) - 1;
    if (count > 0) this.activeTurns.set(agentId, count);
    else this.activeTurns.delete(agentId);
  }

  replyWindowMs() {
    return Math.max(this.guard.limits?.replyWindowMs ?? 0, this.options.lateDeliveryWindowMs || 0);
  }

  selfIds() {
    return (this.transport.selfIds?.() ?? []).filter(Boolean);
  }

  /** Entry point for every normalized inbound WhatsApp event. */
  ingest(event, options = {}) {
    const verdict = this.accept(event);
    if (!verdict.ok) {
      this.log.info(`Drop inbound reason=${verdict.reason} chat=${event?.chatId ?? "none"} msg=${event?.id ?? "none"}`);
      return Promise.resolve({ dropped: verdict.reason });
    }
    this.log.info(`Inbound accepted chat=${event.chatId} msg=${event.id} kind=${event.kind} route=${verdict.route.kind}`);
    const key = `${event.chatId}|${event.id}`;
    this.inflight.set(key, this.options.now());
    const task = this.dispatcher.dispatch(event, options);
    void Promise.resolve(task).finally(() => this.inflight.delete(key)).catch(() => {});
    return task;
  }

  /** Per-message checks before bundling: own/bot/echo, allowlist, staleness, unsupported kinds. */
  accept(event) {
    const inbound = this.guard.checkInbound(event, this.selfIds());
    if (!inbound.ok) return inbound;
    const route = this.router.route(event);
    if (!route.ok) return route;
    const nowSec = this.options.now() / 1000;
    if (event.timestamp && this.options.maxMessageAgeSec > 0 && nowSec - event.timestamp > this.options.maxMessageAgeSec) {
      return { ok: false, reason: "stale-message" };
    }
    if (route.kind === "dm" && event.kind !== "text" && !isMediaKind(event.kind)) {
      return { ok: false, reason: `unsupported-kind:${event.kind}` };
    }
    return { ok: true, route };
  }

  queueKeyFor(event) {
    const route = this.router.route(event);
    return route.ok ? route.queueKey : `chat:${event?.chatId ?? "unknown"}`;
  }

  classifyForBundling(event) {
    const route = this.router.route(event);
    if (!route.ok || !event.sender?.jid) return undefined;
    const senderKey = `${event.chatId}|${event.sender.jid}`;
    const text = (event.text ?? "").trim();
    if (event.kind === "image" || (event.kind === "document" && isImageMedia(event.media))) {
      return { senderKey, role: "media", album: event.album === true };
    }
    if (event.kind === "text" && text && !text.startsWith("/")) return { senderKey, role: "text" };
    return { senderKey, role: "other" };
  }

  resolveAgent(wanted, agents) {
    const target = String(wanted ?? "").trim();
    return agents.find((agent) => agent.id === target)
      || agents.find((agent) => normalizeName(agent.name) === normalizeName(target));
  }

  quotedFor(route, primary) {
    if (route.kind === "group") return route.group?.quoteReplies === false ? undefined : primary.raw ?? undefined;
    return this.options.quoteInDms ? primary.raw ?? undefined : undefined;
  }

  async handleEvent(input, options = {}) {
    const items = Array.isArray(input?.bundled) && input.bundled.length > 1 ? input.bundled : [input];
    const primary = items[0];
    const isBundle = items.length > 1;
    const route = this.router.route(primary);
    if (!route.ok) {
      this.log.info(`Drop event reason=${route.reason} chat=${primary?.chatId ?? "none"}`);
      return { dropped: route.reason };
    }
    const chatId = primary.chatId;
    const selfIds = this.selfIds();
    const selfUserParts = selfIds.map((id) => id.split("@")[0]);
    const mentioned = items.some((item) => (item.mentionedJids ?? []).some((jid) => selfIds.includes(jid)));
    const replyToBot = items.some((item) => item.quoted
      && ((item.quoted.participant && selfIds.includes(item.quoted.participant))
        || this.transport.wasSentByUs?.(item.quoted.id) === true));
    const combinedText = items
      .map((item) => stripContextHeaders(item.text ?? ""))
      .filter((text) => text && text.trim())
      .join("\n\n");
    let text = stripSelfMentions(combinedText, selfUserParts);

    let decision = { handle: true, softForward: false, reason: "dm" };
    if (route.kind === "group") {
      decision = decideGroupMessage({
        mentioned,
        replyToBot,
        text,
        noise: items.every((item) => isNoiseEvent(item)),
        mode: route.group.mode,
        keywords: route.group.keywords,
      });
      if (!decision.handle) {
        this.log.info(`Drop group message reason=${decision.reason} chat=${chatId} items=${items.length}`);
        return { dropped: decision.reason };
      }
    }
    const turnGate = this.guard.takeInboundTurn(chatId, primary.sender?.jid);
    if (!turnGate.ok) {
      this.log.warn(`Drop turn reason=${turnGate.reason} chat=${chatId}`);
      return { dropped: turnGate.reason };
    }
    this.guard.openReplyWindow(chatId);
    const quoted = this.quotedFor(route, primary);
    const mediaItems = items.filter((item) => isMediaKind(item.kind));

    const command = text.trim().toLocaleLowerCase();
    if (command === "/help" || command === "/start") {
      await this.sendSimple(chatId, HELP, quoted);
      return { handled: "help" };
    }
    const agents = await this.grok.listAgents(options);
    const agent = this.resolveAgent(route.agent, agents);
    if (!agent) {
      this.log.error(`Agent not found chat=${chatId} agent=${JSON.stringify(route.agent)} (check config.json)`);
      if (route.kind === "dm") await this.sendSimple(chatId, "I can't reach the assistant for this chat right now. Please check Grok Bot on the desktop.", quoted);
      return { dropped: "agent-not-found" };
    }
    if (command === "/status") {
      const busy = agent.isRunning === true || agent.isComposingMessage === true;
      await this.sendSimple(chatId, `${agent.name ?? "The assistant"} is ${busy ? "working" : "idle"}.`, quoted);
      return { handled: "status" };
    }
    if (!text && !mediaItems.length) {
      if (mentioned) await this.sendSimple(chatId, "Mention me with a question, or send /help.", quoted);
      return { dropped: "empty" };
    }

    const bundleLabel = isBundle ? formatBundleLabel(items) : "";
    if (!text) text = isBundle ? bundleLabel : attachmentPrompt(mediaItems[0].kind, { voiceHint: this.options.voiceHint });
    if (isBundle && bundleLabel && !text.includes(bundleLabel)) text = `${bundleLabel}\n${text}`;
    if (mediaItems.some((item) => item.kind === "voice") && !text.includes("[voice note attached]")) {
      text = `${text}\n\n${attachmentPrompt("voice", { voiceHint: this.options.voiceHint })}`;
    }
    // Groups with a member list: the role/access comes from config (phone or LID match), never from text.
    const member = route.kind === "group" && route.group?.members ? (route.member ?? null) : undefined;
    let trigger;
    if (route.kind === "group" && route.group?.checkCommand && member?.access === "full" && !mediaItems.length && isCheckCommand(text)) {
      // In-chat manual trigger from the BDM: same synthetic prompt as scripts/nudge.mjs.
      trigger = { kind: "check-pending", source: "bdm" };
      text = SCHEDULED_CHECK_PROMPT;
      decision = { ...decision, softForward: false };
      this.log.info(`Check-pending trigger chat=${chatId} msg=${primary.id}`);
    }
    if (decision.softForward) text = `${GROUP_ALL_HINT}\n\n${text}`;

    const header = buildContextHeader({
      sender: primary.sender,
      chat: {
        jid: chatId,
        type: route.kind === "group" ? "group" : "dm",
        name: route.kind === "group" ? (this.transport.chatName?.(chatId) ?? route.group?.name) : undefined,
      },
      forwarded: items.some((item) => item.forwarded),
      replyToBot,
      mentioned,
      ...(member !== undefined ? { member } : {}),
      ...(trigger ? { trigger } : {}),
    });

    const clientNonce = `whatsapp:${chatId}:${primary.id}${isBundle ? `:b${items.length}` : ""}`;
    if (member !== undefined && route.group?.faqOnlyGuard !== false) this.rememberTurnAccess(clientNonce, member?.access ?? "faq-only");
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce)) {
      this.log.info(`Skip duplicate turn chat=${chatId} msg=${primary.id}`);
      return { dropped: "duplicate" };
    }
    if (this.state.getPromptContext?.(agent.id, clientNonce)) {
      await this.completeTurn(agent, clientNonce, { chatId, quoted, signal: options.signal });
      return { handled: "resumed" };
    }

    // No "typing…" for all-mode soft forwards: most end in the silent token, and
    // WhatsApp keeps showing "composing" to the whole group until we pause it.
    const showTyping = this.options.typingIndicator && !decision.softForward;
    if (showTyping) await this.transport.setTyping?.(chatId, true)?.catch?.(() => {});
    this.beginTurn(agent.id);
    try {
      const attachmentPaths = [];
      const attachmentNames = [];
      let failed = 0;
      const names = uniqueNames(mediaItems.map((item) => safeFilename(item.media?.filename)));
      for (const [index, item] of mediaItems.entries()) {
        try {
          if (item.media?.size && item.media.size > ATTACHMENT_LIMIT) throw new Error("attachment exceeds 20 MB");
          const bytes = await this.transport.downloadMedia(item);
          if (!bytes?.byteLength || bytes.byteLength > ATTACHMENT_LIMIT) throw new Error("attachment empty or exceeds 20 MB");
          attachmentPaths.push(await this.grok.uploadAttachment(agent.id, names[index], bytes, options));
          attachmentNames.push(names[index]);
        } catch (error) {
          failed += 1;
          this.log.warn(`Attachment not forwarded chat=${chatId} msg=${item.id} reason=${error.message}`);
        }
      }
      let prompt = `${header}\n\n${text}`;
      if (failed) prompt += `\n\n[${failed} attachment${failed === 1 ? "" : "s"} could not be downloaded from WhatsApp]`;
      if (isBundle) this.log.info(`Media bundle turn chat=${chatId} agent=${agent.id} messages=${items.length} attachments=${attachmentPaths.length}`);

      await this.grok.sendPrompt(agent.id, prompt, clientNonce, { ...options, attachmentPaths, attachmentNames });
      await this.state.setPromptContext(agent.id, clientNonce, {
        contextKey: clientNonce,
        clientNonce,
        origin: "whatsapp",
        chatId,
        isGroup: route.kind === "group",
        replyToMessageId: primary.id,
        createdAt: this.options.now(),
        awaitingCompletion: true,
      });
      await this.state.setLastServed?.(agent.id, {
        chatId,
        at: this.options.now(),
        ...(route.dmId ? { dmId: route.dmId } : {}),
      });
      this.log.info(`Prompt sent chat=${chatId} msg=${primary.id} agent=${agent.id} attachments=${attachmentPaths.length}`);
      const held = await this.holdQueue(this.completeTurn(agent, clientNonce, { chatId, quoted, signal: options.signal }), {
        chatId,
        msgId: primary.id,
        onLateError: (error) => {
          if (options.signal?.aborted || error?.name === "AbortError") return;
          this.log.error(`Background turn failed chat=${chatId} msg=${primary.id}: ${error?.message ?? error}`);
          void this.handleError(input, error, options).catch(() => {});
        },
      });
      return { handled: "prompt", clientNonce, agentId: agent.id, ...(held?.released ? { released: true } : {}) };
    } finally {
      this.endTurn(agent.id);
      // Never let a stuck presence update hold the agent queue.
      if (showTyping) void Promise.resolve(this.transport.setTyping?.(chatId, false)).catch(() => {});
    }
  }

  /**
   * Wait for the agent's turn and deliver each reply entry once, as soon as it
   * appears (streaming). A reply timeout still delivers what the agent already
   * sent; anything it sends later is picked up by the late-delivery follower.
   */
  async completeTurn(agent, clientNonce, { chatId, quoted, signal } = {}) {
    const turn = newTurnState();
    const deliver = (entries) => this.withAgentLock(
      agent.id,
      () => this.deliverEntries(agent, clientNonce, entries, { chatId, quoted, turn }),
    );
    this.beginTurn(agent.id);
    try {
      let reply;
      try {
        reply = await this.grok.waitForReply(agent.id, clientNonce, {
          origin: "whatsapp",
          signal,
          ...(Number.isFinite(this.options.stableReplyMs) ? { stableReplyMs: this.options.stableReplyMs } : {}),
          onApproval: (entry) => this.notifyApproval(chatId, entry, quoted),
          ...(this.options.streamReplies === false ? {} : {
            onEntries: deliver,
            onEntriesError: (error) => this.log.warn(`Streaming delivery failed chat=${chatId} reason=${error.message}; retrying`),
          }),
        });
      } catch (error) {
        const context = this.state.getPromptContext?.(agent.id, clientNonce);
        if (context?.awaitingCompletion) await this.state.setPromptContext(agent.id, clientNonce, { ...context, awaitingCompletion: false });
        if (error?.code === "GROK_REPLY_TIMEOUT" && !signal?.aborted) {
          if (error.partialEntries?.length) {
            await deliver(error.partialEntries)
              .catch((deliveryError) => this.log.warn(`Delivery after timeout failed chat=${chatId} reason=${deliveryError.message}`));
          }
          const follow = this.options.lateDeliveryWindowMs > 0 ? "; later agent messages will still be forwarded" : "";
          if (turn.handled > 0) {
            this.log.warn(`Turn wait timed out chat=${chatId} delivered=${turn.handled}${follow}`);
            await this.state.retirePromptTurn?.(agent.id, clientNonce, error.partialEntries?.at(-1)?.id ?? clientNonce);
            await this.state.deletePromptContext?.(agent.id, clientNonce);
            return { timedOut: true, delivered: turn.handled };
          }
          this.log.warn(`Turn wait timed out chat=${chatId} delivered=0${follow}`);
        }
        throw error;
      }
      const entries = reply.entries?.length
        ? reply.entries
        : reply.messageId
          ? [{ id: reply.messageId, kind: "send-message", message: { type: "text", content: reply.text ?? "" } }]
          : [];
      await deliver(entries);
      await this.state.retirePromptTurn?.(agent.id, clientNonce, reply.messageId ?? entries.at(-1)?.id ?? clientNonce);
      await this.state.deletePromptContext?.(agent.id, clientNonce);
      return { delivered: turn.handled };
    } finally {
      this.endTurn(agent.id);
    }
  }

  /**
   * Deliver send-message entries to one chat. Each transcript entry has one
   * delivery key per agent, so the live turn, a recovered turn and the late
   * follower can never send the same entry twice. `turn` carries quoting and
   * handoff state across streaming calls.
   */
  async deliverEntries(agent, clientNonce, entries, { chatId, quoted, turn = newTurnState(), late = false }) {
    for (const entry of entries) {
      if (entry?.kind !== "send-message" || turn.stopped) continue;
      if (APPROVAL_ENTRY_TYPES.has(entry.message?.type)) {
        // Live turns announce approvals through onApproval; late ones here.
        if (late && (entry.message.approval?.status === "pending" || entry.message.ask?.status === "pending")) {
          await this.notifyApproval(chatId, entry);
        }
        continue;
      }
      const deliveryKey = `wa:${agent.id}:entry:${entry.id ?? "entry"}`;
      const legacyKey = clientNonce ? `wa:${agent.id}:${clientNonce}:${entry.id ?? "entry"}` : undefined;
      if (legacyKey && this.state.getDeliveryProgress?.(legacyKey)?.completed) continue;
      if (this.state.getDeliveryProgress?.(deliveryKey)?.completed) continue;
      const content = this.grok.getReplyContent([entry]);
      if (content.text === HANDOFF_NOTICE) {
        if (turn.handoffSent) {
          await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, handoffDuplicate: true });
          continue;
        }
        turn.handoffSent = true;
      }
      const claim = this.state.claimDeliveryProgress
        ? this.state.claimDeliveryProgress(deliveryKey)
        : { progress: { nextPart: 0 }, completed: false };
      if (claim.completed) continue;
      const progress = claim.progress;
      if (isSilentReply(content.text, content.attachments, this.options.silentTokens)) {
        this.log.info(`Silent reply chat=${chatId} entry=${entry.id}${late ? " late=yes" : ""}`);
        await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, silent: true });
        turn.handled += 1;
        continue;
      }
      let text = content.text ? toWhatsAppText(stripTranscriptPreamble(content.text)) : "";
      if (clientNonce && this.turnAccess.get(clientNonce) === "faq-only" && containsAccountData(text)) {
        // Code-level backstop: a sender who is not on the group's member list
        // (or not authorised) never gets amounts, facility codes or invoice numbers.
        this.log.warn(`Blocked account data for faq-only sender chat=${chatId} entry=${entry.id}`);
        text = toWhatsAppText(this.router.groupFor?.(chatId)?.faqOnlyBlockedReply ?? FAQ_ONLY_BLOCKED_REPLY);
        content.attachments = [];
      }
      // Smart split (opt-in per group): a few bubbles at natural breaks. The
      // choice is saved with the delivery progress so a restart mid-message
      // resumes on the same split. Only split when the rate budget allows it.
      if (progress.smart === undefined) {
        const splitOptions = this.router.groupFor?.(chatId)?.splitReplies ? this.options.smartSplit : undefined;
        const budget = this.guard.outboundBudget?.(chatId) ?? Infinity;
        const maxParts = splitOptions ? Math.min(splitOptions.maxParts ?? 3, budget - (content.attachments?.length ?? 0) - 1) : 1;
        progress.smart = maxParts > 1 ? maxParts : 0;
      }
      const textChunks = progress.smart ? smartSplit(text, { ...this.options.smartSplit, maxParts: progress.smart }) : splitText(text);
      const parts = [
        ...textChunks.map((chunk) => ({ type: "text", text: chunk })),
        ...(content.attachments ?? []).map((attachment) => ({ type: "file", attachment })),
      ];
      for (let index = progress.nextPart ?? 0; index < parts.length; index += 1) {
        const part = parts[index];
        const pace = progress.smart && part.type === "text" && index > 0;
        if (pace) {
          // Follow-up bubble of a split reply: show "typing…" for a beat, scaled to its length.
          await this.transport.setTyping?.(chatId, true)?.catch?.(() => {});
          await sleep(Math.min(3_000, Math.max(this.options.sendDelayMs, part.text.length * 8)));
        } else if (turn.sentParts > 0 && this.options.sendDelayMs > 0) await sleep(this.options.sendDelayMs);
        let gate = this.guard.takeOutbound(chatId, { windowMs: this.replyWindowMs() });
        // A genuine agent reply that only hit the per-minute rate waits for a free
        // slot (bounded) instead of being dropped for good.
        for (let waited = 0; !gate.ok && /^outbound-(?:chat|global)-rate$/.test(gate.reason) && waited < this.options.rateWaitMaxMs;) {
          const pause = Math.min(Math.max(250, this.guard.outboundWaitMs?.(chatId) ?? 1_000), this.options.rateWaitMaxMs - waited);
          if (waited === 0) this.log.info(`Outbound rate-limited chat=${chatId} entry=${entry.id}; waiting up to ${Math.round(this.options.rateWaitMaxMs / 1000)}s for a slot`);
          await sleep(pause);
          waited += pause;
          gate = this.guard.takeOutbound(chatId, { windowMs: this.replyWindowMs() });
        }
        if (!gate.ok) {
          this.log.warn(`Outbound dropped chat=${chatId} reason=${gate.reason} remainingParts=${parts.length - index}`);
          progress.dropped = gate.reason;
          turn.stopped = true;
          break;
        }
        const sendOptions = !turn.quoteUsed && quoted ? { quoted } : {};
        if (part.type === "text") {
          try {
            await this.transport.sendText(chatId, part.text, sendOptions);
          } catch (error) {
            this.guard.refundOutbound?.(chatId); // nothing was sent: don't burn rate budget on retries
            throw error;
          }
          if (pace) await this.transport.setTyping?.(chatId, false)?.catch?.(() => {});
          this.guard.recordOutboundText(chatId, part.text);
        } else {
          const filename = safeFilename(part.attachment.filename || part.attachment.path?.split("/").at(-1), "grok-file.bin");
          try {
            const bytes = await this.readAttachmentWithRetry(agent.id, part.attachment.path);
            await this.transport.sendFile(chatId, { bytes, filename, mimetype: guessMimeType(filename) }, sendOptions);
          } catch (error) {
            this.log.warn(`Attachment delivery failed chat=${chatId} file=${JSON.stringify(filename)} reason=${error.message}`);
            await this.transport.sendText(chatId, `File wasn't ready to send (${filename}).`, sendOptions);
          }
        }
        turn.quoteUsed = true;
        turn.sentParts += 1;
        progress.nextPart = index + 1;
        await this.state.setDeliveryProgress?.(deliveryKey, progress);
      }
      await this.state.completeDeliveryProgress?.(deliveryKey, progress);
      turn.handled += 1;
      if (!turn.stopped) this.log.info(`Delivered chat=${chatId} entry=${entry.id} parts=${parts.length}${late ? " late=yes" : ""}`);
    }
  }

  // ---- Late delivery: agent messages that arrive after their prompt's turn ----

  /** Is this chat, in the CURRENT config, routed to this agent? */
  chatServesAgent(chatId, agentId, agents = [], served) {
    let wanted = this.router.agentForChat?.(chatId);
    if (!wanted && served?.chatId === chatId && served.dmId) wanted = this.router.agentForChat?.(served.dmId);
    if (!wanted) return false;
    return wanted === agentId || this.resolveAgent(wanted, agents)?.id === agentId;
  }

  /** Which chat, if any, a late send-message entry belongs to. */
  lateTarget(agentId, owner, served, agents, entry) {
    const now = this.options.now();
    const windowMs = this.options.lateDeliveryWindowMs;
    if (Number.isFinite(entry?.timestampMs) && now - entry.timestampMs > windowMs) return undefined;
    if (owner?.kind === "other") return undefined; // desktop / Telegram / other client turn: not ours
    const chatId = owner?.kind === "whatsapp" ? owner.chatId : served?.chatId;
    if (!chatId) return undefined;
    if (!this.chatServesAgent(chatId, agentId, agents, served)) {
      this.log.warn(`Late message not delivered agent=${agentId} chat=${chatId} entry=${entry?.id} reason=chat-not-configured-for-agent`);
      return undefined;
    }
    const servedAt = Math.max(
      owner?.kind === "whatsapp" && Number.isFinite(owner.at) ? owner.at : 0,
      served?.chatId === chatId && Number.isFinite(served.at) ? served.at : 0,
    );
    if (!servedAt || now - servedAt > windowMs) return undefined;
    // The window is measured from that chat's own prompt (an accepted inbound message).
    this.guard.openReplyWindow(chatId, Math.min(servedAt, now));
    return { chatId, clientNonce: owner?.kind === "whatsapp" ? owner.clientNonce : undefined };
  }

  promptOwner(entry) {
    const chatId = chatFromNonce(entry?.clientNonce);
    return chatId
      ? { kind: "whatsapp", chatId, clientNonce: entry.clientNonce, at: Number.isFinite(entry.timestampMs) ? entry.timestampMs : undefined }
      : { kind: "other" };
  }

  async transcriptTail(agentId, options = {}) {
    try {
      return await this.grok.getTranscriptTail(agentId, 200, options);
    } catch (error) {
      if (!/HTTP 404$/.test(error.message)) throw error;
      return this.grok.getTranscript(agentId, options);
    }
  }

  /** One pass for one agent: deliver unseen send-message entries past the cursor. */
  async followAgent(agentId, served, agents, options = {}) {
    let entries = await this.transcriptTail(agentId, options);
    if (!entries.length) return;
    const cursor = this.state.getMirrorCursor?.(agentId);
    let cursorIndex;
    if (!cursor) {
      // First pass for this agent: start just before its latest recent WhatsApp
      // prompt (so nothing from that turn is lost), else at the newest entry.
      const now = this.options.now();
      let promptIndex = -1;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!isTopLevelPromptEntry(entry)) continue;
        if (chatFromNonce(entry.clientNonce)
          && (!Number.isFinite(entry.timestampMs) || now - entry.timestampMs <= this.options.lateDeliveryWindowMs)) promptIndex = index;
        break;
      }
      if (promptIndex < 0) {
        await this.state.setMirrorCursor(agentId, entries.at(-1)?.id ?? null);
        return;
      }
      cursorIndex = promptIndex - 1;
      await this.state.setMirrorCursor(agentId, cursorIndex >= 0 ? entries[cursorIndex].id : null);
    } else if (cursor.entryId === null) {
      cursorIndex = -1;
    } else {
      cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
      if (cursorIndex < 0) {
        entries = await this.grok.getTranscript(agentId, options);
        cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
        if (cursorIndex < 0) {
          this.log.warn(`Late delivery cursor not found agent=${agentId}; restarting from the newest entry`);
          await this.state.setMirrorCursor(agentId, entries.at(-1)?.id ?? null);
          return;
        }
      }
    }
    let owner;
    for (let index = cursorIndex; index >= 0; index -= 1) {
      if (isTopLevelPromptEntry(entries[index])) {
        owner = this.promptOwner(entries[index]);
        break;
      }
    }
    const turns = new Map();
    for (let index = cursorIndex + 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (typeof entry?.id !== "string" || !entry.id) break; // no cursor to advance to
      if (isTopLevelPromptEntry(entry)) {
        owner = this.promptOwner(entry);
      } else if (entry.kind === "send-message") {
        const target = this.lateTarget(agentId, owner, served, agents, entry);
        if (target) {
          if (!turns.has(target.chatId)) turns.set(target.chatId, newTurnState());
          await this.deliverEntries({ id: agentId }, target.clientNonce, [entry], {
            chatId: target.chatId,
            turn: turns.get(target.chatId),
            late: true,
          });
        }
      }
      await this.state.setMirrorCursor(agentId, entry.id);
    }
  }

  /** Poll every agent that served a chat recently and has no live turn. */
  async pollLateOnce(options = {}) {
    const windowMs = this.options.lateDeliveryWindowMs;
    if (!(windowMs > 0)) return;
    const now = this.options.now();
    let agents;
    for (const served of this.state.listLastServed?.() ?? []) {
      const { agentId } = served;
      if (!Number.isFinite(served.at) || now - served.at > windowMs) continue;
      if (this.activeTurns.has(agentId) || this.pendingRecovery.has(agentId)) continue;
      agents ??= await this.grok.listAgents(options);
      try {
        await this.withAgentLock(agentId, () => (this.activeTurns.has(agentId)
          ? undefined
          : this.followAgent(agentId, served, agents, options)));
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        this.log.warn(`Late delivery failed agent=${agentId} reason=${error.message}`);
      }
    }
  }

  /** Background loop for late delivery. Resolves when the signal aborts. */
  async runLateDelivery(options = {}) {
    if (!(this.options.lateDeliveryWindowMs > 0)) return;
    let failures = 0;
    while (!options.signal?.aborted) {
      try {
        await this.pollLateOnce(options);
        failures = 0;
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        failures += 1;
        this.log.warn(`Late delivery poll failed reason=${error.message}`);
      }
      const delay = failures ? Math.min(this.options.lateDeliveryPollMs * (2 ** failures), 60_000) : this.options.lateDeliveryPollMs;
      try {
        await sleep(delay, undefined, { signal: options.signal });
      } catch {
        break;
      }
    }
  }

  async readAttachmentWithRetry(agentId, attachmentPath) {
    let lastError;
    for (let attempt = 1; attempt <= ATTACHMENT_READ_ATTEMPTS; attempt += 1) {
      try {
        return await this.grok.readAttachment(agentId, attachmentPath);
      } catch (error) {
        lastError = error;
        if (/exceeds 20 MB|empty or exceeds|unsupported data attachment|invalid file attachment URL/i.test(error.message)) break;
        if (attempt < ATTACHMENT_READ_ATTEMPTS) await sleep(this.options.attachmentReadBackoffMs(attempt - 1));
      }
    }
    throw lastError;
  }

  /** Reply-only, rate-limited plain send used for help/status/notices. */
  async sendSimple(chatId, text, quoted) {
    const gate = this.guard.takeOutbound(chatId);
    if (!gate.ok) {
      this.log.warn(`Outbound dropped chat=${chatId} reason=${gate.reason}`);
      return false;
    }
    await this.transport.sendText(chatId, toWhatsAppText(text), quoted ? { quoted } : {});
    this.guard.recordOutboundText(chatId, text);
    return true;
  }

  async notifyApproval(chatId, entry, quoted) {
    if (!entry?.id || this.notifiedApprovals.has(entry.id)) return;
    this.notifiedApprovals.add(entry.id);
    if (this.notifiedApprovals.size > 500) this.notifiedApprovals.delete(this.notifiedApprovals.values().next().value);
    this.log.info(`Approval handed to desktop chat=${chatId} entry=${entry.id}`);
    await this.sendSimple(chatId, APPROVAL_NOTICE, quoted).catch((error) => this.log.warn(`Approval notice failed: ${error.message}`));
  }

  async handleError(input, error, _options = {}) {
    const primary = Array.isArray(input?.bundled) && input.bundled.length ? input.bundled[0] : input;
    const route = this.router.route(primary);
    if (!route.ok || !this.guard.hasReplyWindow(primary.chatId)) return;
    this.log.warn(`Turn failed chat=${primary.chatId} msg=${primary.id} reason=${error?.message ?? "unknown"}`);
    await this.sendSimple(primary.chatId, ERROR_NOTICE, this.quotedFor(route, primary))
      .catch((sendError) => this.log.error(`Error notice failed: ${sendError.message}`));
  }

  /**
   * After a restart, finish WhatsApp turns that were still waiting on the agent
   * (the reply goes back to the same chat, without a quote). Old ones are dropped.
   */
  async recoverPending(options = {}) {
    const agentIds = this.state.listPromptContextAgentIds?.() ?? [];
    // Same age limit as before: an old turn's first messages would arrive out of
    // order and stale. Anything the agent sends later is the late follower's job.
    const maxAgeMs = this.options.replyTimeoutMs * 2;
    const tasks = [];
    for (const agentId of agentIds) {
      const agentTasks = [];
      for (const context of this.state.listPromptContexts(agentId)) {
        if (context.origin !== "whatsapp" || !context.chatId) continue;
        const nonce = context.clientNonce ?? context.contextKey;
        const age = this.options.now() - (context.createdAt ?? 0);
        if (age > maxAgeMs) {
          this.log.warn(`Dropping stale pending turn chat=${context.chatId} ageMs=${age}`);
          await this.state.deletePromptContext(agentId, nonce);
          continue;
        }
        this.guard.openReplyWindow(context.chatId, context.createdAt);
        if (Number.isFinite(context.createdAt)) {
          await this.state.setLastServed?.(agentId, { chatId: context.chatId, at: context.createdAt });
        }
        this.log.info(`Recovering pending turn chat=${context.chatId} agent=${agentId}`);
        agentTasks.push(this.dispatcher.enqueue(`agent:${agentId}`, () => this.completeTurn({ id: agentId }, nonce, {
          chatId: context.chatId,
          signal: options.signal,
        }).catch((error) => this.log.warn(`Recovery failed chat=${context.chatId} reason=${error.message}`))));
      }
      if (!agentTasks.length) continue;
      // Keep the late follower off this agent until its recovered turns finish (keeps order).
      const done = Promise.allSettled(agentTasks).then(() => {
        if (this.pendingRecovery.get(agentId) === done) this.pendingRecovery.delete(agentId);
      });
      this.pendingRecovery.set(agentId, done);
      tasks.push(...agentTasks);
    }
    return Promise.allSettled(tasks);
  }

  /**
   * Proactive post without a human message (scripts/nudge.mjs -> state/nudges/).
   * Only for groups with "allowNudge": true. Sends the routed agent a synthetic
   * scheduled-check prompt; its reply goes out through the normal reply path
   * (rate limits, silent token, Bot_Log by the agent). At most one per group
   * per `scheduledCheckCooldownMs`.
   */
  async runScheduledCheck(chatId, { source = "local-cli", id = String(this.options.now()), signal } = {}) {
    const group = this.router.groupFor?.(chatId);
    if (!group) return { dropped: "group-not-configured" };
    if (!group.allowNudge) return { dropped: "nudge-not-allowed" };
    const cooldown = this.options.scheduledCheckCooldownMs ?? 120_000;
    const last = this.lastScheduledCheck.get(group.jid) ?? 0;
    if (this.options.now() - last < cooldown) return { dropped: "cooldown" };
    this.lastScheduledCheck.set(group.jid, this.options.now());
    const agents = await this.grok.listAgents({ signal });
    const agent = this.resolveAgent(group.agent, agents);
    if (!agent) {
      this.log.error(`Scheduled check: agent not found chat=${group.jid} agent=${JSON.stringify(group.agent)}`);
      return { dropped: "agent-not-found" };
    }
    const safeId = String(id).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "x";
    const clientNonce = `whatsapp:${group.jid}:nudge-${safeId}`;
    const header = buildContextHeader({
      sender: { name: "scheduled check" },
      chat: { jid: group.jid, type: "group", name: this.transport.chatName?.(group.jid) ?? group.name },
      member: { role: "system", authorised: true, access: "full", name: "bridge scheduler" },
      trigger: { kind: "scheduled-check", source: source === "bdm" ? "bdm" : "local-cli" },
    });
    return this.dispatcher.enqueue(`agent:${agent.id}`, async () => {
      // A deliberate, operator-triggered exception to reply-only: open this group's window now.
      this.guard.openReplyWindow(group.jid);
      this.beginTurn(agent.id);
      try {
        await this.grok.sendPrompt(agent.id, `${header}\n\n${SCHEDULED_CHECK_PROMPT}`, clientNonce, { signal });
        await this.state.setPromptContext(agent.id, clientNonce, {
          contextKey: clientNonce, clientNonce, origin: "whatsapp", chatId: group.jid, isGroup: true,
          createdAt: this.options.now(), awaitingCompletion: true,
        });
        await this.state.setLastServed?.(agent.id, { chatId: group.jid, at: this.options.now() });
        this.log.info(`Scheduled check sent chat=${group.jid} agent=${agent.id} source=${source}`);
        await this.completeTurn(agent, clientNonce, { chatId: group.jid, signal });
        return { handled: "scheduled-check", clientNonce, agentId: agent.id };
      } finally {
        this.endTurn(agent.id);
      }
    });
  }

  drain() {
    return this.dispatcher.drain();
  }
}
