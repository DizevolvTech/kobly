-- Dados de demonstração (ambiente de teste). Idempotente: apaga o que tem marca 'seed-demo' e recria.
-- Uso: psql -v org=<uuid> -v tamanho=<n leads> -f seed_demo.sql
\set ON_ERROR_STOP on
begin;
select setseed(0.42);
select set_config('seed.org', :'org', false), set_config('seed.n', :'tamanho', false);

-- limpeza do seed anterior desta empresa
delete from public.email_events   where organization_id = :'org' and sg_event_id like 'seed-%';
delete from public.webhook_events where organization_id = :'org' and id_webhook like 'seed:%';
delete from public.leads          where organization_id = :'org' and legacy_id = 'seed-demo';
delete from public.campaigns      where organization_id = :'org' and legacy_id = 'seed-demo';
delete from public.emails         where organization_id = :'org' and legacy_id = 'seed-demo';
delete from public.tags           where organization_id = :'org' and legacy_id = 'seed-demo';

-- marca
insert into public.brands (organization_id, nome, cor, modo, link_loja, link_area_membros, ordem)
select :'org', 'Curso Fitness Pro', '#ff6200', 'dark', 'https://exemplo.test/checkout/fitness-pro', 'https://membros.exemplo.test/entrar', 5
where not exists (select 1 from public.brands where organization_id = :'org' and nome = 'Curso Fitness Pro');

-- tags
insert into public.tags (organization_id, nome, descricao, legacy_id) values
 (:'org', 'Comprou', 'Lead que concluiu a compra', 'seed-demo'),
 (:'org', 'Carrinho abandonado', 'Saiu sem finalizar', 'seed-demo'),
 (:'org', 'Pix pendente', 'Gerou Pix e não pagou', 'seed-demo');

-- e-mails (modelos)
insert into public.emails (organization_id, titulo, assunto, remetente, corpo_html, legacy_id) values
 (:'org', 'Carrinho — lembrete 1', 'Você esqueceu algo no carrinho', 'Curso Fitness Pro', '<div style="font-family:Arial;max-width:520px;margin:auto"><h2>Seu carrinho está esperando</h2><p>Oi {{nome}}, seu acesso ao <b>{{produto}}</b> ainda está reservado.</p><p><a href="{{cta_link}}" style="background:#ff6200;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Concluir compra</a></p></div>', 'seed-demo'),
 (:'org', 'Pix — última chamada', 'Seu Pix vence hoje', 'Curso Fitness Pro', '<div style="font-family:Arial;max-width:520px;margin:auto"><h2>Falta pouco!</h2><p>{{nome}}, pague o Pix de {{valor}} para garantir seu acesso.</p><p><a href="{{cta_link}}">Pagar agora</a></p></div>', 'seed-demo'),
 (:'org', 'Boas-vindas', 'Seu acesso foi liberado', 'Curso Fitness Pro', '<div style="font-family:Arial;max-width:520px;margin:auto"><h2>Bem-vindo(a)!</h2><p>{{nome}}, seu acesso ao {{produto}} já está liberado.</p><p><a href="{{cta_link}}">Acessar área de membros</a></p></div>', 'seed-demo');

-- campanhas + fluxos + passos
do $$
declare
  org uuid := current_setting('seed.org')::uuid;
  nomes text[] := array['Recuperação de carrinho','Pix não pago','Boleto — lembrete','Pós-compra: boas-vindas','Reembolso — retenção'];
  status text[] := array['Ativa','Ativa','Pausada','Ativa','Rascunho'];
  evento text[] := array['Abandono de carrinho','Pix Gerado','Boleto Gerado','Compra Aprovada','Compra Reembolsada'];
  emailt text[] := array['Carrinho — lembrete 1','Pix — última chamada','Carrinho — lembrete 1','Boas-vindas','Boas-vindas'];
  i int; cid uuid; fid uuid; eid uuid; tg uuid; sid uuid;
