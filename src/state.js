import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function promptTurnBoundaryKey(agentId, clientNonce) {
  return JSON.stringify([agentId, clientNonce]);
}

export class JsonStateStore {
  constructor(filename) {
    this.filename = filename;
    this.offset = 0;
    this.agentsByChat = {};
    this.pendingApprovals = {};
    this.mirrorEnabled = undefined;
    this.mirrorCursors = {};
    this.promptTurnBoundaries = {};
    this.promptContexts = {};
    this.retiredPromptTurns = {};
    this.pendingDeliveries = {};
    this.topicNamesByChat = {};
    this.lastServedByAgent = {};
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const descriptor = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try {
        const metadata = await descriptor.stat();
        if (!metadata.isFile()) throw new Error("BRIDGE_STATE_PATH must be a regular file");
        if ((metadata.mode & 0o077) !== 0) {
          throw new Error("BRIDGE_STATE_PATH must not be readable or writable by group or others");
        }
        raw = await descriptor.readFile("utf8");
      } finally {
        await descriptor.close();
      }
      const parsed = JSON.parse(raw);
      this.offset = Number.isSafeInteger(parsed.offset) ? parsed.offset : 0;
      this.agentsByChat = parsed.agentsByChat && typeof parsed.agentsByChat === "object"
        ? parsed.agentsByChat
        : {};
      this.pendingApprovals = parsed.pendingApprovals && typeof parsed.pendingApprovals === "object"
        ? parsed.pendingApprovals
        : {};
      this.mirrorEnabled = typeof parsed.mirrorEnabled === "boolean" ? parsed.mirrorEnabled : undefined;
      this.mirrorCursors = parsed.mirrorCursors && typeof parsed.mirrorCursors === "object"
        ? parsed.mirrorCursors
        : {};
      this.promptTurnBoundaries = parsed.promptTurnBoundaries
        && typeof parsed.promptTurnBoundaries === "object"
        ? parsed.promptTurnBoundaries
        : {};
      this.promptContexts = parsed.promptContexts && typeof parsed.promptContexts === "object"
        ? parsed.promptContexts
        : {};
      this.retiredPromptTurns = parsed.retiredPromptTurns && typeof parsed.retiredPromptTurns === "object"
        ? parsed.retiredPromptTurns
        : {};
      this.pendingDeliveries = parsed.pendingDeliveries && typeof parsed.pendingDeliveries === "object"
        ? parsed.pendingDeliveries
        : {};
      this.topicNamesByChat = parsed.topicNamesByChat && typeof parsed.topicNamesByChat === "object"
        ? parsed.topicNamesByChat
        : {};
      this.lastServedByAgent = parsed.lastServedByAgent && typeof parsed.lastServedByAgent === "object"
        ? parsed.lastServedByAgent
        : {};
      const approvalsChanged = this.#pruneExpiredApprovals();
      const promptContextsChanged = this.#preparePromptContextsAfterLoad();
      if (approvalsChanged || promptContextsChanged) await this.#save();
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (!(error instanceof SyntaxError)) throw error;
      const quarantined = `${this.filename}.corrupt-${Date.now()}`;
      await rename(this.filename, quarantined);
      console.error(`Unreadable bridge state moved to ${quarantined}`);
    }
  }

  getAgent(chatId) {
    return this.agentsByChat[String(chatId)];
  }

  async setAgent(chatId, agentId) {
    this.agentsByChat[String(chatId)] = agentId;
    await this.#save();
  }

  /** Learned forum topic names: { "<chatId>": { "<threadId>": "<name>" } }. */
  listTopicNames() {
    return this.topicNamesByChat;
  }

  getTopicName(chatId, threadId) {
    const name = this.topicNamesByChat[String(chatId)]?.[String(threadId)];
    return typeof name === "string" && name ? name : undefined;
  }

  async setTopicName(chatId, threadId, name) {
    if (this.getTopicName(chatId, threadId) === name) return false;
    const chatKey = String(chatId);
    this.topicNamesByChat[chatKey] = { ...(this.topicNamesByChat[chatKey] ?? {}), [String(threadId)]: name };
    await this.#save();
    return true;
  }

  isMirrorEnabled(configured) {
    return configured && this.mirrorEnabled !== false;
  }

  async setMirrorEnabled(enabled) {
    this.mirrorEnabled = enabled;
    await this.#save();
  }

  getMirrorCursor(agentId) {
    const cursor = this.mirrorCursors[agentId];
    return cursor?.initialized === true ? cursor : undefined;
  }

  async setMirrorCursor(agentId, entryId) {
    this.mirrorCursors[agentId] = {
      initialized: true,
      entryId: typeof entryId === "string" && entryId ? entryId : null,
    };
    await this.#save();
  }

  /** Which chat an agent last answered through this bridge: { chatId, at, dmId? }. */
  getLastServed(agentId) {
    const record = this.lastServedByAgent[agentId];
    return record && typeof record.chatId === "string" ? record : undefined;
  }

  listLastServed() {
    return Object.entries(this.lastServedByAgent)
      .filter(([, record]) => record && typeof record.chatId === "string")
      .map(([agentId, record]) => ({ agentId, ...record }));
  }

  async setLastServed(agentId, record) {
    const current = this.getLastServed(agentId);
    if (current && Number.isFinite(current.at) && Number.isFinite(record?.at) && current.at > record.at) return false;
    this.lastServedByAgent[agentId] = { ...record };
    await this.#save();
    return true;
  }

  getPromptTurnBoundary(agentId, clientNonce) {
    const boundary = this.promptTurnBoundaries[promptTurnBoundaryKey(agentId, clientNonce)];
    return typeof boundary === "string" && boundary ? boundary : undefined;
  }

  async setPromptTurnBoundary(agentId, clientNonce, entryId) {
    const key = promptTurnBoundaryKey(agentId, clientNonce);
    if (Object.hasOwn(this.retiredPromptTurns, key)) return false;
    this.promptTurnBoundaries[key] = entryId;
    await this.#save();
    return true;
  }

  getPromptContext(agentId, clientNonce) {
    return this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)];
  }

  listPromptContexts(agentId) {
    return Object.entries(this.promptContexts).flatMap(([key, context]) => {
      try {
        const [contextAgentId, clientNonce] = JSON.parse(key);
        return contextAgentId === agentId ? [{ clientNonce, ...context }] : [];
      } catch {
        return [];
      }
    });
  }

  listPromptContextAgentIds() {
    return [...new Set(Object.keys(this.promptContexts).flatMap((key) => {
      try {
        const [agentId] = JSON.parse(key);
        return typeof agentId === "string" && agentId ? [agentId] : [];
      } catch {
        return [];
      }
    }))];
  }

  async setPromptContext(agentId, clientNonce, context) {
    this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)] = context;
    await this.#save();
  }

  async deletePromptContext(agentId, clientNonce) {
    delete this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)];
    await this.#save();
  }

  async deletePromptTurnBoundary(agentId, clientNonce) {
    delete this.promptTurnBoundaries[promptTurnBoundaryKey(agentId, clientNonce)];
    await this.#save();
  }

  isPromptTurnRetired(agentId, clientNonce) {
    return Object.hasOwn(this.retiredPromptTurns, promptTurnBoundaryKey(agentId, clientNonce));
  }

  async retirePromptTurn(agentId, clientNonce, entryId) {
    const key = promptTurnBoundaryKey(agentId, clientNonce);
    delete this.promptTurnBoundaries[key];
    this.retiredPromptTurns[key] = entryId;
    const keys = Object.keys(this.retiredPromptTurns);
    for (const expiredKey of keys.slice(0, Math.max(0, keys.length - 200))) {
      delete this.retiredPromptTurns[expiredKey];
    }
    await this.#save();
  }

  listPromptTurnBoundaries(agentId) {
    const boundaries = [];
    for (const [key, entryId] of Object.entries(this.promptTurnBoundaries)) {
      try {
        const [boundaryAgentId, clientNonce] = JSON.parse(key);
        if (boundaryAgentId === agentId && typeof clientNonce === "string"
          && typeof entryId === "string" && entryId) boundaries.push({ clientNonce, entryId });
      } catch {}
    }
    return boundaries;
  }

  listPromptTurnBoundaryAgentIds() {
    const agentIds = [];
    for (const key of Object.keys(this.promptTurnBoundaries)) {
      try {
        const [agentId, clientNonce] = JSON.parse(key);
        if (typeof agentId === "string" && agentId && typeof clientNonce === "string" && clientNonce) {
          agentIds.push(agentId);
        }
      } catch {}
    }
    return [...new Set(agentIds)];
  }

  async setOffset(offset) {
    this.offset = offset;
    await this.#save();
  }

  getApproval(token) {
    return this.pendingApprovals[token];
  }

  listApprovals() {
    return Object.entries(this.pendingApprovals);
  }

  async setApproval(token, approval) {
    this.#pruneExpiredApprovals();
    this.pendingApprovals[token] = approval;
    await this.#save();
  }

  async deleteApproval(token) {
    delete this.pendingApprovals[token];
    await this.#save();
  }

  getDeliveryProgress(key) {
    return this.pendingDeliveries[key];
  }

  /**
   * Synchronously claim a delivery key so concurrent awaiters cannot both send.
   * Returns { progress, completed, isNewClaim }.
   */
  claimDeliveryProgress(key) {
    const existing = this.pendingDeliveries[key];
    if (existing?.completed) {
      return { progress: existing, completed: true, isNewClaim: false };
    }
    if (existing) {
      return { progress: existing, completed: false, isNewClaim: false };
    }
    const progress = { nextPart: 0, claimed: true, completed: false };
    this.pendingDeliveries[key] = progress;
    return { progress, completed: false, isNewClaim: true };
  }

  async setDeliveryProgress(key, progress) {
    this.pendingDeliveries[key] = progress;
    this.#pruneCompletedDeliveries();
    await this.#save();
  }

  async completeDeliveryProgress(key, progress = {}) {
    const current = this.pendingDeliveries[key] ?? {};
    this.pendingDeliveries[key] = {
      ...current,
      ...progress,
      claimed: true,
      completed: true,
    };
    this.#pruneCompletedDeliveries();
    await this.#save();
  }

  async deleteDeliveryProgress(key) {
    delete this.pendingDeliveries[key];
    await this.#save();
  }

  #pruneCompletedDeliveries() {
    const completedKeys = Object.entries(this.pendingDeliveries)
      .filter(([, progress]) => progress?.completed)
      .map(([key]) => key);
    for (const expiredKey of completedKeys.slice(0, Math.max(0, completedKeys.length - 200))) {
      delete this.pendingDeliveries[expiredKey];
    }
  }

  #pruneExpiredApprovals(now = Date.now()) {
    let changed = false;
    for (const [token, approval] of Object.entries(this.pendingApprovals)) {
      if (approval?.type === "routine-widget" && approval.submissionIntent === true) continue;
      if (Number.isFinite(approval?.expiresAt) && approval.expiresAt <= now) {
        delete this.pendingApprovals[token];
        changed = true;
      }
    }
    return changed;
  }

  #preparePromptContextsAfterLoad() {
    let changed = false;
    for (const context of Object.values(this.promptContexts)) {
      if (context?.awaitingCompletion === true) {
        context.awaitingCompletion = false;
        changed = true;
      }
    }
    return changed;
  }

  async #save() {
    const save = async () => {
      const temporary = `${this.filename}.${process.pid}.tmp`;
      const payload = `${JSON.stringify({
        offset: this.offset,
        agentsByChat: this.agentsByChat,
        pendingApprovals: this.pendingApprovals,
        ...(this.mirrorEnabled === undefined ? {} : { mirrorEnabled: this.mirrorEnabled }),
        ...(Object.keys(this.mirrorCursors).length ? { mirrorCursors: this.mirrorCursors } : {}),
        ...(Object.keys(this.promptTurnBoundaries).length
          ? { promptTurnBoundaries: this.promptTurnBoundaries }
          : {}),
        ...(Object.keys(this.promptContexts).length ? { promptContexts: this.promptContexts } : {}),
        ...(Object.keys(this.retiredPromptTurns).length
          ? { retiredPromptTurns: this.retiredPromptTurns }
          : {}),
        ...(Object.keys(this.pendingDeliveries).length ? { pendingDeliveries: this.pendingDeliveries } : {}),
        ...(Object.keys(this.topicNamesByChat).length ? { topicNamesByChat: this.topicNamesByChat } : {}),
        ...(Object.keys(this.lastServedByAgent).length ? { lastServedByAgent: this.lastServedByAgent } : {}),
      })}\n`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filename);
    };
    const pending = this.saveQueue.then(save, save);
    this.saveQueue = pending.catch(() => {});
    await pending;
  }
}
