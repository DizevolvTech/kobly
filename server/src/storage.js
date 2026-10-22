// Arquivos de marca (logo): POST /storage/v1/object/branding/<org>/<arquivo> (autenticado, da própria conta)
// e GET /storage/v1/object/public/branding/<org>/<arquivo> (público, só imagens). Disco local em STORAGE_DIR.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AuthError } from './auth.js';

const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|gif)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
// O tipo vem do CONTEÚDO (assinatura do arquivo), não do que o navegador diz: SVG/HTML disfarçado de imagem é recusado.
export function sniffImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

export function createStorage({ dir, canAccessOrg }) {
  const root = resolve(dir);
  const safe = (org, name) => {
    if (!UUID.test(org) || !NAME.test(name)) return null;
    const p = resolve(join(root, org, name));
    return p.startsWith(root + sep) ? p : null;
  };
  async function upload(user, bucket, org, name, body) {
    if (bucket !== 'branding') throw new AuthError(404, 'bucket_not_found', 'Bucket não encontrado.');
    const p = safe(org, name);
    if (!p) throw new AuthError(400, 'bad_path', 'Nome de arquivo inválido. Use PNG, JPG, WEBP ou GIF.');
    if (!(await canAccessOrg(user, org))) throw new AuthError(403, 'forbidden', 'Sem acesso a esta conta.');
    if (!body.length) throw new AuthError(400, 'empty', 'Arquivo vazio.');
    if (body.length > MAX_BYTES) throw new AuthError(413, 'too_large', 'A imagem passa de 2 MB.');
    const kind = sniffImage(body);
    if (!kind) throw new AuthError(415, 'bad_type', 'Envie uma imagem PNG, JPG, WEBP ou GIF.');
    await mkdir(join(root, org), { recursive: true });
    await writeFile(p, body, { mode: 0o640 });
    return { path: `${org}/${name}` };
  }
  async function read(bucket, org, name) {
    if (bucket !== 'branding') return null;
    const p = safe(org, name);
    if (!p) return null;
    try { return { body: await readFile(p), type: MIME[name.split('.').pop().toLowerCase()] }; } catch { return null; }
  }
  return { upload, read, MAX_BYTES };
}
