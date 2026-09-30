// Small seeded PRNG (mulberry32) so runs, resumes and forks are reproducible.
export function mulberry32(seed: number): () => number {
  let a = Math.imul(seed >>> 0, 2654435761) >>> 0;
  const next = function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Warm up so adjacent seeds do not produce correlated first values.
  for (let i = 0; i < 4; i++) {
    next();
  }
  return next;
}

export function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}
