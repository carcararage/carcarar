-- Passo 2 — defina quem é quem. Rode no SQL Editor DEPOIS de criar os usuários em
-- Authentication → Users → "Add user" (marque "Auto Confirm User").
-- Troque os e-mails pelos que você criou. Rode quantas vezes quiser (é seguro repetir).

-- Administração/gestão (vê tudo, importa o mapa, valida visitas, edita regras)
update perfis
   set papel = 'admin', nome = 'Gestão Barão'
 where id = (select id from auth.users where email = 'gestao@SEU-DOMINIO.com.br');

-- Vendedores. A "chave_import" liga as pastas do Google Earth ao vendedor na importação:
-- é o nome sem acento, minúsculo e com hífen (João Oliveira → joao-oliveira).
update perfis
   set papel = 'vendedor', nome = 'João Oliveira', chave_import = 'joao-oliveira'
 where id = (select id from auth.users where email = 'joao@SEU-DOMINIO.com.br');

update perfis
   set papel = 'vendedor', nome = 'Gislandio Silveira', chave_import = 'gislandio-silveira'
 where id = (select id from auth.users where email = 'gislandio@SEU-DOMINIO.com.br');

-- Conferência: deve listar as 3 pessoas com o papel certo.
select p.nome, p.papel, p.chave_import, u.email
  from perfis p join auth.users u on u.id = p.id
 order by p.papel, p.nome;
