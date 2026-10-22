# Cadastro, acesso, perfis e plano — como funciona

## Dois caminhos para ter uma conta
1. **Cadastro próprio** (o cliente cria sozinho): tela *Criar conta* (e-mail + senha ≥ 8) → recebe o e-mail "Confirme seu e-mail" (marca Kobly) → clica no botão → volta ao site já confirmado → entra → tela *Sua empresa* (nome + segmento) → a conta nasce no plano **Starter** e ele vira **Cliente** dessa conta.
2. **Agência/gestor cadastra o cliente**: *Clientes → Cadastrar nova conta* (nome, segmento, CPF/CNPJ opcional, **e-mail do cliente**, plano). O cliente recebe o e-mail "Você foi convidado" com o botão *Definir minha senha* (vale 7 dias, uso único) e já entra na conta com perfil **Cliente**. Sem chave de e-mail configurada, o gestor vê o link na tela para repassar.

## Perfis
- **Cliente**: dono/usuário da própria conta (campanhas, leads, integrações, plano).
- **Gestor**: agência; vê e opera as contas que gerencia; cria contas e convida clientes.
- **Suporte**: atende chamados e vê leads; não altera integrações.
- **Administrador**: tudo, incluindo planos e usuários.
O perfil nunca vem do formulário: quem se cadastra sozinho é sempre Cliente; Gestor/Suporte/Administrador só o Administrador define.

## Plano
- Todo cadastro começa no **Starter** (até 5 campanhas). O gestor/admin pode escolher outro plano ao cadastrar a conta; o cliente muda em *Planos & cobrança*. Cobrança automática (Asaas) é a última etapa do projeto.

## Variáveis do servidor (e-mail)
- `SITE_URL`: endereço público do aplicativo; **todos os links dos e-mails apontam para ele** (nunca localhost). Sem ele, usa a 1ª origem de `ALLOWED_ORIGINS`.
- `ALLOWED_ORIGINS`: origens aceitas para `redirect_to`; qualquer outra é ignorada.
- `RESEND_API_KEY`, `MAIL_FROM`: envio pelo Resend. Sem chave nada é enviado (o convite devolve o link ao gestor).
- `REQUIRE_EMAIL_CONFIRM=true` liga a confirmação de e-mail no cadastro próprio.

## Domínio de envio dos e-mails de campanha
Duas opções por conta: (a) subdomínio da própria Kobly, sem configuração do cliente; (b) domínio próprio do cliente, verificado por DNS (aba *Remetente*). Se o cliente tiver domínio verificado, ele tem prioridade.
