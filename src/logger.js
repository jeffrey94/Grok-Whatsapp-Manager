/**
 * Minimal logger. Info-level lines carry ids, counts and reasons only: never
 * message bodies, captions, file contents, tokens or auth material.
 */
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 };

export function createLogger({ level = "info", sink = console, name = "wa-bridge" } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, message) => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${name}: ${message}`;
    (lvl === "error" || lvl === "fatal" || lvl === "warn" ? sink.error : sink.log).call(sink, line);
  };
  return {
    get level() { return Object.keys(LEVELS).find((key) => LEVELS[key] === threshold); },
    set level(value) { threshold = LEVELS[value] ?? threshold; },
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    log: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

/**
 * pino-shaped logger for Baileys. Baileys passes (object, message) pairs whose
 * objects can contain decrypted message content, keys or credentials, so only
 * the message string and an error's .message are ever printed.
 */
export function createBaileysLogger(base, level = "warn") {
  const make = (bindings = {}) => {
    let threshold = LEVELS[level] ?? LEVELS.warn;
    const emit = (lvl) => (objOrMsg, maybeMsg) => {
      if ((LEVELS[lvl] ?? 0) < threshold) return;
      const message = typeof objOrMsg === "string" ? objOrMsg : typeof maybeMsg === "string" ? maybeMsg : "";
      const error = objOrMsg instanceof Error ? objOrMsg : objOrMsg?.err ?? objOrMsg?.error;
      const errorText = error?.message ? ` (${String(error.message).slice(0, 200)})` : "";
      const scope = bindings.class ? `[${bindings.class}] ` : "";
      const line = `baileys ${scope}${message || "event"}${errorText}`;
      if (lvl === "error" || lvl === "fatal") base.error(line);
      else if (lvl === "warn") base.warn(line);
      else base.debug(line);
    };
    return {
      get level() { return Object.keys(LEVELS).find((key) => LEVELS[key] === threshold); },
      set level(value) { threshold = LEVELS[value] ?? threshold; },
      child: (childBindings = {}) => make({ ...bindings, ...childBindings }),
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
    };
  };
  return make();
}
