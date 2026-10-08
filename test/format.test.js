import test from "node:test";
import assert from "node:assert/strict";
import { splitText, toWhatsAppText } from "../src/whatsapp/format.js";

test("markdown becomes WhatsApp formatting", () => {
  assert.equal(toWhatsAppText("**Total**: RM 10"), "*Total*: RM 10");
  assert.equal(toWhatsAppText("__bold__ and *wa bold* and _it_"), "*bold* and *wa bold* and _it_");
  assert.equal(toWhatsAppText("~~old~~ price"), "~old~ price");
  assert.equal(toWhatsAppText("# Quote QT-1\n\nBody"), "*Quote QT-1*\n\nBody");
  assert.equal(toWhatsAppText("[site](https://example.com)"), "site (https://example.com)");
  assert.equal(toWhatsAppText("* one\n* two"), "- one\n- two");
});

test("no markdown tables reach WhatsApp", () => {
  const out = toWhatsAppText("| Item | Qty | Price |\n|---|:-:|--:|\n| Sign | 2 | 10 |\n| Banner | 1 | 5 |");
  assert.equal(out, "- Sign, Qty: 2, Price: 10\n- Banner, Qty: 1, Price: 5");
  assert.doesNotMatch(out, /\|/);
});

test("code is preserved untouched", () => {
  assert.equal(toWhatsAppText("run `a **b**` now"), "run `a **b**` now");
  assert.equal(toWhatsAppText("```\nx = **y**\n```"), "```x = **y**```");
});

test("splitText prefers paragraph breaks and never loses text", () => {
  const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
  const parts = splitText(text, 3500);
  assert.equal(parts.length, 2);
  assert.equal(parts.join("\n\n"), text);
  assert.deepEqual(splitText("", 10), []);
});

import { smartSplit } from "../src/whatsapp/format.js";

test("smartSplit leaves short replies and code blocks whole", () => {
  assert.deepEqual(smartSplit("*RM550k* asking, list.my 2025"), ["*RM550k* asking, list.my 2025"]);
  const code = `${"x".repeat(400)}\n\`\`\`a\n\nb\`\`\``;
  assert.equal(smartSplit(code).length, 1);
});

test("smartSplit breaks at bold sections and keeps a lead with its bullets", () => {
  const text = "*Leveraged at RM600k, 90% loan*\n\nAssumptions:\n- 4.0% over 35 yrs, about RM2,390 a month\n- Cash in about RM118k incl. RM30k reno and legal\n- Rent RM3.2k to 3.6k, 11 months let\n- Maintenance about RM4.3k a year\n\n*Year 1*\n- Cash flow about RM2.3k to 6.7k\n- Plus principal paydown about RM7.2k\n\n_Excl. quit rent and assessment_\nWant RM650k too?";
  const parts = smartSplit(text);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^\*Leveraged[\s\S]*Assumptions:\n- 4\.0%/);
  assert.match(parts[1], /^\*Year 1\*[\s\S]*Want RM650k too\?$/);
});

test("smartSplit caps bubbles and splits line-only text at line starts", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Line ${i} ${"word ".repeat(20)}`.trim());
  const parts = smartSplit(lines.join("\n"), { maxParts: 3 });
  assert.equal(parts.length, 3);
  assert.equal(parts.join("\n"), lines.join("\n"));
});
