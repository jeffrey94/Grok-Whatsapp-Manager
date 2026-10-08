import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Offline stand-in for a Baileys socket. It never opens a network connection:
 * tests drive it by emitting the same events Baileys emits.
 */
export class FakeSocket {
  constructor(options, { user = { id: "60111111111:5@s.whatsapp.net", lid: "99999999999999:5@lid" }, groups = {} } = {}) {
    this.options = options;
    this.ev = new EventEmitter();
    this.user = user;
    this.groups = groups;
    this.sent = [];
    this.presence = [];
    this.ended = false;
    this.pairingRequests = [];
    this.counter = 0;
  }

  async sendMessage(jid, content, options) {
    this.counter += 1;
    const id = `BOTMSG${this.counter}`;
    this.sent.push({ jid, content, options });
    return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: content.text ?? "[media]" } };
  }

  async groupFetchAllParticipating() {
    return this.groups;
  }

  async sendPresenceUpdate(type, jid) {
    this.presence.push([type, jid]);
  }

  async requestPairingCode(phone) {
    this.pairingRequests.push(phone);
    return "ABCD1234";
  }

  async updateMediaMessage(message) {
    return message;
  }

  end() {
    this.ended = true;
  }

  // helpers for tests
  open() { this.ev.emit("connection.update", { connection: "open" }); }
  close(statusCode) { this.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode } } } }); }
  deliver(messages, type = "notify") { this.ev.emit("messages.upsert", { messages, type }); }
}

export function fakeSocketFactory(socketOptions = {}) {
  const sockets = [];
  const make = (options) => {
    const sock = new FakeSocket(options, socketOptions);
    sockets.push(sock);
    return sock;
  };
  make.sockets = sockets;
  return make;
}

export function fakeAuthStateFactory() {
  return async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} });
}

export function writePairedCreds(authDir, id = "60111111111:5@s.whatsapp.net") {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ registered: true, me: { id } }), { mode: 0o600 });
}

export const quietLog = { debug() {}, info() {}, log() {}, warn() {}, error() {} };

export function recordingLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, debug: push("debug"), info: push("info"), log: push("info"), warn: push("warn"), error: push("error") };
}

export async function waitFor(predicate, timeoutMs = 3_000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitFor timed out");
}
