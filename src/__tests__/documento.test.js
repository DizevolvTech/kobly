import { describe, it, expect } from 'vitest';
import { isCpf, isCnpj, isDocumentoBr, normalizeDoc, tipoDocumento } from '@/lib/documento.js';

describe('documento fiscal', () => {
  it('valida CPF com e sem máscara', () => {
    expect(isCpf('529.982.247-25')).toBe(true);
    expect(isCpf('52998224725')).toBe(true);
  });
  it('rejeita CPF com DV errado ou dígitos repetidos', () => {
    expect(isCpf('529.982.247-26')).toBe(false);
    expect(isCpf('111.111.111-11')).toBe(false);
  });
  it('valida CNPJ numérico e alfanumérico (IN RFB 2.229/2024)', () => {
    expect(isCnpj('11.222.333/0001-81')).toBe(true);
    expect(isCnpj('12.ABC.345/01DE-35')).toBe(true);
  });
  it('rejeita CNPJ inválido', () => {
    expect(isCnpj('11.222.333/0001-82')).toBe(false);
    expect(isCnpj('00000000000000')).toBe(false);
    expect(isCnpj('123')).toBe(false);
  });
  it('isDocumentoBr escolhe CPF ou CNPJ pelo tamanho', () => {
    expect(isDocumentoBr('529.982.247-25')).toBe(true);
    expect(isDocumentoBr('11.222.333/0001-81')).toBe(true);
    expect(isDocumentoBr('')).toBe(false);
  });
  it('normalizeDoc mantém letras (não usa \\D)', () => {
    expect(normalizeDoc('12.abc.345/01de-35')).toBe('12ABC34501DE35');
  });
  it('tipoDocumento', () => {
    expect(tipoDocumento('52998224725')).toBe('CPF');
    expect(tipoDocumento('12ABC34501DE35')).toBe('CNPJ');
    expect(tipoDocumento('12')).toBe(null);
  });
});
