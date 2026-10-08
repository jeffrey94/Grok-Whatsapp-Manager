/**
 * Convert the agent's Markdown-ish reply into WhatsApp formatting:
 *   **bold** / __bold__ / *bold* -> *bold*   _italic_ -> _italic_
 *   (a single-star *x* is left as WhatsApp bold, since agents here write WhatsApp style)
 *   ~~strike~~ -> ~strike~             # Heading -> *Heading*
 *   [label](url) -> label (url)        `code` and ``` blocks are kept
 *   Markdown tables -> plain lines (WhatsApp cannot render tables)
 *   "* item" bullets -> "- item" (so they are not read as italics)
 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function convertTables(text) {
  const lines = text.split("\n");
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (/^\s*\|.*\|\s*$/.test(line) && next !== undefined && TABLE_SEPARATOR_RE.test(next)) {
      const header = tableCells(line);
      index += 1;
      const rows = [];
      while (index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index + 1])) {
        index += 1;
        rows.push(tableCells(lines[index]));
      }
      if (!rows.length) {
        out.push(`**${header.join(" · ")}**`);
        continue;
      }
      for (const row of rows) {
        const pairs = row.map((cell, cellIndex) => {
          const label = header[cellIndex];
          return label && cellIndex > 0 ? `${label}: ${cell}` : cell;
        }).filter((value) => value && value.trim());
        out.push(`- ${pairs.join(", ")}`);
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function toWhatsAppText(markdown) {
  if (typeof markdown !== "string") return "";
  const protectedBlocks = [];
  const protect = (value) => {
    protectedBlocks.push(value);
    return `\u0000${protectedBlocks.length - 1}\u0000`;
  };
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code) => protect(`\`\`\`${code.replace(/\n$/, "")}\`\`\``));
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => protect(`\`${code}\``));
  text = convertTables(text);
  text = text.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => protect(label === url ? url : `${label} (${url})`));
  text = text
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_match, heading) => `\u0001${heading.replace(/\*\*|__/g, "")}\u0001`)
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "\u0001_$1_\u0001")
    .replace(/\*\*([^*\n]+)\*\*/g, "\u0001$1\u0001")
    .replace(/__([^_\n]+)__/g, "\u0001$1\u0001")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/\u0001/g, "*")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => protectedBlocks[Number(index)]).trim();
}

/** Split long text into WhatsApp-friendly chunks, preferring paragraph and line breaks. */
export function splitText(text, limit = 3_500) {
  if (typeof text !== "string" || !text) return [];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const LIST_ITEM_RE = /^\s*(?:[-\u2022]|\d+[.)])\s+/;

function isLeadLine(block) {
  if (block.includes("\n") || block.length > 140) return false;
  return /:\s*$/.test(block) || /^\*[^*\n]+\*\s*\S{0,40}$/.test(block);
}

/**
 * Split one long reply into a few WhatsApp bubbles at natural breaks.
 * - short replies (< minChars) and anything with a code block stay whole
 * - breaks at blank lines; if there are none, at line starts, keeping list
 *   items with the line that introduces them
 * - a bold or "…:" lead line stays with the block after it
 * - small neighbours are packed together up to targetChars; a new bold
 *   section starts its own bubble
 * - never more than maxParts bubbles (the closest neighbours are merged)
 */
export function smartSplit(text, { maxParts = 3, minChars = 320, targetChars = 280 } = {}) {
  if (typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxParts <= 1 || trimmed.length < minChars || trimmed.includes("```")) return [trimmed];

  let blocks = trimmed.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean);
  let joiner = "\n\n";
  if (blocks.length === 1) {
    joiner = "\n";
    const groups = [];
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      const previous = groups.at(-1);
      if (previous && (LIST_ITEM_RE.test(line) || /:\s*$/.test(previous.at(-1)))) previous.push(line);
      else groups.push([line]);
    }
    blocks = groups.map((group) => group.join("\n"));
  }

  const units = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (index + 1 < blocks.length && isLeadLine(blocks[index])) {
      blocks[index + 1] = `${blocks[index]}\n${blocks[index + 1]}`;
      continue;
    }
    units.push(blocks[index]);
  }

  const parts = [];
  for (const unit of units) {
    const last = parts.at(-1);
    // A new bold section ("*Year 1*") starts its own bubble unless the current one is tiny.
    const newSection = /^\*[^*\n]+\*/.test(unit) && last !== undefined && last.length >= 120;
    if (last !== undefined && !newSection && last.length + joiner.length + unit.length <= targetChars) parts[parts.length - 1] = `${last}${joiner}${unit}`;
    else parts.push(unit);
  }
  while (parts.length > maxParts) {
    let best = 0;
    for (let index = 1; index < parts.length - 1; index += 1) {
      if (parts[index].length + parts[index + 1].length < parts[best].length + parts[best + 1].length) best = index;
    }
    parts.splice(best, 2, `${parts[best]}${joiner}${parts[best + 1]}`);
  }
  return parts.flatMap((part) => splitText(part));
}
