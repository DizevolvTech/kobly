import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { File as NodeFile } from 'node:buffer';
import { importEmailFile } from '@/lib/emailImport.js';

// jsdom não implementa File#text(); o File do Node (igual ao do browser) sim.
const htmlFile = (txt, name = 'a.html') => new NodeFile([txt], name, { type: 'text/html' });

describe('importação de e-mail (fronteira de segurança)', () => {
  it('remove script, iframe, handlers on* e javascript:', async () => {
    const { html } = await importEmailFile(htmlFile(
      '<html><body><script>x()</script><iframe src="//e.com"></iframe><img src="a.png" onerror="x()"><a href="javascript:alert(1)">l</a><p>ok</p></body></html>',
    ));
    expect(html).not.toMatch(/<script|<iframe|onerror|javascript:/i);
    expect(html).toContain('ok');
  });
  it('ZIP: embute a imagem como data URI e sanitiza', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<html><body><img src="./images/logo.png"><script>x()</script></body></html>');
    zip.file('images/logo.png', 'PNGDATA');
    const blob = await zip.generateAsync({ type: 'uint8array' });
    const { html } = await importEmailFile(new File([blob], 'canva.zip', { type: 'application/zip' }));
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('<script');
  });
  it('ZIP sem HTML dá erro claro; formato errado também', async () => {
    const zip = new JSZip(); zip.file('a.txt', 'x');
    const blob = await zip.generateAsync({ type: 'uint8array' });
    await expect(importEmailFile(new File([blob], 'x.zip', { type: 'application/zip' }))).rejects.toThrow(/nenhum arquivo .html/);
    await expect(importEmailFile(new File(['x'], 'x.pdf', { type: 'application/pdf' }))).rejects.toThrow(/Formato não suportado/);
  });
  it('avisa quando o HTML passa de 100 KB (Gmail corta)', async () => {
    const { warnings } = await importEmailFile(htmlFile('<html><body>' + 'a'.repeat(110 * 1024) + '</body></html>'));
    expect(warnings.length).toBe(1);
  });
});
