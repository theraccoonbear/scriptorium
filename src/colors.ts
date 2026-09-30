// ANSI color helpers. Respects NO_COLOR convention (https://no-color.org).
const noColor = !!process.env.NO_COLOR;

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[91m",
  green: "\x1b[38;2;0;220;0m",
  yellow: "\x1b[93m",
  blue: "\x1b[94m",
  magenta: "\x1b[95m",
  cyan: "\x1b[96m",
  white: "\x1b[97m",
  orange: "\x1b[38;2;255;165;0m",
  pink: "\x1b[38;2;255;105;180m",
  teal: "\x1b[38;2;0;200;200m",
  lime: "\x1b[38;2;180;255;0m",
  purple: "\x1b[38;2;180;100;255m"
};

// Distinct color per role
const ROLE_COLORS = {
  worldbuilder: CODES.purple,
  creator: CODES.pink,
  director: CODES.cyan,
  writer: CODES.yellow,
  continuist: CODES.teal,
  critic: CODES.orange,
  archivist: CODES.lime,
  beatgate: CODES.magenta,
  patchgate: CODES.pink,
  worldgate: CODES.blue
};

// Distinct color per model (matched by substring)
const MODEL_COLORS = [
  ["claude-haiku", CODES.orange],
  ["claude-sonnet", CODES.pink],
  ["claude-opus", CODES.magenta],
  ["deepseek", CODES.blue],
  ["space-bunny", CODES.lime],
  ["glm", CODES.cyan],
  ["kimi", CODES.yellow]
];

function wrap(code: string, text: string): string {
  if (noColor) return text;
  return `${code}${text}${CODES.reset}`;
}

function roleColor(role: string): string {
  return ROLE_COLORS[role as keyof typeof ROLE_COLORS] || CODES.white;
}

function modelColor(model: string): string {
  for (const [pattern, color] of MODEL_COLORS) {
    if (model.includes(pattern)) return color;
  }
  return CODES.dim;
}

function label(role: string, model: string): string {
  if (noColor) return `${role}/${model}`;
  return `${wrap(roleColor(role), role)}/${wrap(modelColor(model), model)}`;
}

export const c = {
  green: (t: unknown) => wrap(CODES.green, String(t)),
  red: (t: unknown) => wrap(CODES.red, String(t)),
  yellow: (t: unknown) => wrap(CODES.yellow, String(t)),
  cyan: (t: unknown) => wrap(CODES.cyan, String(t)),
  dim: (t: unknown) => wrap(CODES.dim, String(t)),
  bold: (t: unknown) => wrap(CODES.bold, String(t)),
  blue: (t: unknown) => wrap(CODES.blue, String(t)),
  magenta: (t: unknown) => wrap(CODES.magenta, String(t)),
  ok: (t: unknown) => wrap(CODES.green, `✓ ${t}`),
  fail: (t: unknown) => wrap(CODES.red, `✗ ${t}`),
  retry: (t: unknown) => wrap(CODES.yellow, `↻ ${t}`),
  got: (t: unknown) => wrap(CODES.dim, `→ ${t}`),
  role: (r: string) => wrap(roleColor(r), r),
  model: (m: string) => wrap(modelColor(m), m),
  label
};
