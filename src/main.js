import path from "node:path";
import { installConsoleGuard } from "./console-guard.js";
import { WhatsAppBridge } from "./bridge.js";
import { parseArgs } from "./cli-args.js";
import { loadConfig } from "./config.js";
import { LoopGuard } from "./core/loop-guard.js";
import { runNudgeInbox } from "./nudge-inbox.js";
import { ChatRouter } from "./core/routing.js";
import { GrokClient } from "./grok-client.js";
import { createLogger } from "./logger.js";
import { JsonStateStore } from "./state.js";
import { BaileysTransport, NeedsPairingError } from "./whatsapp/baileys-adapter.js";
import { ensurePrivateDir } from "./whatsapp/secure-fs.js";
import { StatusFile, TERMINAL_STATES } from "./whatsapp/status.js";

process.umask(0o077); // every file the bridge or Baileys writes is private (600 / 700)
installConsoleGuard(); // libsignal prints Signal session objects (private keys) to the console

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config ?? process.env.WA_BRIDGE_CONFIG ?? "config.json");
const log = createLogger({ level: config.logLevel });

// Nothing may kill the process silently: log every stray rejection/exception
// and keep running (the socket reconnect logic recovers). A burst of uncaught
// exceptions still exits(1) so the keep-alive routine restarts a wedged process.
const uncaughtTimes = [];
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection (kept running): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
process.on("uncaughtException", (error, origin) => {
  log.error(`Uncaught exception origin=${origin} (kept running): ${error?.stack ?? error?.message ?? String(error)}`);
  const now = Date.now();
  uncaughtTimes.push(now);
  while (uncaughtTimes.length && uncaughtTimes[0] < now - 60_000) uncaughtTimes.shift();
  if (uncaughtTimes.length >= 10) {
    log.error("Too many uncaught exceptions in 60s; exiting so the keep-alive can restart the bridge");
    process.exit(1);
  }
});
process.on("exit", (code) => {
  if (code !== 0) log.error(`Process exiting code=${code}`);
});
ensurePrivateDir(path.dirname(config.statePath));
ensurePrivateDir(path.dirname(config.statusPath));

const nudgeDir = path.join(path.dirname(config.statusPath), "nudges");
const status = new StatusFile(config.statusPath);
const previous = StatusFile.read(config.statusPath);
if (previous && TERMINAL_STATES.includes(previous.state) && !args["clear-alert"]) {
  log.error(`Refusing to start: last status is "${previous.state}" (${previous.detail ?? "needs attention"}). Fix it (usually re-pair), then start with --clear-alert.`);
  process.exit(3);
}

const state = new JsonStateStore(config.statePath);
await state.load();
const grok = new GrokClient(config.gatewayUrl, config.gatewayToken, {
  pollIntervalMs: config.pollIntervalMs,
  replyTimeoutMs: config.replyTimeoutMs,
});
const router = new ChatRouter(config);
const guard = new LoopGuard(config.limits);
const shutdown = new AbortController();

let bridge;
let recovered = false;
const transport = new BaileysTransport({
  authDir: config.authDir,
  groups: config.groups,
  groupsListPath: path.join(path.dirname(config.statusPath), "groups.json"),
  log,
  status,
  onEvent: (event) => bridge.ingest(event, { signal: shutdown.signal }),
  // Finish turns interrupted by a restart, once, after the first successful connect.
  onOpen: () => {
    if (recovered) return;
    recovered = true;
    void bridge.recoverPending({ signal: shutdown.signal })
      .catch((error) => log.error(`Pending-turn recovery failed: ${error.message}`));
    // Deliver agent messages that arrive after their prompt's turn (background tasks).
    void bridge.runLateDelivery({ signal: shutdown.signal })
      .catch((error) => log.error(`Late delivery stopped: ${error.message}`));
    // Proactive posts requested on the box with scripts/nudge.mjs (groups with allowNudge only).
    if (config.groups.some((group) => group.allowNudge)) {
      void runNudgeInbox(bridge, { dir: nudgeDir, signal: shutdown.signal, log })
        .catch((error) => log.error(`Nudge inbox stopped: ${error.message}`));
    }
  },
});
bridge = new WhatsAppBridge({
  grok,
  state,
  router,
  guard,
  transport,
  log,
  options: {
    silentTokens: config.silentTokens,
    maxMessageAgeSec: config.maxMessageAgeSec,
    sendDelayMs: config.sendDelayMs,
    typingIndicator: config.typingIndicator,
    quoteInDms: config.quoteInDms,
    replyTimeoutMs: config.replyTimeoutMs,
    stableReplyMs: config.stableReplyMs,
    ...(config.lateDeliveryWindowMs !== undefined ? { lateDeliveryWindowMs: config.lateDeliveryWindowMs } : {}),
    voiceHint: config.voiceHint,
    bundling: config.bundling,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log.info(`Received ${signal}; stopping`);
    shutdown.abort();
    void transport.stop();
  });
}

log.info(`grokbot-whatsapp-bridge starting dms=${config.dms.length} groups=${config.groups.length} defaultAgent=${JSON.stringify(config.defaultAgent)} replyTimeoutMs=${config.replyTimeoutMs}`);
log.info(`group routes ${JSON.stringify(Object.fromEntries(config.groups.map((group) => [group.jid, { agent: group.agent, mode: group.mode }])))}`);
log.info(`limits ${JSON.stringify(config.limits)} bundling=${JSON.stringify(config.bundling)}`);
log.info(`delivery streaming=on lateDeliveryWindowMs=${bridge.options.lateDeliveryWindowMs}`);

let result;
try {
  result = await transport.start();
} catch (error) {
  if (error instanceof NeedsPairingError) {
    log.error(`ALERT ${error.message}`);
    process.exit(3);
  }
  throw error;
}
shutdown.abort();
await bridge.drain();
log.info(`grokbot-whatsapp-bridge stopped state=${result?.state ?? "stopped"}`);
process.exit(result?.terminal ? 3 : 0);
