// E-mails transacionais da Kobly (confirmar cadastro, recuperar senha, convite) com a identidade visual da marca.
// Envio pelo Resend (RESEND_API_KEY). Sem chave, NADA é enviado — o chamador recebe sent:false e decide o que fazer
// (no convite, o gestor recebe o link para copiar). Os links apontam para o SITE da Kobly, nunca para localhost.
const ORANGE = '#ff6201';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderEmail({ site, title, intro, ctaLabel, ctaUrl, footnote }) {
  const logo = `${site}/assets/kobly-logo-black.png`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
<tr><td style="padding:28px 32px 8px"><img src="${esc(logo)}" alt="KOBLY" height="30" style="display:block;height:30px;width:auto"></td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="margin:16px 0 8px;font-size:22px;line-height:1.3;color:#18181b">${esc(title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3f3f46">${intro}</p>
<p style="margin:0 0 28px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 26px;border-radius:8px">${esc(ctaLabel)}</a></p>
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#71717a">Se o botão não abrir, copie e cole este endereço no navegador:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all"><a href="${esc(ctaUrl)}" style="color:${ORANGE}">${esc(ctaUrl)}</a></p></td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #f4f4f5;font-size:12px;line-height:1.5;color:#a1a1aa">${esc(footnote)}<br>© Kobly — recuperação de vendas</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${title}\n\n${intro.replace(/<[^>]+>/g, '')}\n\n${ctaLabel}: ${ctaUrl}\n\n${footnote}`;
  return { html, text };
}

export function createMailer({ apiKey = '', from = 'Kobly <onboarding@resend.dev>', siteUrl = '', fetchImpl = globalThis.fetch, log = console } = {}) {
  const site = String(siteUrl || '').replace(/\/$/, '');
  const base = (origin) => String(origin || site).replace(/\/$/, '');
  const link = (origin, type, token) => `${base(origin)}/#type=${type}&token=${encodeURIComponent(token)}`;
  async function send({ to, subject, html, text }) {
    if (!apiKey) { log.warn(`[mailer] RESEND_API_KEY ausente: e-mail "${subject}" NÃO enviado para ${to}`); return { sent: false, reason: 'no_provider' }; }
    try {
      const res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ from, to: [to], subject, html, text }) });
      if (!res.ok) { log.error(`[mailer] Resend recusou (${res.status}) para ${to}`); return { sent: false, reason: `provider_${res.status}` }; }
      return { sent: true };
    } catch (e) { log.error('[mailer] falha de rede:', e.message); return { sent: false, reason: 'network' }; }
  }
  const compose = (to, subject, parts, origin) => { const s = base(origin); return send({ to, subject, ...renderEmail({ site: s, ...parts }) }); };
  return {
    confirmLink: (origin, token) => link(origin, 'confirm', token),
    inviteLink: (origin, token) => link(origin, 'recovery', token),
    sendConfirm: (to, token, origin) => compose(to, 'Confirme seu e-mail na Kobly', {
      title: 'Confirme seu e-mail', intro: 'Falta só um passo para ativar sua conta na <b>Kobly</b>. Confirme que este e-mail é seu para começar a recuperar vendas.',
      ctaLabel: 'Confirmar meu e-mail', ctaUrl: link(origin, 'confirm', token), footnote: 'O link vale por 24 horas. Se você não criou uma conta, ignore esta mensagem.' }, origin),
    sendRecovery: (to, token, origin) => compose(to, 'Redefinir sua senha da Kobly', {
      title: 'Redefinir senha', intro: 'Recebemos um pedido para criar uma nova senha para a sua conta na <b>Kobly</b>.',
      ctaLabel: 'Criar nova senha', ctaUrl: link(origin, 'recovery', token), footnote: 'O link vale por 1 hora. Se não foi você, ignore esta mensagem: sua senha continua a mesma.' }, origin),
    sendInvite: (to, token, origin, { nome = '', conta = '', convidadoPor = '' } = {}) => compose(to, 'Você foi convidado para a Kobly', {
      title: nome ? `${nome}, sua conta está pronta` : 'Sua conta está pronta',
      intro: `${convidadoPor ? `<b>${esc(convidadoPor)}</b> criou` : 'Foi criado'} o acesso${conta ? ` da conta <b>${esc(conta)}</b>` : ''} na <b>Kobly</b>. Defina sua senha para entrar.`,
      ctaLabel: 'Definir minha senha', ctaUrl: link(origin, 'recovery', token), footnote: 'O link vale por 7 dias e só pode ser usado uma vez.' }, origin),
  };
}
