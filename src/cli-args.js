/** Tiny argv parser: --key value, --flag, --key=value. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) args[key] = inline;
    else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) args[key] = argv[++index];
    else args[key] = true;
  }
  return args;
}
