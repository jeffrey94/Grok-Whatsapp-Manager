import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "baileys";
import { rename, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createBaileysLogger } from "../logger.js";
import { socketOptions } from "./baileys-adapter.js";
import { encodeQr, renderQrPng, renderQrTerminal } from "./qr.js";
import { ensurePrivateDir, readSessionInfo } from "./secure-fs.js";

export function normalizePairingPhone(value) {
  const digits = String(value ?? "").replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) throw new Error("Phone number must be the full international number, digits only (e.g. 60123456789)");
  return digits;
}

export function formatPairingCode(code) {
  const clean = String(code ?? "").replace(/[^0-9A-Z]/gi, "").toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

async function writePrivate(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await rm(filename, { force: true });
  await writeFile(filename, data, { mode: 0o600, flag: "wx" });
}

/**
 * Link this box to a WhatsApp account as a linked device. NOT run during the
 * build: the operator runs it once, on purpose, with the spare SIM's phone in hand.
 *
 *   method "code": prints an 8-character pairing code for
 *                  WhatsApp > Linked devices > Link a device > Link with phone number instead
 *   method "qr":   prints a QR in the terminal and saves it as a mode-600 PNG
 *                  (refreshed about every 20 s; gives up after maxQr codes)
 *
 * Refuses to touch an existing paired session. Never logs the account out.
 */
export async function pairDevice({
  authDir,
  method,
  phone,
  pngPath,
  codePath,
  log,
  out = (line) => process.stdout.write(`${line}\n`),
  makeSocket = makeWASocket,
  authStateFactory = useMultiFileAuthState,
  timeoutMs = 300_000,
  maxQr = 6,
  movePartial = false,
}) {
  if (method !== "code" && method !== "qr") throw new Error('method must be "code" or "qr"');
  const digits = method === "code" ? normalizePairingPhone(phone) : undefined;
  ensurePrivateDir(authDir);
  const session = readSessionInfo(authDir);
  if (session.registered) {
    throw new Error("auth/ already holds a paired session. Stop the bridge and move auth/ aside first if you really want to re-pair.");
  }
  if (session.exists) {
    if (!movePartial) throw new Error("auth/ holds a half-finished pairing. Re-run with --move-partial to move it aside (nothing is deleted).");
    const aside = `${authDir.replace(/\/$/, "")}-partial-${Date.now()}`;
    await rename(authDir, aside);
    log.warn(`Moved unfinished auth to ${aside}`);
    ensurePrivateDir(authDir);
  }

  const { state, saveCreds } = await authStateFactory(authDir);
  const logger = createBaileysLogger(log, "warn");
  let qrCount = 0;
  let codeRequested = false;
  let restarts = 0;
  let sock;

  const cleanupArtifacts = async () => {
    if (pngPath) await rm(pngPath, { force: true }).catch(() => {});
    if (codePath) await rm(codePath, { force: true }).catch(() => {});
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end?.(undefined);
      } catch {}
      await cleanupArtifacts();
      ensurePrivateDir(authDir);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => void finish(new Error("Pairing timed out. Nothing was linked; run pair again when ready.")), timeoutMs);
    timer.unref?.();

    const connect = () => {
      sock = makeSocket(socketOptions({ auth: state, logger, getMessage: async () => undefined, cachedGroupMetadata: async () => undefined }));
      const current = sock;
      current.ev.on("creds.update", () => void saveCreds().catch((error) => log.error(`Saving creds failed: ${error.message}`)));
      current.ev.on("messaging-history.set", (data) => {
        const chats = data?.chats ?? [];
        const withToken = chats.filter((chat) => chat?.tcToken?.length).length;
        out(`History sync received type=${data?.syncType ?? "?"} chats=${chats.length} withPrivacyToken=${withToken}`);
      });
      current.ev.on("connection.update", (update) => void (async () => {
        if (current !== sock || settled) return;
        const { connection, lastDisconnect, qr } = update ?? {};
        if (qr && method === "qr") {
          qrCount += 1;
          if (qrCount > maxQr) {
            await finish(new Error("No scan after several QR codes. Nothing was linked; run pair again when ready."));
            return;
          }
          const matrix = encodeQr(qr, { ecc: "M" });
          out(renderQrTerminal(matrix));
          if (pngPath) {
            await writePrivate(pngPath, renderQrPng(matrix));
            out(`QR ${qrCount}/${maxQr} saved to ${pngPath} (mode 600). Scan it in WhatsApp > Linked devices > Link a device.`);
          } else {
            out(`QR ${qrCount}/${maxQr}: scan it in WhatsApp > Linked devices > Link a device.`);
          }
        } else if (qr && method === "code" && !codeRequested) {
          codeRequested = true;
          const code = formatPairingCode(await current.requestPairingCode(digits));
          if (codePath) await writePrivate(codePath, `${code}\n`);
          out(`Pairing code: ${code}`);
          out("On the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter the code.");
        }
        if (connection === "open") {
          const info = readSessionInfo(authDir);
          out(`Linked. WhatsApp account ${info.account ?? "(unknown)"} is paired with this box.`);
          // Stay connected long enough for the phone's bootstrap history sync, which carries the
          // per-contact privacy tokens (tctoken) needed to send 1:1 replies (else error 463).
          out("Waiting ~60s for the phone's initial sync (privacy tokens)...");
          await new Promise((r) => setTimeout(r, 60_000));
          await finish(undefined, { paired: true, account: info.account });
        } else if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.restartRequired && restarts < 3) {
            restarts += 1; // expected once right after a successful scan/code
            connect();
            return;
          }
          if (readSessionInfo(authDir).registered) {
            out("Linked (socket closed after pairing).");
            await finish(undefined, { paired: true });
            return;
          }
          await finish(new Error(`Pairing failed (WhatsApp closed the connection, code ${code ?? "none"}). Nothing was linked.`));
        }
      })().catch((error) => void finish(error)));
    };
    connect();
  });
}
