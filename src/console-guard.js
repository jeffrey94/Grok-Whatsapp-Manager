/**
 * Keeps key material out of bridge.log.
 *
 * libsignal (inside Baileys) prints Signal session objects straight to the
 * console, e.g. console.info("Closing session:", SessionEntry{ privKey, rootKey,
 * chainKey ... }). stdout/stderr go to bridge.log, so those dumps leaked private
 * keys. This guard wraps console.* once at startup:
 *   - calls whose arguments are all plain strings/numbers/booleans pass through
 *     unchanged (the bridge logger always calls console with one string);
 *   - any other call (objects, Buffers, arrays, Errors) never reaches the log
 *     as-is: known libsignal chatter becomes one short redacted line (or is
 *     dropped for info-level noise), everything else prints only its string
 *     parts plus "[redacted]" placeholders. Error arguments keep message + stack.
 */
import { Buffer } from "node:buffer";

const LIBSIGNAL_INFO = /^(Closing session|Opening session|Removing old closed session|Migrating session|Closing open session|Session already (?:open|closed)|Decrypted message with closed session)/i;
const KEY_WORDS = /\b(privKey|pubKey|rootKey|chainKey|baseKey|ephemeralKeyPair|remoteIdentityKey|messageKeys|SessionEntry|registrationId)\b|<Buffer /;

function isPlain(value) {
  return value === null || value === undefined || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function safeString(value) {
  if (typeof value !== "string") return String(value);
  // A string that itself carries a session dump (pre-formatted) is redacted too.
  return KEY_WORDS.test(value) ? "[redacted]" : value;
}

function describe(value) {
  if (isPlain(value)) return safeString(value);
  if (value instanceof Error) return safeString(`${value.name}: ${value.message}${value.stack ? `\n${value.stack.split("\n").slice(1).join("\n")}` : ""}`);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return "[redacted bytes]";
  return "[redacted object]";
}

/**
 * Returns the text to print, or undefined to drop the call entirely.
 * `level` is the console method name.
 */
export function sanitizeConsoleArgs(level, args, { verbose = false } = {}) {
  if (args.every((arg) => typeof arg !== "string" || !KEY_WORDS.test(arg)) && args.every(isPlain)) return undefined; // pass-through marker handled by caller
  const head = typeof args[0] === "string" ? args[0].replace(/[:\s]+$/, "") : "";
  if (LIBSIGNAL_INFO.test(head)) {
    if ((level === "log" || level === "info" || level === "debug") && !verbose) return null; // drop noise
    return `libsignal: ${head} (session details redacted)`;
  }
  return args.map(describe).join(" ");
}

let installed = false;

export function installConsoleGuard({ target = console, now = () => new Date(), verbose = false } = {}) {
  if (installed && target === console) return;
  if (target === console) installed = true;
  for (const level of ["log", "info", "warn", "error", "debug", "trace", "dir"]) {
    const original = target[level]?.bind(target);
    if (!original) continue;
    target[level] = (...args) => {
      let text;
      try {
        text = sanitizeConsoleArgs(level, args, { verbose });
      } catch {
        text = "[redacted console output]";
      }
      if (text === undefined) return original(...args);
      if (text === null) return undefined;
      const tag = level === "error" ? "ERROR" : level === "warn" || level === "trace" ? "WARN" : "INFO";
      return original(`${now().toISOString()} ${tag} wa-bridge: console ${text}`);
    };
  }
}
