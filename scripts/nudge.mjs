#!/usr/bin/env node
/**
 * Ask the RUNNING bridge to run a "scheduled check" in one WhatsApp group:
 * the group's agent reads its Sheet and posts pending Ops_Requests and
 * due-soon repayment reminders (or stays silent if nothing is due).
 *
 *   node scripts/nudge.mjs --group 120363000000000003@g.us            # dry run, posts nothing
 *   node scripts/nudge.mjs --group 120363000000000003@g.us --yes-post # queue it (MAY POST to the group)
 *
 * Only groups with "allowNudge": true in config.json are accepted. This script
 * never talks to WhatsApp or the gateway itself: it drops a request file into
 * state/nudges/ (mode 700) and the bridge's normal reply path delivers the
 * agent's answer. Nothing is scheduled automatically.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { normalizeGroupJid } from "../src/core/routing.js";
import { queueNudge } from "../src/nudge-inbox.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (flag("help") || !value("group")) {
  console.log("usage: node scripts/nudge.mjs --group <jid>@g.us [--config ./config.json] [--yes-post]");
  process.exit(value("group") || flag("help") ? 0 : 2);
}

const config = loadConfig(value("config") ?? process.env.WA_BRIDGE_CONFIG ?? "config.json", { readToken: false });
const jid = normalizeGroupJid(value("group"));
const group = config.groups.find((entry) => entry.jid === jid);
if (!jid || !group) {
  console.error(`Group ${value("group")} is not in config.json groups.`);
  process.exit(2);
}
if (!group.allowNudge) {
  console.error(`Group ${jid} (${group.name ?? "unnamed"}) does not have "allowNudge": true in config.json. Refusing.`);
  process.exit(2);
}

const stateDir = path.dirname(config.statusPath);
const statusFile = path.join(stateDir, "status.json");
const status = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")) : {};
if (status.state !== "connected") console.warn(`Warning: bridge status is "${status.state ?? "unknown"}", not "connected"; the request waits up to 10 min.`);

if (!flag("yes-post")) {
  console.log(`DRY RUN: would ask agent ${group.agent} to run a scheduled check in "${group.name ?? jid}" (${jid}).`);
  console.log("It may post pending Ops_Requests / repayment reminders INTO THE GROUP. Re-run with --yes-post to queue it.");
  process.exit(0);
}

const queued = queueNudge(path.join(stateDir, "nudges"), { group: jid });
console.log(`Queued scheduled check id=${queued.id} for "${group.name ?? jid}". The running bridge picks it up within ~2 s.`);
console.log("Watch bridge.log for: 'Nudge request picked up', 'Scheduled check sent', then 'Delivered' or 'Silent reply'.");
