// Janela deslizante em memória: freia tentativa em massa vinda de um mesmo IP.
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