begin
  for i in 1..5 loop
    insert into public.campaigns (organization_id, nome, status_campanha, legacy_id, created_at)
      values (org, nomes[i], status[i]::public.status_campanha, 'seed-demo', now() - ((6-i)*3 || ' days')::interval) returning id into cid;
    insert into public.campaign_flows (campaign_id, organization_id) values (cid, org) returning id into fid;
    select id into eid from public.emails where organization_id = org and titulo = emailt[i] and legacy_id = 'seed-demo';
    insert into public.flow_steps (flow_id, organization_id, tipo_card, nome, posicao, atraso, tipo_evento) values (fid, org, 'Gatilho', 'Gatilho', 0, 0, evento[i]::public.tipo_evento);
    insert into public.flow_steps (flow_id, organization_id, tipo_card, nome, posicao, atraso, email_id) values (fid, org, 'Envio de e-mail', 'E-mail 1', 1, 30, eid);
    insert into public.flow_steps (flow_id, organization_id, tipo_card, nome, posicao, atraso, email_id) values (fid, org, 'Envio de e-mail', 'E-mail 2', 2, 1440, eid);
    select id into tg from public.tags where organization_id = org and nome = case when i = 4 then 'Comprou' else 'Carrinho abandonado' end and legacy_id = 'seed-demo';
    insert into public.flow_steps (flow_id, organization_id, tipo_card, nome, posicao, atraso) values (fid, org, 'Adicionar Tag', 'Marcar lead', 3, 0) returning id into sid;
    insert into public.step_add_tags (step_id, tag_id) values (sid, tg);
  end loop;
end $$;

-- leads + eventos de checkout + envios de e-mail (aberturas/cliques) distribuídos nos últimos 30 dias
do $$
declare
  org uuid := current_setting('seed.org')::uuid; n int := current_setting('seed.n')::int;
  nomes text[] := array['Ana','Bruno','Carla','Diego','Eduarda','Felipe','Gabriela','Henrique','Isabela','João','Karen','Lucas','Mariana','Nicolas','Olívia','Paulo','Quésia','Rafael','Sofia','Thiago','Úrsula','Vinícius','Wesley','Yasmin','Zélia'];
  sobren text[] := array['Silva','Souza','Oliveira','Santos','Lima','Pereira','Costa','Ribeiro','Almeida','Carvalho','Gomes','Martins','Rocha','Barbosa'];
  prod text[] := array['Curso Fitness Pro','Mentoria Emagrecimento','Ebook Receitas Fit','Plano Anual Treino'];
  preco numeric[] := array[197.00, 497.00, 47.90, 297.00];
  evs text[] := array['Abandono de carrinho','Pix Gerado','Boleto Gerado','Compra Aprovada','Compra Recusada'];
  met text[] := array['Cartão','Pix','Boleto','Cartão','Cartão'];
  i int; k int; p int; lid uuid; ev text; ts timestamptz; camp uuid; mid uuid;
  camps uuid[]; cnt_env int[] := array[0,0,0,0,0]; cnt_vend int[] := array[0,0,0,0,0]; cnt_ab int[] := array[0,0,0,0,0]; cnt_cl int[] := array[0,0,0,0,0];
