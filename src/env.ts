import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The repo's .env always wins over the shell's environment. (Node's
// --env-file never overrides a variable that's already set, so a key exported
// in a shell profile silently beat the one in .env.) Each override is logged
// with only the value's last four characters.
export function loadRepoEnv(path: string, env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = (m) => console.error(m)): string[] {
  if (!existsSync(path)) return [];
  const values = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined && env[key] !== value) {
      overridden.push(key);
      log(`[scriptorium] ${key} overridden by .env ...${value.slice(-4)}`);
    }
    env[key] = value;
  }
  return overridden;
}
