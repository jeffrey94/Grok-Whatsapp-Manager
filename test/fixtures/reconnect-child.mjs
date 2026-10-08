// Child process for the reconnect regression test. Mirrors main.js: the only
// thing keeping the process alive is the transport (top-level await on start()).
// Before the fix, the reconnect timer and heartbeat were unref'd, so after a
// close the event loop emptied and Node exited silently with code 13.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaileysTransport } from "../../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, quietLog, writePairedCreds } from "../helpers/fake-baileys.js";

const dir = mkdtempSync(path.join(tmpdir(), "wa-reconnect-"));
const authDir = path.join(dir, "auth");
writePairedCreds(authDir);
const makeSocket = fakeSocketFactory();
let throwOnce = process.argv.includes("--throw-on-reconnect");
const factory = (options) => {
  if (makeSocket.sockets.length === 1 && throwOnce) {
    throwOnce = false;
    throw new Error("simulated socket construction failure");
  }
  const sock = makeSocket(options);
  if (makeSocket.sockets.length === 1) {
    setImmediate(() => { sock.open(); setImmediate(() => sock.close(428)); });
  } else {
    console.log(`reconnected socket=${makeSocket.sockets.length}`);
    setImmediate(() => void transport.stop());
  }
  return sock;
};
const transport = new BaileysTransport({
  authDir,
  log: { ...quietLog, error: (m) => console.log(`ERROR ${m.split("\n")[0]}`) },
  status: new StatusFile(path.join(dir, "status.json")),
  onEvent: () => {},
  makeSocket: factory,
  authStateFactory: fakeAuthStateFactory(),
  backoff: { baseMs: 150, maxMs: 300 },
  heartbeatMs: 60_000,
});
const result = await transport.start();
console.log(`stopped state=${result.state}`);
