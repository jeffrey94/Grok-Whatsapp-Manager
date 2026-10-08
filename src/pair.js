import path from "node:path";
import { parseArgs } from "./cli-args.js";
import { readPrivateFile } from "./config.js";
import { createLogger } from "./logger.js";
import { pairDevice } from "./whatsapp/pairing.js";

/*
 * Usage (run by the operator when ready; the bridge must be stopped):
 *   node src/pair.js --config ./config.json --code +60123456789
 *   node src/pair.js --config ./config.json --qr [--png ./state/pair-qr.png]
 */
process.umask(0o077);
const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config ?? "config.json");
const raw = JSON.parse(readPrivateFile(configPath, "config file"));
const baseDir = path.dirname(configPath);
const authDir = path.resolve(baseDir, raw.authDir ?? "auth");
const stateDir = path.dirname(path.resolve(baseDir, raw.statePath ?? "state/bridge-state.json"));
const log = createLogger({ level: "info", name: "wa-pair" });

if (!args.code && !args.qr) {
  console.error("Choose one: --code <full phone number>  or  --qr [--png <path>]");
  process.exit(2);
}
if (args.code === true) {
  console.error("--code needs the bridge phone number, e.g. --code +60123456789");
  process.exit(2);
}

try {
  const result = await pairDevice({
    authDir,
    method: args.code ? "code" : "qr",
    phone: args.code,
    pngPath: args.qr ? path.resolve(typeof args.png === "string" ? args.png : path.join(stateDir, "pair-qr.png")) : undefined,
    codePath: args.code ? path.join(stateDir, "pairing-code.txt") : undefined,
    movePartial: args["move-partial"] === true,
    log,
  });
  console.log(`Done: paired=${result.paired}. Start the bridge with deploy/whatsapp-bridge-control.sh start`);
  process.exit(0);
} catch (error) {
  console.error(`Pairing did not complete: ${error.message}`);
  process.exit(1);
}
