import { describe, it, expect } from 'vitest';
import { renderEmail } from '@/lib/emailTemplate.js';

describe('renderEmail', () => {
  it('gera HTML com o conteúdo dos blocos', () => {
    const html = renderEmail({ preheader: 'Pré', blocks: [
      { type: 'hero', title: 'Olá', text: 'Seu carrinho espera' },
      { type: 'button', label: 'Finalizar' },
    ] });
    expect(html).toContain('Seu carrinho espera');
    expect(html).toContain('Finalizar');
    expect(html).toContain('{{cta_link}}');
  });
  it('escapa HTML digitado pelo usuário (sem injeção)', () => {
    const html = renderEmail({ blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }] });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
  it('não quebra com entrada vazia', () => {
    expect(() => renderEmail()).not.toThrow();
    expect(() => renderEmail({ blocks: [{ type: 'inexistente' }] })).not.toThrow();
  });
});
