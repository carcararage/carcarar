# Operação do dia a dia (para a gestão)

## Pedir uma mudança
Descreva o que quer no chat com o Claude. Ele altera o código, roda os testes, e abre/atualiza a publicação:
mudanças do app vão ao ar sozinhas depois que os testes passam; mudanças do banco são aplicadas pelo GitHub Actions.
**Cada mudança fica registrada** (quem, quando, o quê) no histórico do GitHub, e dá para voltar atrás.

## Onde olhar se algo parecer errado
- **Site fora do ar / versão antiga:** Netlify → seu site → Deploys (o último deve estar "Published").
- **Algo no banco não publicou:** GitHub → Actions → "Supabase · publicar" (vermelho = falhou; o Claude lê o log e corrige).
- **Backup:** GitHub → Actions → "Backup e manter ativo" → última execução → Artifacts (arquivo dos últimos 90 dias).
  Além disso: app → Ajustes → "Baixar cópia de segurança" (arquivo do que a gestão enxerga, funciona offline).
- **Projeto pausado (plano gratuito):** supabase.com/dashboard → "Restore project". O backup automático a cada 5 dias evita isso.

## Voltar uma versão
- App: Netlify → Deploys → escolha um deploy antigo → "Publish deploy".
- Código: o Claude reverte o commit e publica de novo.
- Banco: migrações não são desfeitas; criamos uma migração nova que corrige. Em caso de perda de dados, restaurar a partir do backup (o Claude faz).

## Restaurar um backup (resumo)
1. Criar projeto Supabase novo e aplicar `supabase/setup_producao.sql`.
2. Recriar os usuários (tela Equipe) — as senhas não vão no backup.
3. Carregar `barao-dados-AAAA-MM-DD.sql` e religar os vendedores às carteiras pelo `chave_import`. O Claude conduz.
