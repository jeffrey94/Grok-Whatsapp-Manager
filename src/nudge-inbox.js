import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeGroupJid } from "./core/routing.js";
import { ensurePrivateDir } from "./whatsapp/secure-fs.js";

/**
 * Local, file-based trigger for proactive posts ("nudges"). scripts/nudge.mjs
 * drops a small JSON request into state/nudges/ (mode 700); the running bridge
 * picks it up and runs bridge.runScheduledCheck(group). Nothing listens on the
 * network, and nothing is sent unless someone on the box writes a request.
 */
export const NUDGE_MAX_AGE_MS = 10 * 60_000;

export function queueNudge(dir, { group, source = "local-cli", now = Date.now() } = {}) {
  const jid = normalizeGroupJid(group);
  if (!jid) throw new Error(`not a group JID: ${JSON.stringify(group)}`);
  ensurePrivateDir(dir);
  const id = `${now}-${randomUUID().slice(0, 8)}`;
  const finalPath = path.join(dir, `${id}.json`);
  const tmpPath = path.join(dir, `.${id}.tmp`);
  writeFileSync(tmpPath, JSON.stringify({ group: jid, source, requestedAt: now, id }), { mode: 0o600, flag: "wx" });
  renameSync(tmpPath, finalPath);
  return { id, path: finalPath, group: jid };
}

/** Claim and parse every pending request (oldest first). Bad, stale or unsafe files are discarded. */
export function takeNudges(dir, { now = Date.now(), maxAgeMs = NUDGE_MAX_AGE_MS, log } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => /^[0-9]+-[0-9a-f]{8}\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const requests = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        log?.warn?.(`Nudge request ignored file=${name} reason=unsafe-file`);
        unlinkSync(file);
        continue;
      }
      const request = JSON.parse(readFileSync(file, "utf8"));
      unlinkSync(file);
      const group = normalizeGroupJid(request?.group);
      if (!group) {
        log?.warn?.(`Nudge request ignored file=${name} reason=bad-group`);
        continue;
      }
      if (!Number.isFinite(request.requestedAt) || now - request.requestedAt > maxAgeMs) {
        log?.warn?.(`Nudge request ignored file=${name} reason=stale`);
        continue;
      }
      requests.push({ group, id: String(request.id ?? name).replace(/[^A-Za-z0-9-]/g, ""), source: request.source === "bdm" ? "bdm" : "local-cli" });
    } catch (error) {
      log?.warn?.(`Nudge request ignored file=${name} reason=${error.message}`);
      try { unlinkSync(file); } catch {}
    }
  }
  return requests;
}

/** Background loop in the bridge process. Resolves when the signal aborts. */
export async function runNudgeInbox(bridge, { dir, pollMs = 2_000, signal, log } = {}) {
  ensurePrivateDir(dir);
  while (!signal?.aborted) {
    try {
      for (const request of takeNudges(dir, { now: bridge.options.now(), log })) {
        log?.info?.(`Nudge request picked up chat=${request.group} id=${request.id}`);
        void bridge.runScheduledCheck(request.group, { source: request.source, id: request.id, signal })
          .then((result) => { if (result?.dropped) log?.warn?.(`Scheduled check not run chat=${request.group} reason=${result.dropped}`); })
          .catch((error) => log?.warn?.(`Scheduled check failed chat=${request.group} reason=${error.message}`));
      }
    } catch (error) {
      log?.warn?.(`Nudge inbox poll failed reason=${error.message}`);
    }
    try {
      await sleep(pollMs, undefined, { signal });
    } catch {
      break;
    }
  }
}
