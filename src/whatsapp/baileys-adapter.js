import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  useMultiFileAuthState,
} from "baileys";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { createBaileysLogger } from "../logger.js";
import { bareJid } from "../core/routing.js";
import { resolveMentions } from "./mentions.js";
import { normalizeMessage } from "./normalize.js";
import { ensurePrivateDir, readSessionInfo, writePrivateJson } from "./secure-fs.js";

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
  ]);
}

/** Like withTimeout, but rejects: a WhatsApp call that never settles must not wedge a queue. */
export function rejectAfter(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      // Ref'd on purpose: the timeout must fire even if nothing else is pending (cleared on settle).
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "WA_TIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class NeedsPairingError extends Error {
  constructor(message = "No paired WhatsApp session. Run the pair command first.") {
    super(message);
    this.name = "NeedsPairingError";
  }
}

/** Socket options chosen for a low-profile, reply-only linked device. */
export function socketOptions({ auth, logger, getMessage, cachedGroupMetadata }) {
  return {
    auth,
    logger,
    markOnlineOnConnect: false, // keep the phone getting notifications; don't look "always online"
    syncFullHistory: false,
    // Keep history sync ON: the phone's bootstrap sync carries per-contact privacy tokens (tctoken)
    // and LID mappings. Without them every 1:1 send fails with error 463. History messages arrive as
    // messaging-history.set / non-"notify" upserts, which the bridge ignores, so no old chat reaches a bot.
    shouldSyncHistoryMessage: () => true,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => Boolean(isJidStatusBroadcast(jid) || isJidNewsletter(jid) || isJidBroadcast(jid)),
    getMessage,
    cachedGroupMetadata,
  };
}

const TERMINAL_CODES = {
  [DisconnectReason.loggedOut]: ["logged-out", "WhatsApp logged this linked device out. Re-pair with the pair command (same spare SIM) before starting again."],
  [DisconnectReason.connectionReplaced]: ["connection-replaced", "Another session using this auth took over (a second bridge or a duplicate process). Stopped instead of fighting over the session."],
  [DisconnectReason.forbidden]: ["forbidden", "WhatsApp refused the connection (403). The number may be restricted or banned. Do not retry automatically; check the phone."],
  [DisconnectReason.multideviceMismatch]: ["needs-pairing", "Multi-device mismatch. Re-pair with the pair command."],
  [DisconnectReason.badSession]: ["bad-session", "The saved session is unreadable. Move auth/ aside and re-pair."],
};

/**
 * Baileys glue: owns the socket, reconnects with backoff, writes status.json,
 * checks allowlisted groups are visible, and implements the transport the
 * bridge core uses. The socket factory is injectable so tests can drive it
 * with a fake socket and never touch WhatsApp's servers.
 */
