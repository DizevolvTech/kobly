// Gera src/ds/iconRegistry.js com SÓ os ícones Lucide referenciados no código.
// Motivo: `import * as Lucide` força o bundle de ~1.600 ícones; o registro estático
// mantém só os usados. Rode `npm run gen:icons` ao adicionar um ícone novo
// (o teste `iconRegistry` falha se ficar desatualizado).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lucide from 'lucide-react';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');
const OUT = join(SRC, 'ds', 'iconRegistry.js');

const toPascal = (n) => n.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(jsx?|tsx?)$/.test(f) && p !== OUT && !/\.test\./.test(f)) acc.push(p);
  }
  return acc;
}

export function collectIconNames() {
  const found = new Set();
  const re = /(['"`])([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\1/g;
  // Ícones também vêm do banco (templates.icone): varre as migrations/seeds.
  const MIG = join(root, 'supabase', 'migrations');
  const sqlFiles = readdirSync(MIG).filter((f) => f.endsWith('.sql')).map((f) => join(MIG, f));
  const sqlRe = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g;
  for (const file of sqlFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(sqlRe)) {
      const pascal = toPascal(m[1]);
      if (Lucide[pascal] && /^[A-Z]/.test(pascal)) found.add(m[1]);
    }
  }
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const name = m[2];
      const pascal = toPascal(name);
      if (Lucide[pascal] && typeof Lucide[pascal] !== 'string' && /^[A-Z]/.test(pascal)) found.add(name);
    }
  }
  return [...found].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = collectIconNames();
  const comps = [...new Set(names.map(toPascal))].sort();
  const body = `// ARQUIVO GERADO por scripts/gen-icons.mjs — não editar à mão (npm run gen:icons).\nimport {\n${comps.map((c) => `  ${c},`).join('\n')}\n} from 'lucide-react';\n\nexport const ICONS = {\n${comps.map((c) => `  ${c},`).join('\n')}\n};\n`;
  writeFileSync(OUT, body);
  console.log(`iconRegistry: ${comps.length} ícones`);
}
