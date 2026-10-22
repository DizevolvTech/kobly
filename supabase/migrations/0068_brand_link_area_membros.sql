-- Link da área de membros / acesso ao produto, por marca. Usado nas mensagens de pós-compra
-- ("Compra Aprovada"): o {{cta_link}} delas aponta para cá, e não para o checkout de recuperação.
alter table public.brands add column if not exists link_area_membros text;
comment on column public.brands.link_area_membros is 'URL de acesso ao produto (área de membros). Destino do {{cta_link}} em eventos de pós-compra.';
