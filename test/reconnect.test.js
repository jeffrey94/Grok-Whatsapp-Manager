import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./fixtures/reconnect-child.mjs", import.meta.url));

test("item 4: process survives a 428 disconnect and reconnects (no silent exit code 13)", () => {
  const run = spawnSync(process.execPath, [child], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, `exit ${run.status} stdout=${run.stdout} stderr=${run.stderr}`);
  assert.match(run.stdout, /reconnected socket=2/);
  assert.match(run.stdout, /stopped state=stopped/);
});

test("item 4: a throw while reconnecting is logged and retried, not fatal", () => {
  const run = spawnSync(process.execPath, [child, "--throw-on-reconnect"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, `exit ${run.status} stdout=${run.stdout} stderr=${run.stderr}`);
  assert.match(run.stdout, /ERROR WhatsApp reconnect failed: Error: simulated socket construction failure/);
  assert.match(run.stdout, /reconnected socket=2/);
});
