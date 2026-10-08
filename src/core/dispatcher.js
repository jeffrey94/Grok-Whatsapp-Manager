/**
 * Per-chat FIFO queues plus photo-album / burst bundling. Adapted from the
 * Telegram bridge's update-dispatcher.js to a platform-neutral event shape:
 *
 *   event = { id, chatId, sender: { jid }, kind, text, ... }
 *
 * The handler (the bridge) supplies:
 *   queueKeyFor(event)          -> string (per-chat queue key)
 *   classifyForBundling(event)  -> { senderKey, role: "media"|"text"|"other", album? } | undefined
 *   handleEvent(eventOrBundle, options)
 *   handleError(eventOrBundle, error, options)
 *
 * A bundle is delivered to handleEvent as { ...firstEvent, bundled: [e1, e2, ...] }.
 */
export const DEFAULT_BUNDLING = Object.freeze({
  albumDebounceMs: 1_800,
  burstWindowMs: 3_000,
  maxWaitMs: 8_000,
  maxItems: 10,
});

function shutdownAbortError() {
  const error = new Error("Media bundle not processed: shutting down");
  error.name = "AbortError";
  return error;
}

export class Dispatcher {
  constructor(handler, options = {}) {
    this.handler = handler;
    this.log = options.log ?? console;
    this.chatQueues = new Map();
    this.bundles = new Map();
    this.bundlingEnabled = options.bundling !== false;
    this.bundling = {
      ...DEFAULT_BUNDLING,
      ...(options.bundling && typeof options.bundling === "object" ? options.bundling : {}),
    };
  }

  queueKeyFor(event) {
    return typeof this.handler.queueKeyFor === "function"
      ? this.handler.queueKeyFor(event)
      : String(event?.chatId ?? "unknown");
  }

  enqueue(key, run) {
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.chatQueues.set(key, task);
    void task.finally(() => {
      if (this.chatQueues.get(key) === task) this.chatQueues.delete(key);
    }).catch(() => {});
    return task;
  }

  async runEvent(event, options) {
    try {
      await this.handler.handleEvent(event, options);
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") throw error;
      this.log.error(`Bridge event failed: ${error.message}`);
      await this.handler.handleError?.(event, error, options);
    }
  }

  classify(event) {
    if (!this.bundlingEnabled || typeof this.handler.classifyForBundling !== "function") return undefined;
    try {
      return this.handler.classifyForBundling(event);
    } catch (error) {
      this.log.error(`Media bundle classification failed: ${error.message}`);
      return undefined;
    }
  }

  dispatch(event, options = {}) {
    const classification = this.classify(event);
    if (classification?.senderKey) {
      const open = this.bundles.get(classification.senderKey);
      if (classification.role === "media") {
        return open
          ? this.addToBundle(open, event, classification)
          : this.openBundle(event, classification, options);
      }
      if (open && classification.role === "text") {
        // The sender's description right after the photos becomes the bundle text.
        open.items.push(event);
        this.closeBundle(open, "text");
        return open.task;
      }
      if (open) this.closeBundle(open, "flush");
    }
    return this.enqueue(this.queueKeyFor(event), () => this.runEvent(event, options));
  }

  openBundle(event, classification, options) {
    let resolveClosed;
    const bundle = {
      senderKey: classification.senderKey,
      queueKey: this.queueKeyFor(event),
      items: [event],
      firstAt: Date.now(),
      lastAlbum: classification.album === true,
      closed: false,
      aborted: false,
      reason: undefined,
      timer: undefined,
      closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
    };
    bundle.resolveClosed = resolveClosed;
    this.bundles.set(bundle.senderKey, bundle);
    if (options.signal) {
      bundle.signal = options.signal;
      bundle.onAbort = () => this.closeBundle(bundle, "shutdown", { aborted: true });
      if (options.signal.aborted) bundle.onAbort();
      else options.signal.addEventListener("abort", bundle.onAbort, { once: true });
    }
    if (!bundle.closed) this.scheduleBundle(bundle);
    // Reserve the queue slot now so ordering with other events in the chat holds.
    bundle.task = this.enqueue(bundle.queueKey, async () => {
      await bundle.closedPromise;
      if (bundle.aborted || options.signal?.aborted) {
        this.log.error(`Media bundle not processed at shutdown items=${bundle.items.length}`);
        throw shutdownAbortError();
      }
      this.log.info(`Media bundle flush items=${bundle.items.length} reason=${bundle.reason} waitedMs=${Date.now() - bundle.firstAt}`);
      const merged = bundle.items.length === 1
        ? bundle.items[0]
        : { ...bundle.items[0], bundled: [...bundle.items] };
      return this.runEvent(merged, options);
    });
    return bundle.task;
  }

  addToBundle(bundle, event, classification) {
    bundle.items.push(event);
    bundle.lastAlbum = classification.album === true;
    if (bundle.items.length >= this.bundling.maxItems) this.closeBundle(bundle, "max-items");
    else if (Date.now() - bundle.firstAt >= this.bundling.maxWaitMs) this.closeBundle(bundle, "max-wait");
    else this.scheduleBundle(bundle);
    return bundle.task;
  }

  scheduleBundle(bundle) {
    clearTimeout(bundle.timer);
    const debounceMs = bundle.lastAlbum ? this.bundling.albumDebounceMs : this.bundling.burstWindowMs;
    const now = Date.now();
    const debounceAt = now + debounceMs;
    const capAt = bundle.firstAt + this.bundling.maxWaitMs;
    const reason = capAt <= debounceAt ? "max-wait" : "debounce";
    bundle.timer = setTimeout(() => this.closeBundle(bundle, reason), Math.max(0, Math.min(debounceAt, capAt) - now));
  }

  closeBundle(bundle, reason, { aborted = false } = {}) {
    if (bundle.closed) return;
    bundle.closed = true;
    bundle.reason = reason;
    bundle.aborted = aborted;
    clearTimeout(bundle.timer);
    bundle.timer = undefined;
    if (this.bundles.get(bundle.senderKey) === bundle) this.bundles.delete(bundle.senderKey);
    if (bundle.signal && bundle.onAbort) bundle.signal.removeEventListener("abort", bundle.onAbort);
    bundle.resolveClosed();
  }

  flushBundles(reason = "flush") {
    for (const bundle of [...this.bundles.values()]) this.closeBundle(bundle, reason);
  }

  pendingBundleCount() {
    return this.bundles.size;
  }

  async drain() {
    if (this.bundles.size) this.flushBundles("drain");
    await Promise.allSettled(this.chatQueues.values());
  }
}
