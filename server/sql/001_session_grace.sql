-- Ambientes que já rodaram o 000_bootstrap.sql antes da tolerância de 60 s do refresh token.
alter table auth.sessions add column if not exists rotated_at timestamptz;