export class BaileysTransport {
  constructor({
    authDir,
    groups = [],
    log,
    status,
    onEvent,
    onOpen,
    makeSocket = makeWASocket,
    authStateFactory = useMultiFileAuthState,
    downloader = downloadMediaMessage,
    backoff = { baseMs: 2_000, maxMs: 5 * 60_000 },
    heartbeatMs = 60_000,
    baileysLogLevel = "warn",
    groupsListPath,
    // Liveness: Baileys pings every ~30s, so a connected socket sees a frame at least that often.
    // No frame for staleSocketMs while "connected" = silently dead socket: force a reconnect.
    staleSocketMs = 150_000,
    sendTimeoutMs = 90_000,
    typingTimeoutMs = 3_000,
    healthProbe,
    now = () => Date.now(),
    // Box pause detection: wall clock jumping ahead of the monotonic clock means the
    // whole machine was frozen (not our event loop). Check often, cheaply.
    pauseCheckMs = 5_000,
    pauseThresholdMs = 10_000,
    monotonic = () => performance.now(),
  }) {
    this.pauseCheckMs = pauseCheckMs;
    this.pauseThresholdMs = pauseThresholdMs;
    this.monotonic = monotonic;
    Object.assign(this, { authDir, groups, log, status, onEvent, onOpen, makeSocket, authStateFactory, downloader, backoff, heartbeatMs, groupsListPath, staleSocketMs, sendTimeoutMs, typingTimeoutMs, healthProbe, now });
    this.lastFrameAt = undefined;
    this.lastUpsertAt = undefined;
    this.baileysLogger = createBaileysLogger(log, baileysLogLevel);
    this.sock = undefined;
    this.connected = false;
    this.stopping = false;
    this.attempts = 0;
    this.subjects = new Map();
    this.groupMeta = new Map();
    this.sentMessages = new Map();
    this.stopped = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  async start() {
    ensurePrivateDir(this.authDir);
    const session = readSessionInfo(this.authDir);
    if (!session.registered) {
      await this.status.update({ state: "needs-pairing", detail: "No paired WhatsApp session in auth/. Run the pair command.", alert: true });
      throw new NeedsPairingError();
    }
    const { state, saveCreds } = await this.authStateFactory(this.authDir);
    this.authState = state;
    this.saveCreds = async () => {
      await saveCreds();
      await chmod(path.join(this.authDir, "creds.json"), 0o600).catch(() => {});
    };
    await this.status.update({ state: "connecting", account: session.account, alert: false, detail: undefined });
    // The heartbeat stays ref'd on purpose: it keeps the process alive while the
    // socket is closed between reconnect attempts (see scheduleReconnect).
    this.heartbeat = setInterval(() => this.heartbeatTick(), this.heartbeatMs);
    this.lastClock = { wall: this.now(), mono: this.monotonic() };
    if (this.pauseCheckMs > 0) {
      this.pauseTimer = setInterval(() => this.checkPause(), this.pauseCheckMs);
      this.pauseTimer.unref?.();
    }
    this.connect();
    return this.stopped;
  }

  /**
   * Every heartbeatMs: write liveness fields to status.json (read by the control
   * script's ensure) and kill a socket that is "connected" but receives nothing.
   */
  heartbeatTick({ skipWatchdog = false } = {}) {
    const now = this.now();
    let probe = {};
    try {
      probe = this.healthProbe?.() ?? {};
    } catch {}
    const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
    this.status.heartbeat({
      heartbeatAt: iso(now),
      lastFrameAt: iso(this.lastFrameAt),
      lastUpsertAt: iso(this.lastUpsertAt),
      pausesDetected: this.pausesDetected ?? 0,
      lastPauseAt: iso(this.lastPauseAt),
      lastPauseMs: this.lastPauseMs,
      ...probe,
    })?.catch?.((error) => this.log.warn(`Status heartbeat failed: ${error.message}`));
    if (!skipWatchdog && this.connected && !this.stopping && this.staleSocketMs > 0 && Number.isFinite(this.lastFrameAt)
      && now - this.lastFrameAt > this.staleSocketMs) {
      this.log.warn(`WhatsApp socket silent for ${Math.round((now - this.lastFrameAt) / 1000)}s while connected; forcing a reconnect`);
      this.lastFrameAt = now; // one kick per stale period
      try {
        this.sock?.end?.(Object.assign(new Error("Stale socket (no frames)"), { output: { statusCode: 408 } }));
      } catch (error) {
        this.log.warn(`Ending stale socket failed: ${error.message}`);
      }
    }
  }

  /**
   * The box can be suspended while idle: every process freezes, the monotonic
   * clock stops, the wall clock does not. On resume our timers still think little
   * time passed, WhatsApp has long dropped the socket, and status.json looks stale.
   * Detect it, say so in the log, refresh the heartbeat now and reconnect at once.
   */
  checkPause() {
    const wall = this.now();
    const mono = this.monotonic();
    const previous = this.lastClock ?? { wall, mono };
    this.lastClock = { wall, mono };
    const jumpMs = (wall - previous.wall) - (mono - previous.mono);
    if (!(jumpMs > this.pauseThresholdMs)) return false;
    this.log.warn(`Box was paused for about ${Math.round(jumpMs / 1000)}s (wall clock jumped, monotonic did not); refreshing heartbeat${this.connected ? " and reconnecting WhatsApp" : ""}`);
    this.pausesDetected = (this.pausesDetected ?? 0) + 1;
    this.lastPauseAt = wall;
    this.lastPauseMs = jumpMs;
    // The silence was the pause, not a dead socket: restart the frame clock so
    // status.json (read by ensure) doesn't report a stale frame during reconnect.
    this.lastFrameAt = wall;
    this.heartbeatTick({ skipWatchdog: true });
    if (this.connected && !this.stopping) {
      try {
        this.sock?.end?.(Object.assign(new Error("Box resumed from pause"), { output: { statusCode: 408 } }));
      } catch (error) {
        this.log.warn(`Ending socket after pause failed: ${error.message}`);
      }
    }
    return true;
  }

  /** connect() for timers and event handlers: a throw is logged and retried, never fatal. */
  safeConnect(reason = "reconnect") {
    try {
      this.connect();
    } catch (error) {
      this.log.error(`WhatsApp ${reason} failed: ${error?.stack ?? error?.message ?? error}`);
      if (!this.stopping) this.scheduleReconnect("connect-error");
    }
  }

  connect() {
    if (this.stopping) return;
    const sock = this.makeSocket(socketOptions({
      auth: this.authState,
      logger: this.baileysLogger,
      getMessage: async (key) => this.sentMessages.get(key?.id),
      cachedGroupMetadata: async (jid) => this.groupMeta.get(jid),
    }));
    this.sock = sock;
    this.lastFrameAt = this.now();
    // Any frame from WhatsApp (pings included) proves the socket is alive.
    sock.ws?.on?.("frame", () => { if (sock === this.sock) this.lastFrameAt = this.now(); });
    sock.ev.on("creds.update", () => void this.saveCreds().catch((error) => this.log.error(`Saving WhatsApp creds failed: ${error.message}`)));
    sock.ev.on("connection.update", (update) => void this.onConnectionUpdate(update, sock).catch((error) => this.log.error(`connection.update handler failed: ${error.message}`)));
    sock.ev.on("messages.upsert", (upsert) => this.onUpsert(upsert));
    sock.ev.on("messaging-history.set", (data) => {
      const chats = data?.chats ?? [];
      const withToken = chats.filter((chat) => chat?.tcToken?.length).length;
      this.log.info(`History sync received type=${data?.syncType ?? "?"} chats=${chats.length} withPrivacyToken=${withToken} (messages ignored)`);
    });
    sock.ev.on("groups.update", (updates) => {
      for (const update of updates ?? []) if (update?.id && typeof update.subject === "string") this.subjects.set(bareJid(update.id), update.subject);
    });
    sock.ev.on("groups.upsert", (groups) => {
      for (const group of groups ?? []) this.rememberGroup(group);
    });
    // Membership changed: the cached participant list is what Baileys encrypts to (and sends the
    // group sender key to). A stale list means new members see "Waiting for this message".
    sock.ev.on("group-participants.update", (update) => void this.refreshGroup(update?.id, sock, "participants"));
  }

  /** Drop the cached metadata for a group and refetch it, so new members get our sender key. */
  async refreshGroup(id, sock = this.sock, reason = "refresh") {
    const jid = bareJid(id);
    if (!jid) return;
    this.groupMeta.delete(jid); // until refetched, Baileys fetches fresh metadata itself
    try {
      const meta = await sock?.groupMetadata?.(jid);
      if (meta) this.rememberGroup(meta);
      this.log.info(`Group metadata refreshed (${reason}) participants=${meta?.participants?.length ?? "?"}`);
    } catch (error) {
      this.log.warn(`Group metadata refresh failed (${reason}): ${error?.message ?? error}`);
    }
  }

  rememberGroup(meta) {
    const jid = bareJid(meta?.id);
    if (!jid) return;
    this.groupMeta.set(jid, meta);
    if (typeof meta.subject === "string") this.subjects.set(jid, meta.subject);
  }

  async onConnectionUpdate(update, sock) {
    if (sock !== this.sock) return; // stale socket
    const { connection, lastDisconnect, qr } = update ?? {};
    if (qr) {
      // The running service never shows a QR: an unpaired session must be paired deliberately.
      await this.terminal("needs-pairing", "WhatsApp asked for a new login (QR). The session is not paired; run the pair command.");
      return;
    }
    if (connection === "connecting") {
      await this.status.update({ state: this.attempts ? "reconnecting" : "connecting" });
    } else if (connection === "open") {
      this.connected = true;
      this.attempts = 0;
      this.log.info(`WhatsApp connected account=${this.maskedAccount()}`);
      this.lastFrameAt = this.now();
      this.heartbeatTick({ skipWatchdog: true });
      await this.status.update({ state: "connected", connectedSince: new Date().toISOString(), reconnectAttempts: 0, lastDisconnectCode: undefined });
      await this.checkGroups();
      for (const waiter of this.connectionWaiters ?? []) waiter();
      this.connectionWaiters = [];
      await this.onOpen?.();
    } else if (connection === "close") {
      this.connected = false;
      if (this.stopping) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      const terminal = TERMINAL_CODES[code];
      if (terminal) {
        await this.terminal(terminal[0], terminal[1], code);
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        this.log.info("WhatsApp asked for a socket restart; reconnecting now");
        this.safeConnect("restart");
        return;
      }
      this.scheduleReconnect(code);
    }
  }

  scheduleReconnect(code) {
    this.attempts += 1;
    const base = Math.min(this.backoff.maxMs, this.backoff.baseMs * (2 ** (this.attempts - 1)));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.log.warn(`WhatsApp disconnected code=${code ?? "none"}; reconnect attempt ${this.attempts} in ${delay}ms`);
    this.status.update({ state: "reconnecting", lastDisconnectCode: code, reconnectAttempts: this.attempts, nextRetryInMs: delay })
      ?.catch?.((error) => this.log.warn(`Status update failed: ${error.message}`));
    clearTimeout(this.reconnectTimer);
    // NOT unref'd: while the socket is closed this timer may be the only thing
    // keeping Node's event loop alive. An unref'd timer let the process exit
    // silently (code 13, unsettled top-level await) right after a disconnect.
    this.reconnectTimer = setTimeout(() => {
      this.log.info(`WhatsApp reconnecting (attempt ${this.attempts})`);
      this.safeConnect("reconnect");
    }, delay);
  }

  async terminal(state, detail, code) {
    this.log.error(`ALERT WhatsApp bridge stopped: ${state}. ${detail}`);
    await this.status.update({ state, detail, lastDisconnectCode: code, alert: true, alertAt: new Date().toISOString() });
    await this.stop({ state, terminal: true });
  }

  async checkGroups() {
    const configured = this.groups.map((group) => ({ jid: bareJid(group.jid), name: group.name })).filter((group) => group.jid);
    let all;
    try {
      all = await this.sock.groupFetchAllParticipating();
    } catch (error) {
      this.log.warn(`Could not list WhatsApp groups: ${error.message}`);
      await this.status.update({ groupsCheck: "failed", groupsCheckedAt: new Date().toISOString() });
      return undefined;
    }
    for (const meta of Object.values(all ?? {})) this.rememberGroup(meta);
    await this.writeGroupsList(all);
    const visible = configured.filter((group) => this.groupMeta.has(group.jid)).map((group) => group.jid);
    for (const jid of visible) {
      const meta = this.groupMeta.get(jid);
      this.log.info(`Group ${jid} addressing=${meta?.addressingMode ?? "unknown"} participants=${meta?.participants?.length ?? "?"}`);
    }
    const missing = configured.filter((group) => !this.groupMeta.has(group.jid));
    for (const group of missing) {
      this.log.warn(`WARNING configured group NOT visible to this WhatsApp account: ${group.jid}${group.name ? ` (${group.name})` : ""}. Add the bridge number to the group or fix the JID in config.json.`);
    }
    this.log.info(`Group check configured=${configured.length} visible=${visible.length} missing=${missing.length}`);
    await this.status.update({
      groupsCheck: missing.length ? "missing" : "ok",
      groupsConfigured: configured.length,
      groupsVisible: visible,
      groupsMissing: missing.map((group) => group.jid),
      groupsCheckedAt: new Date().toISOString(),
    });
    return { visible, missing: missing.map((group) => group.jid) };
  }

  /**
   * Group id discovery (WhatsApp twin of the Telegram bridge's id logging):
   * a local mode-600 list of the groups this account is in, so the operator can
   * copy group JIDs into config.json. Nothing is sent to any chat.
   */
  async writeGroupsList(all) {
    if (!this.groupsListPath) return;
    const configured = new Set(this.groups.map((group) => bareJid(group.jid)));
    const groups = Object.values(all ?? {})
      .filter((meta) => meta?.id)
      .map((meta) => ({
        jid: meta.id,
        subject: typeof meta.subject === "string" ? meta.subject : "",
        participants: Array.isArray(meta.participants) ? meta.participants.length : undefined,
        addressing: meta.addressingMode,
        configured: configured.has(bareJid(meta.id)),
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    try {
      await writePrivateJson(this.groupsListPath, { updatedAt: new Date().toISOString(), groups });
    } catch (error) {
      this.log.warn(`Could not write the group list: ${error.message}`);
    }
  }

  onUpsert(upsert) {
    this.lastUpsertAt = this.now();
    // "notify" = new live messages. "append" = history/offline sync: never answered.
    if (upsert?.type !== "notify") return;
    const events = [];
    for (const message of upsert.messages ?? []) {
      let result;
      try {
        result = normalizeMessage(message);
      } catch (error) {
        this.log.warn(`Could not normalize a WhatsApp message: ${error.message}`);
        continue;
      }
      if (result.skip) {
        this.log.debug(`Skip message reason=${result.skip}`);
        continue;
      }
      events.push(result.event);
    }
    if (!events.length) return;
    const emit = (event) => Promise.resolve(this.onEvent(event)).catch((error) => this.log.error(`Inbound handling failed: ${error.message}`));
    // Fast path: every sender already has a phone number (or is not a LID).
    // Only groups with a configured member list need it, so other chats are untouched.
    const needsLookup = (event) => !event.sender?.pn && event.sender?.lid && this.groupHasMembers(event.chatId);
    if (!events.some(needsLookup)) {
      for (const event of events) emit(event);
      return;
    }
    // Some sender came as a bare @lid: look up its phone number first, keeping message order.
    this.inboundChain = (this.inboundChain ?? Promise.resolve()).then(async () => {
      for (const event of events) {
        if (needsLookup(event)) await this.resolveSenderPhone(event).catch((error) => this.log.debug(`LID lookup failed: ${error.message}`));
        emit(event);
      }
    });
  }

  groupHasMembers(chatId) {
    const jid = bareJid(chatId);
    return this.groups.some((group) => bareJid(group.jid) === jid && Array.isArray(group.members) && group.members.length > 0);
  }

  /**
   * WhatsApp can deliver group senders as "<id>@lid" only. Fill sender.pn from
   * Baileys' local LID<->phone map, else from the group's participant list.
   * Local lookups only; nothing is sent to WhatsApp.
   */
  async resolveSenderPhone(event) {
    const sender = event?.sender;
    if (!sender?.lid || sender.pn) return;
    let pn;
    const mapping = this.sock?.signalRepository?.lidMapping;
    if (typeof mapping?.getPNForLID === "function") {
      pn = bareJid(await Promise.race([
        mapping.getPNForLID(sender.lid),
        new Promise((resolve) => setTimeout(() => resolve(null), 1_500).unref?.()),
      ]) ?? undefined);
    }
    if (!pn && event.isGroup) {
      const participant = (this.groupMeta.get(event.chatId)?.participants ?? [])
        .find((entry) => bareJid(entry?.id) === sender.lid || bareJid(entry?.lid) === sender.lid);
      pn = [participant?.phoneNumber, participant?.jid, participant?.id].map(bareJid).find((id) => id?.endsWith("@s.whatsapp.net"));
    }
    if (pn && /^\d{5,20}@s\.whatsapp\.net$/.test(pn)) {
      sender.pn = pn;
      sender.pnSource = "lid-map";
    }
  }

  maskedAccount() {
    const user = this.sock?.user?.id?.split(":")[0]?.split("@")[0] ?? "";
    return user ? user.replace(/\d(?=\d{4})/g, "•") : "unknown";
  }

  selfIds() {
    return [bareJid(this.sock?.user?.id), bareJid(this.sock?.user?.lid)].filter(Boolean);
  }

  chatName(chatId) {
    return this.subjects.get(bareJid(chatId));
  }

  wasSentByUs(messageId) {
    return typeof messageId === "string" && this.sentMessages.has(messageId);
  }

  /** Resolve with the socket once connected (briefly waits out a reconnect). */
  async requireSocket(timeoutMs = 30_000) {
    if (this.sock && this.connected) return this.sock;
    if (this.stopping) throw new Error("WhatsApp socket is stopped");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WhatsApp socket is not connected")), timeoutMs);
      timer.unref?.();
      (this.connectionWaiters ??= []).push(() => { clearTimeout(timer); resolve(); });
    });
    return this.sock;
  }

  rememberSent(sent) {
    const id = sent?.key?.id;
    if (!id) return;
    this.sentMessages.set(id, sent.message);
    if (this.sentMessages.size > 500) this.sentMessages.delete(this.sentMessages.keys().next().value);
  }

  async sendText(chatId, text, { quoted } = {}) {
    const sock = await this.requireSocket();
    const content = await this.withMentions(chatId, text, sock);
    const sent = await rejectAfter(sock.sendMessage(chatId, content, quoted ? { quoted } : undefined), this.sendTimeoutMs, "WhatsApp sendMessage");
    this.rememberSent(sent);
    return { id: sent?.key?.id, mentions: content.mentions?.length ?? 0 };
  }

  /**
   * Turn "@<digits>" / "@+<digits>" tokens for people IN this chat into real
   * WhatsApp mentions (see mentions.js). Any failure falls back to plain text.
   */
  async withMentions(chatId, text, sock = this.sock) {
    if (typeof text !== "string" || !/@\+?\d{7,15}/.test(text)) return { text };
    try {
      const jid = bareJid(chatId);
      let meta;
      if (jid?.endsWith("@g.us")) {
        meta = this.groupMeta.get(jid);
        if (!meta?.participants?.length && typeof sock?.groupMetadata === "function") {
          meta = await withTimeout(sock.groupMetadata(jid), 5_000);
          if (meta) this.rememberGroup(meta);
        }
      }
      const configured = this.groups.find((group) => bareJid(group.jid) === jid);
      const knownIdSets = (configured?.members ?? []).map((member) => member?.ids ?? (member?.id ? [member.id] : []));
      const mapping = sock?.signalRepository?.lidMapping;
      const lookupLid = typeof mapping?.getLIDForPN === "function" ? (pn) => withTimeout(mapping.getLIDForPN(pn), 1_500) : undefined;
      const resolved = await resolveMentions(text, { chatId, meta, knownIdSets, lookupLid });
      if (!resolved.mentions.length) return { text };
      this.log.info(`Mentions attached chat=${chatId} count=${resolved.mentions.length} kind=${resolved.mentions.every((id) => id.endsWith("@lid")) ? "lid" : "pn"}`);
      return { text: resolved.text, mentions: resolved.mentions };
    } catch (error) {
      this.log.warn(`Mention resolution failed chat=${chatId}: ${error?.message ?? error}`);
      return { text };
    }
  }

  async sendFile(chatId, { bytes, filename, mimetype }, { quoted } = {}) {
    const buffer = Buffer.from(bytes);
    const content = /^image\/(?:jpeg|png|webp)$/i.test(mimetype ?? "")
      ? { image: buffer, mimetype }
      : { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: filename };
    const sock = await this.requireSocket();
    const sent = await rejectAfter(sock.sendMessage(chatId, content, quoted ? { quoted } : undefined), this.sendTimeoutMs, "WhatsApp sendMessage");
    this.rememberSent(sent);
    return { id: sent?.key?.id };
  }

  async downloadMedia(event) {
    const sock = await this.requireSocket();
    return this.downloader(event.raw, "buffer", {}, { logger: this.baileysLogger, reuploadRequest: sock.updateMediaMessage });
  }

  async setTyping(chatId, on) {
    if (!this.connected) return;
    await rejectAfter(this.sock.sendPresenceUpdate(on ? "composing" : "paused", chatId), this.typingTimeoutMs, "WhatsApp presence update");
  }

  /** Close the socket WITHOUT logging out (the pairing stays valid). */
  async stop(result = { state: "stopped" }) {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.pauseTimer);
    try {
      this.sock?.end?.(undefined);
    } catch {}
    this.connected = false;
    if (!result.terminal) await this.status.update({ state: "stopped" });
    this.resolveStopped(result);
    return this.stopped;
  }
}
