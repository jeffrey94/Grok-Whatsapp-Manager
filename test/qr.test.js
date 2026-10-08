import test from "node:test";
import assert from "node:assert/strict";
import { encodeQr, renderQrPng, renderQrTerminal } from "../src/whatsapp/qr.js";

test("QR sizes/versions follow the spec for typical Baileys payload lengths", () => {
  assert.equal(encodeQr("HELLO", { ecc: "M" }).version, 1);
  assert.equal(encodeQr("HELLO", { ecc: "M" }).size, 21);
  const payload = `2@${"A".repeat(90)},${"B".repeat(44)},${"C".repeat(44)},${"D".repeat(44)}`; // ~230 chars
  const qr = encodeQr(payload, { ecc: "M" });
  assert.equal(qr.version, 11);
  assert.equal(qr.size, 61);
  // finder pattern corners are dark, separators light
  assert.equal(qr.modules[0][0], true);
  assert.equal(qr.modules[7][7], false);
  assert.equal(qr.modules[0][qr.size - 1], true);
  assert.equal(qr.modules[qr.size - 1][0], true);
});

test("PNG output is a valid grayscale PNG with a quiet zone", () => {
  const png = renderQrPng(encodeQr("pairing-test"), { scale: 4, quiet: 4 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), (21 + 8) * 4);
});

test("terminal rendering uses half blocks, two rows per line", () => {
  const qr = encodeQr("x");
  const lines = renderQrTerminal(qr, { quiet: 2 }).split("\n");
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2));
  assert.match(lines[1], /[█▀▄]/);
});