begin
  select array_agg(id order by created_at) into camps from public.campaigns where organization_id = org and legacy_id = 'seed-demo';
  for i in 1..n loop
    p := 1 + floor(random()*4)::int; k := 1 + floor(random()*5)::int; ev := evs[k];
    ts := now() - (random()*30 || ' days')::interval;
    insert into public.leads (organization_id, nome, sobrenome, email, telefone, produto, valor_compra, metodo_pagamento, pix_gerado, ultimo_evento, legacy_id, created_at)
    values (org, nomes[1+floor(random()*25)::int], sobren[1+floor(random()*14)::int], 'lead' || i || '.demo@exemplo.test',
            '119' || lpad((10000000 + floor(random()*89999999))::text, 8, '0'), prod[p], preco[p], met[k], ev = 'Pix Gerado', ev::public.tipo_evento, 'seed-demo', ts) returning id into lid;
    insert into public.webhook_events (organization_id, provider, tipo_evento, id_webhook, email, produto, valor_produto, metodo_pagamento, pix_gerado, lead_id, created_at)
      values (org, 'postback', ev::public.tipo_evento, 'seed:' || substr(org::text, 1, 8) || ':' || i, 'lead' || i || '.demo@exemplo.test', prod[p], preco[p], met[k], ev = 'Pix Gerado', lid, ts);
    if ev in ('Abandono de carrinho','Pix Gerado','Boleto Gerado','Compra Aprovada') then
      camp := case ev when 'Abandono de carrinho' then camps[1] when 'Pix Gerado' then camps[2] when 'Boleto Gerado' then camps[3] else camps[4] end;
      insert into public.lead_metrics (lead_id, organization_id, enviados) values (lid, org, 1) returning id into mid;
      insert into public.email_events (organization_id, campaign_id, lead_metric_id, event, email, sg_event_id, status, "timestamp", channel)
        values (org, camp, mid, 'send', 'lead' || i || '.demo@exemplo.test', 'seed-s' || substr(org::text, 1, 8) || '-' || i, 'enviado', ts + interval '30 minutes', 'email');
      k := array_position(camps, camp);
      cnt_env[k] := cnt_env[k] + 1;
      if random() < 0.46 then
        insert into public.email_events (organization_id, campaign_id, lead_metric_id, event, email, sg_event_id, status, "timestamp", channel)
          values (org, camp, mid, 'open', 'lead' || i || '.demo@exemplo.test', 'seed-o' || substr(org::text, 1, 8) || '-' || i, 'aberto', ts + interval '50 minutes', 'email');
        cnt_ab[k] := cnt_ab[k] + 1;
        update public.lead_metrics set aberturas = 1 where id = mid;
        if random() < 0.38 then
          insert into public.email_events (organization_id, campaign_id, lead_metric_id, event, email, sg_event_id, status, "timestamp", channel, url)
            values (org, camp, mid, 'click', 'lead' || i || '.demo@exemplo.test', 'seed-c' || substr(org::text, 1, 8) || '-' || i, 'clicado', ts + interval '55 minutes', 'email', 'https://exemplo.test/checkout/fitness-pro');
          cnt_cl[k] := cnt_cl[k] + 1;
          update public.lead_metrics set cliques = 1 where id = mid;
          if ev <> 'Compra Aprovada' and random() < 0.45 then cnt_vend[k] := cnt_vend[k] + 1; end if;
        end if;
      end if;
    end if;
  end loop;
  for k in 1..5 loop
    delete from public.campaign_stats where campaign_id = camps[k];
    insert into public.campaign_stats (campaign_id, organization_id, emails_enviados, taxa_abertura, ctr, vendas_recuperadas, status_criticidade, valor_criticidade, ultimo_calculo)
    values (camps[k], org, cnt_env[k],
      case when cnt_env[k] > 0 then round(cnt_ab[k]::numeric / cnt_env[k], 3) else 0 end,
      case when cnt_env[k] > 0 then round(cnt_cl[k]::numeric / cnt_env[k], 3) else 0 end,
      cnt_vend[k],
      case when cnt_env[k] = 0 then 'Não Iniciado' when cnt_vend[k] >= 4 then 'Excelente' when cnt_vend[k] >= 2 then 'Bom' when cnt_vend[k] >= 1 then 'Mediano' else 'Crítico' end::public.status_criticidade,
      cnt_vend[k], now());
  end loop;
  insert into public.lead_tags (lead_id, tag_id)
    select l.id, t.id from public.leads l join public.tags t on t.organization_id = l.organization_id and t.legacy_id = 'seed-demo' and t.nome = 'Comprou'
    where l.organization_id = org and l.legacy_id = 'seed-demo' and l.ultimo_evento = 'Compra Aprovada' on conflict do nothing;
  insert into public.lead_tags (lead_id, tag_id)
    select l.id, t.id from public.leads l join public.tags t on t.organization_id = l.organization_id and t.legacy_id = 'seed-demo' and t.nome = 'Carrinho abandonado'
    where l.organization_id = org and l.legacy_id = 'seed-demo' and l.ultimo_evento = 'Abandono de carrinho' on conflict do nothing;
  insert into public.lead_tags (lead_id, tag_id)
    select l.id, t.id from public.leads l join public.tags t on t.organization_id = l.organization_id and t.legacy_id = 'seed-demo' and t.nome = 'Pix pendente'
    where l.organization_id = org and l.legacy_id = 'seed-demo' and l.ultimo_evento = 'Pix Gerado' on conflict do nothing;
end $$;
commit;
analyze public.leads; analyze public.webhook_events; analyze public.email_events;
