import { describe, it, expect } from 'vitest';
import { ICONS } from '@/ds/iconRegistry.js';
import { collectIconNames } from '../../scripts/gen-icons.mjs';

const toPascal = (n) => n.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

describe('registro de ícones', () => {
  it('cobre todo ícone referenciado no código e nos seeds (rode npm run gen:icons se falhar)', () => {
    const faltando = collectIconNames().filter((n) => !ICONS[toPascal(n)]);
    expect(faltando).toEqual([]);
  });
  it('os ícones usados pela navegação existem', async () => {
    const { KoblyMockDB: DB } = await import('@/api/mockData.js');
    for (const item of Object.values(DB.NAV)) expect(ICONS[toPascal(item.icon)], item.icon).toBeTruthy();
  });
});
