import path from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { normalizeGroupJid, normalizeUserId } from "./core/routing.js";
import { DEFAULT_LIMITS } from "./core/loop-guard.js";
import { DEFAULT_BUNDLING } from "./core/dispatcher.js";
import { DEFAULT_SILENT_TOKENS } from "./core/chat-policy.js";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** Read a small secret-bearing file: regular file, not a symlink, not group/other accessible. */
export function readPrivateFile(filename, label) {
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be readable by group or others (chmod 600 ${filename})`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Same rules as the Telegram bridge: token read in memory from a mode-600 gateway.json. */
export function gatewayToken(tokenFile) {
  if (!tokenFile) throw new Error("gateway.tokenFile is required");
  const raw = readPrivateFile(tokenFile, "gateway.tokenFile");
  try {
    const parsed = JSON.parse(raw);
    const token = parsed.gatewayToken ?? parsed.token;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {}
  throw new Error("gateway.tokenFile does not contain a recognized gateway token field");
}

export function assertLoopbackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("gateway.url must be a valid URL");
  }
  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) throw new Error("gateway.url must use a loopback host");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("gateway.url must be http(s)");
  return url.replace(/\/$/, "");
}

function positiveInt(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function isPlaceholder(value) {
  return typeof value === "string" && /replace|placeholder|<.*>|example/i.test(value);
}

/**
 * Parse and validate a config object (already read from disk). Pure: no I/O
 * except reading the gateway token when `readToken` is true.
 */
export function parseConfig(raw, { baseDir = process.cwd(), readToken = true } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const gatewayUrl = assertLoopbackUrl(raw.gateway?.url ?? "http://127.0.0.1:1340");
  const tokenFile = raw.gateway?.tokenFile ?? "/home/box/sand-data/gateway.json";
  const resolve = (value, fallback) => path.resolve(baseDir, value ?? fallback);

  const defaultAgent = typeof raw.defaultAgent === "string" ? raw.defaultAgent.trim() : "";
  if (!defaultAgent || isPlaceholder(defaultAgent)) throw new Error("defaultAgent must be set to a Grok agent id");

  const dms = [];
  for (const entry of raw.dms ?? []) {
    const item = typeof entry === "string" ? { id: entry } : entry;
    const id = normalizeUserId(item?.id);
    if (!id) throw new Error(`dms entry ${JSON.stringify(item?.id)} is not a phone number or @lid/@s.whatsapp.net JID`);
    dms.push({ id, agent: typeof item.agent === "string" && item.agent.trim() ? item.agent.trim() : undefined, name: item.name });
  }

  const groups = [];
  const seenGroups = new Set();
  for (const group of raw.groups ?? []) {
    const jid = normalizeGroupJid(group?.jid);
    if (!jid) throw new Error(`groups entry ${JSON.stringify(group?.jid)} is not a group JID (…@g.us)`);
    if (seenGroups.has(jid)) throw new Error(`group ${jid} is listed twice (one agent per group)`);
    seenGroups.add(jid);
    const agent = typeof group.agent === "string" ? group.agent.trim() : "";
    if (!agent || isPlaceholder(agent)) throw new Error(`group ${jid} must map to one Grok agent id`);
    if (group.mode !== undefined && !["mention", "all"].includes(group.mode)) {
      throw new Error(`group ${jid} mode must be "mention" or "all"`);
    }
    if (group.members !== undefined) {
      if (!Array.isArray(group.members)) throw new Error(`group ${jid} members must be a list`);
      for (const member of group.members) {
        const ids = member?.ids ?? (member?.id ? [member.id] : []);
        if (!Array.isArray(ids) || !ids.length || ids.some((id) => !normalizeUserId(id))) {
          throw new Error(`group ${jid} member ${JSON.stringify(member?.name ?? "?")} needs ids: phone numbers or @lid JIDs`);
        }
        if (typeof member.role !== "string" || !member.role.trim()) throw new Error(`group ${jid} member ${JSON.stringify(member?.name ?? "?")} needs a role`);
      }
    }
    for (const sender of group.allowSenders ?? []) {
      if (!normalizeUserId(sender)) throw new Error(`group ${jid} allowSenders entry ${JSON.stringify(sender)} is invalid`);
    }
    groups.push({
      jid,
      name: typeof group.name === "string" ? group.name : undefined,
      agent,
      mode: group.mode ?? "mention",
      keywords: Array.isArray(group.keywords) ? group.keywords.filter((k) => typeof k === "string") : [],
      allowSenders: group.allowSenders ?? [],
      quoteReplies: group.quoteReplies !== false,
      splitReplies: group.splitReplies === true,
      ...(group.members !== undefined ? { members: group.members } : {}),
      ...(group.defaultMember !== undefined && group.members !== undefined ? { defaultMember: group.defaultMember } : {}),
      allowNudge: group.allowNudge === true,
      checkCommand: group.checkCommand === true,
      faqOnlyGuard: group.faqOnlyGuard !== false,
      ...(typeof group.faqOnlyBlockedReply === "string" ? { faqOnlyBlockedReply: group.faqOnlyBlockedReply } : {}),
    });
  }
  if (!dms.length && !groups.length) throw new Error("allowlist is empty: add at least one dms or groups entry");

  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(raw.limits ?? {})) {
    if (!(key in DEFAULT_LIMITS)) throw new Error(`unknown limits.${key}`);
    limits[key] = positiveInt(value, `limits.${key}`, DEFAULT_LIMITS[key]);
  }
  const bundling = raw.bundling === false ? false : { ...DEFAULT_BUNDLING };
  if (bundling) {
    for (const [key, value] of Object.entries(raw.bundling ?? {})) {
      if (!(key in DEFAULT_BUNDLING)) throw new Error(`unknown bundling.${key}`);
      bundling[key] = positiveInt(value, `bundling.${key}`, DEFAULT_BUNDLING[key]);
    }
  }
  const silentTokens = Array.isArray(raw.silentTokens) && raw.silentTokens.length
    ? [...new Set([...DEFAULT_SILENT_TOKENS, ...raw.silentTokens.filter((t) => typeof t === "string" && t.trim())])]
    : [...DEFAULT_SILENT_TOKENS];

  return {
    gatewayUrl,
    gatewayTokenFile: tokenFile,
    gatewayToken: readToken ? gatewayToken(tokenFile) : undefined,
    defaultAgent,
    dms,
    groups,
    ignoreSenders: (raw.ignoreSenders ?? []).map(normalizeUserId).filter(Boolean),
    authDir: resolve(raw.authDir, "auth"),
    statePath: resolve(raw.statePath, "state/bridge-state.json"),
    statusPath: resolve(raw.statusPath, "state/status.json"),
    replyTimeoutMs: positiveInt(raw.replyTimeoutMs, "replyTimeoutMs", 10 * 60_000),
    // Max time one turn holds its agent's queue before the next message is handled (0 = no cap).
    turnQueueHoldMs: positiveInt(raw.turnQueueHoldMs, "turnQueueHoldMs", 120_000),
    pollIntervalMs: positiveInt(raw.pollIntervalMs, "pollIntervalMs", 1_000),
    stableReplyMs: raw.stableReplyMs === undefined ? undefined : positiveInt(raw.stableReplyMs, "stableReplyMs", undefined),
    // Late agent messages (after the turn) go to the chat the agent last served for this long; 0 = off.
    lateDeliveryWindowMs: positiveInt(raw.lateDeliveryWindowMs, "lateDeliveryWindowMs", 60 * 60_000),
    maxMessageAgeSec: positiveInt(raw.maxMessageAgeSec, "maxMessageAgeSec", 600),
    sendDelayMs: positiveInt(raw.sendDelayMs, "sendDelayMs", 1_200),
    typingIndicator: raw.typingIndicator !== false,
    quoteInDms: raw.quoteInDms === true,
    voiceHint: typeof raw.voiceHint === "string" && raw.voiceHint.trim() ? raw.voiceHint.trim() : undefined,
    limits,
    bundling,
    silentTokens,
    logLevel: ["debug", "info", "warn", "error"].includes(raw.logLevel) ? raw.logLevel : "info",
  };
}

/** Load config.json (must be mode 600: it holds the allowlist and agent map). */
export function loadConfig(configPath, options = {}) {
  const absolute = path.resolve(configPath);
  const text = readPrivateFile(absolute, "config file");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`config file is not valid JSON: ${error.message}`);
  }
  return { ...parseConfig(raw, { baseDir: path.dirname(absolute), ...options }), configPath: absolute };
}
