import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../src/core/dispatcher.js";

const quiet = { info() {}, error() {}, warn() {} };

function handler() {
  const handled = [];
  return {
    handled,
    queueKeyFor: (event) => `q:${event.chatId}`,
    classifyForBundling(event) {
      const senderKey = `${event.chatId}|${event.sender}`;
      if (event.kind === "image") return { senderKey, role: "media", album: event.album === true };
      if (event.kind === "text" && !event.text.startsWith("/")) return { senderKey, role: "text" };
      return { senderKey, role: "other" };
    },
    async handleEvent(event) {
      handled.push(event.bundled ? event.bundled.map((item) => item.id) : [event.id]);
    },
  };
}

const bundling = { albumDebounceMs: 40, burstWindowMs: 60, maxWaitMs: 400, maxItems: 4 };

test("photo burst from one sender becomes one turn, closed by the follow-up text", async () => {
  const h = handler();
  const d = new Dispatcher(h, { bundling, log: quiet });
  const tasks = [
    d.dispatch({ id: "p1", chatId: "c", sender: "a", kind: "image" }),
    d.dispatch({ id: "p2", chatId: "c", sender: "a", kind: "image" }),
    d.dispatch({ id: "p3", chatId: "c", sender: "a", kind: "image" }),
    d.dispatch({ id: "t1", chatId: "c", sender: "a", kind: "text", text: "quote these" }),
  ];
  await Promise.all(tasks);
  assert.deepEqual(h.handled, [["p1", "p2", "p3", "t1"]]);
});

test("burst closes after the window; different senders never merge", async () => {
  const h = handler();
  const d = new Dispatcher(h, { bundling, log: quiet });
  const a = d.dispatch({ id: "a1", chatId: "c", sender: "a", kind: "image" });
  const b = d.dispatch({ id: "b1", chatId: "c", sender: "b", kind: "image" });
  const a2 = d.dispatch({ id: "a2", chatId: "c", sender: "a", kind: "image" });
  await Promise.all([a, b, a2]);
  assert.deepEqual(h.handled, [["a1", "a2"], ["b1"]]);
});

test("max items splits large bursts", async () => {
  const h = handler();
  const d = new Dispatcher(h, { bundling, log: quiet });
  const tasks = [];
  for (let i = 1; i <= 6; i += 1) tasks.push(d.dispatch({ id: `p${i}`, chatId: "c", sender: "a", kind: "image" }));
  await Promise.all(tasks);
  assert.deepEqual(h.handled, [["p1", "p2", "p3", "p4"], ["p5", "p6"]]);
});

test("voice note flushes the open bundle first and keeps order", async () => {
  const h = handler();
  const d = new Dispatcher(h, { bundling, log: quiet });
  const tasks = [
    d.dispatch({ id: "p1", chatId: "c", sender: "a", kind: "image" }),
    d.dispatch({ id: "v1", chatId: "c", sender: "a", kind: "voice" }),
  ];
  await Promise.all(tasks);
  assert.deepEqual(h.handled, [["p1"], ["v1"]]);
});

test("single queue per key is FIFO; errors go to handleError and do not wedge the queue", async () => {
  const order = [];
  const errors = [];
  const d = new Dispatcher({
    queueKeyFor: () => "same",
    async handleEvent(event) {
      await new Promise((r) => setTimeout(r, event.delay));
      if (event.fail) throw new Error("boom");
      order.push(event.id);
    },
    async handleError(event, error) { errors.push([event.id, error.message]); },
  }, { bundling: false, log: quiet });
  await Promise.all([
    d.dispatch({ id: 1, delay: 30 }),
    d.dispatch({ id: 2, delay: 1, fail: true }),
    d.dispatch({ id: 3, delay: 1 }),
  ]);
  assert.deepEqual(order, [1, 3]);
  assert.deepEqual(errors, [[2, "boom"]]);
});
