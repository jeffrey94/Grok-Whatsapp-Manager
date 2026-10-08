import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Create (or tighten) a private directory: mode 700, not a symlink, and every
 * regular file inside mode 600. Refuses symlinks inside the directory.
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} must be a real directory (not a symlink)`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${dir} must be owned by the bridge user`);
  }
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const entry = lstatSync(file);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink inside private directory: ${file}`);
    if (entry.isFile()) chmodSync(file, 0o600);
    else if (entry.isDirectory()) ensurePrivateDir(file);
  }
  return dir;
}

/** Report modes that are too open (used by tests and `status`). */
export function auditPrivateDir(dir) {
  const problems = [];
  const walk = (current) => {
    const info = lstatSync(current);
    if (info.isDirectory()) {
      if ((info.mode & 0o077) !== 0) problems.push(`${current} mode ${(info.mode & 0o777).toString(8)}`);
      for (const name of readdirSync(current)) walk(path.join(current, name));
    } else if ((info.mode & 0o077) !== 0) {
      problems.push(`${current} mode ${(info.mode & 0o777).toString(8)}`);
    }
  };
  walk(dir);
  return problems;
}

/**
 * Is there a paired WhatsApp session in authDir? Reads creds.json without ever
 * returning or logging secret fields.
 */
export function readSessionInfo(authDir) {
  const credsPath = path.join(authDir, "creds.json");
  let descriptor;
  try {
    descriptor = openSync(credsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, registered: false };
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error("auth/creds.json must be a regular file");
    const creds = JSON.parse(readFileSync(descriptor, "utf8"));
    return {
      exists: true,
      registered: creds?.registered === true && typeof creds?.me?.id === "string",
      account: typeof creds?.me?.id === "string" ? creds.me.id.split(":")[0].split("@")[0].replace(/\d(?=\d{4})/g, "•") : undefined,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { exists: true, registered: false, corrupt: true };
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

/** Atomic JSON write at mode 600 inside a mode-700 directory. */
export async function writePrivateJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, filename);
}
