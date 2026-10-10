import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// API keys come from the repo's .env and nowhere else, so the author always
// knows which key is billed. A key exported in the shell (a profile, an old
// session) is dropped unless .env has it — and when .env has it, .env's wins.
// (Node's --env-file never overrides a variable that's already set, so before
// this a shell key silently beat .env, or billed when .env had none.)
// Everything else in .env is loaded too, and still wins over the shell.
// Keys are only ever shown by their last four characters.

export const isApiKeyName = (name: string) => /_API_KEY$/.test(name);
export const keyTail = (value: string) => `…${value.slice(-4)}`;

export interface RepoEnv {
  keys: { name: string; tail: string }[];  // the keys in use, all from .env
  ignored: string[];                       // keys set in the shell that .env doesn't have: dropped
  overridden: string[];                    // keys set in both, differently: .env's used
}

export function loadRepoEnv(path: string, env: NodeJS.ProcessEnv = process.env): RepoEnv {
  const values = existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : {};
  const ignored = Object.keys(env).filter((k) => isApiKeyName(k) && env[k] && !values[k]);
  for (const k of ignored) delete env[k];
  const overridden: string[] = [];
  for (const [k, value] of Object.entries(values)) {
    if (isApiKeyName(k) && env[k] !== undefined && env[k] !== value) overridden.push(k);
    env[k] = value;
  }
  const keys = Object.entries(values).filter(([k, v]) => isApiKeyName(k) && v).map(([name, v]) => ({ name, tail: keyTail(v) })).sort((a, b) => a.name.localeCompare(b.name));
  return { keys, ignored, overridden };
}

// One line for the start of a command: which keys it bills, and any shell keys set aside.
export function describeRepoEnv(r: RepoEnv): string[] {
  return [
    r.keys.length ? `keys (from .env): ${r.keys.map((k) => `${k.name} ${k.tail}`).join(", ")}` : "no API keys in .env — paid steps will stop (see the setup skill)",
    ...(r.ignored.length ? [`ignoring ${r.ignored.join(", ")} from your shell: Scriptorium only uses keys in .env`] : [])
  ];
}
