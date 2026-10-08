import { readFileSync } from "node:fs";
import { writePrivateJson } from "./secure-fs.js";

/**
 * status.json is how the control script (and the operator) see the socket's health:
 *   state: starting | connecting | connected | reconnecting | stopped
 *          | needs-pairing | logged-out | connection-replaced | forbidden | bad-session
 * Terminal states (TERMINAL_STATES) mean "a human must act": ensure will not restart.
 */
export const TERMINAL_STATES = Object.freeze(["needs-pairing", "logged-out", "connection-replaced", "forbidden", "bad-session"]);

export class StatusFile {
  constructor(filename, { now = () => Date.now() } = {}) {
    this.filename = filename;
    this.now = now;
    this.current = { state: "starting", pid: process.pid };
    this.queue = Promise.resolve();
  }

  update(patch) {
    this.current = { ...this.current, ...patch, pid: process.pid, updatedAt: new Date(this.now()).toISOString() };
    const snapshot = { ...this.current };
    this.queue = this.queue.then(() => writePrivateJson(this.filename, snapshot)).catch(() => {});
    return this.queue;
  }

  heartbeat() {
    return this.update({});
  }

  static read(filename) {
    try {
      return JSON.parse(readFileSync(filename, "utf8"));
    } catch {
      return undefined;
    }
  }
}
