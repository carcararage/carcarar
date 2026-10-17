# Colocar o Barão Visitas no ar (Supabase)

Tempo: uns 30 minutos, sem programar. O app fica instalado no celular de cada vendedor, **funciona sem sinal** e envia as visitas quando a internet volta.

> **Segurança (importante):** os dados reais de clientes (CNPJ, telefones, visitas) ficam no **Supabase**, não neste repositório. Antes de usar dados reais, mova o app para um **repositório privado**; o repositório atual publica um site.

## 1. Criar o projeto no Supabase

1. Entre em [supabase.com](https://supabase.com) com a conta que será a **dona** (a da Barão, de preferência) e crie um projeto novo:
   - nome: `barao-visitas`
   - região: **South America (São Paulo)** (menor latência no Piauí)
   - senha do banco: gere uma forte e guarde no gerenciador de senhas.
2. **Plano:** o gratuito serve para testar, mas **projetos gratuitos são pausados após cerca de 1 semana sem uso** e não têm backup diário. Para valer, use o **Pro**. Confira preço e limites atuais em supabase.com/pricing.

## 2. Instalar o banco

1. Menu **SQL Editor → New query**.
2. Abra o arquivo [`setup_producao.sql`](./setup_producao.sql), copie **tudo**, cole e clique **Run**. Deve terminar sem erro. (Rode **uma vez**, num projeto vazio.)

## 3. Fechar a porta de entrada (não pule)

Menu **Authentication → Sign In / Providers** (ou *Settings*):

- **Desligue** "Allow new users to sign up" (cadastro livre). Só a gestão cria usuários, senão qualquer pessoa na internet conseguiria criar uma conta e enxergar nomes e locais dos clientes.
- Em **Email**, deixe "Confirm email" ligado ou use "Auto Confirm" ao criar usuários (passo seguinte).
- Mantenha as senhas com no mínimo 8 caracteres.

## 4. Criar as pessoas

1. **Authentication → Users → Add user → Create new user**: um por pessoa (gestão, João, Gislandio), com e-mail e uma senha inicial, marcando **Auto Confirm User**.
2. Abra [`passo2_usuarios.sql`](./passo2_usuarios.sql), troque os e-mails e rode no **SQL Editor**. Isso define quem é admin e quem é vendedor.

## 5. Pegar as duas chaves do app

**Project Settings → API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / publishable key** → `VITE_SUPABASE_ANON_KEY`

A chave `anon` é **pública por desenho** (vai dentro do app); quem protege os dados são as regras do banco. **Nunca** coloque a `service_role` no app.

## 6. Publicar o app

O app é um site estático (PWA). Qualquer hospedagem com HTTPS serve (Netlify, Cloudflare Pages, Vercel...).

```bash
cd app
cp .env.example .env.local      # preencha as duas chaves
npm ci
npm run build                   # gera app/dist
```

Publique a pasta `app/dist`. Em hospedagem com build automático, cadastre as duas variáveis nas configurações do site.

## 7. Instalar no celular de cada vendedor

1. Abra o endereço no Chrome (Android) ou Safari (iPhone) **com internet** e entre com e-mail e senha. Na primeira vez o app baixa a carteira (pode levar alguns segundos).
2. **Adicionar à tela inicial** (Chrome: menu ⋮ → *Instalar app*; Safari: Compartilhar → *Adicionar à Tela de Início*). Abra sempre pelo ícone.
3. Permita **localização** quando o app pedir (é só no check-in da visita).
4. Pronto: sem sinal, tudo continua funcionando. O chip no topo mostra **"Sem sinal · 2 a enviar"** e vira **"Tudo enviado"** quando a internet volta.

## 8. A gestão carrega os clientes

Entre como gestão, vá em **Importar** e envie o KML do Google Earth e depois a planilha do ERP. A importação roda no servidor (precisa de internet) e vai em lotes.

## Como o offline funciona (para quem for dar suporte)

- Cada aparelho guarda uma **cópia** do que aquela pessoa pode ver: vendedor = carteira dele completa + clientes livres + clientes dos colegas só com nome, bairro e local ("vinculado a Fulano"). Gestão = tudo.
- Tudo que o vendedor faz (visita, cadastro, assumir cliente, corrigir contato, marcar local) vale na hora no aparelho e entra numa **fila**. Quando há internet, a fila vai ao servidor **na ordem**; reenvio não duplica (cada ação tem um identificador gerado no aparelho).
- **O servidor sempre revalida**: raio do check-in (150 m), quem pode alterar o quê, duplicidade de cliente. Se recusar algo (por exemplo, outro vendedor assumiu o mesmo cliente antes), a ação aparece como **Recusada**, com o motivo, no chip de sincronização, e a cópia local volta a refletir o servidor. Nada some sem aviso.
- O horário da visita é o do aparelho; o servidor também grava a hora em que recebeu (para detectar data forjada).
- **Aparelho trocado ou app desinstalado antes de enviar = ações perdidas.** Peça aos vendedores para abrirem o app com sinal ao fim do dia. O app pede ao navegador para não apagar os dados.
- iPhone: o Safari pode apagar os dados de sites não instalados após alguns dias; por isso **instale na tela inicial**.
- O mapa (fundo de ruas) só mostra o que já foi carregado antes; os pontos aparecem sempre.

## Rotina

- **Criar vendedor novo:** Authentication → Add user, depois um `update perfis ...` como no passo 2.
- **Desligar vendedor:** `update perfis set ativo = false where id = ...;` (o acesso cai na hora; os dados ficam).
- **Redefinir senha:** Authentication → Users → ⋯ → *Send password recovery* ou defina uma nova.
- **Backup:** ligue os backups no plano Pro e, antes de mudanças grandes, exporte (Database → Backups).
- **Atualizar o banco no futuro:** cada migração nova vira um arquivo em `migrations/`; rode `gerar_setup.sh` e aplique **apenas o arquivo novo** no SQL Editor.

## Testar tudo sem conta nenhuma

```bash
cd app
node e2e/fake-supabase.mjs &                      # Postgres real + "porteiro" de mentira (porta 54321)
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x npx vite build --outDir dist-real
npx vite preview --outDir dist-real --port 4174 &
node e2e/real.mjs                                 # login, offline, volta do sinal, 3 perfis
```
