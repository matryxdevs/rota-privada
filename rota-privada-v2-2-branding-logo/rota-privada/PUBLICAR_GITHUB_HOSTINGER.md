# Publicação segura do Rota Privada no GitHub e na Hostinger

Atualizado em 18/11/2026. Este guia não representa publicação já realizada.

## 1. Verificar antes de publicar

O projeto utiliza Node.js >=22.13 (22.16+ recomendado), `node:sqlite`, `server.js` como entrada e `npm start` como comando inicial. **Não** hospedar somente a pasta `public/` em `public_html`: o login e a API precisam do backend Node.js.

A hospedagem Hostinger Business/Cloud oferece implantação de Node.js via **Sites > Criar site > Aplicativo Web**. Se não reconhecer a estrutura, selecionar `Other`, versão Node 22.x e entrada `server.js`.

**ATENÇÃO AO BANCO:** a Hostinger cria uma nova pasta `hbuilds` a cada implantação; arquivos gravados dentro do build são substituídos/descartados. Esta versão usa SQLite, portanto *antes* de operar clientes/entregadores reais é obrigatório criar e validar uma localização persistente, fora de `hbuilds` e `public_html`, com backup. Se seu plano não permitir gravar nesse local, é necessário migrar a base de dados para outro serviço ou hospedar em VPS com volume persistente. O app agora recusa iniciar em produção sem `DB_PATH` absoluto fora da pasta do projeto.

## 2. Criar repositório privado no GitHub

Abra https://github.com/new, selecione `Private` e defina o nome sugerido `rota-privada`. Não selecione README ou .gitignore adicionais porque já existem neste projeto.

Abra o VS Code **dentro da pasta `rota-privada`** (onde está `package.json`) e execute:

```powershell
git init
git add .
git commit -m "Primeira versão: painel de entregas e conector iFood"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/rota-privada.git
git push -u origin main
```

Altere `SEU_USUARIO` pelo usuário GitHub. É necessário autenticar o GitHub pelo navegador/gerenciador de credenciais; não coloque senha/token em scripts nem me envie o token. O workflow `.github/workflows/ci.yml` executará os testes em pushes/PRs para `main`.

## 3. Implantar a aplicação Node na Hostinger

1. Acesse https://hpanel.hostinger.com/ . Em **Sites → Criar site → Aplicativo Web**, escolha seu domínio ou domínio temporário.
2. Escolha **Importar repositório Git**, conecte o GitHub (autorize o aplicativo oficial da Hostinger) e selecione o repositório privado `rota-privada`.
3. Se solicitado, selecione preset `Other`, Node.js **22.x**, arquivo de entrada `server.js`, pasta raiz do projeto `/` e comando de início `npm start`. Não há comando de build obrigatório (não existe `dist/`).
4. No painel de ambiente do aplicativo, configure as variáveis abaixo **com valores próprios, fora do código-fonte**:

```env
NODE_ENV=production
PUBLIC_ORIGIN=https://entregas.seudominio.com.br
ADMIN_USER=seu_usuario_administrativo
ADMIN_PASSWORD=senha-exclusiva-grande-e-aleatoria
ADMIN_TOTP_SECRET=SUA_CHAVE_BASE32_REAL_DE_32_OU_MAIS_CARACTERES
DB_PATH=/CAMINHO_REAL_PERSISTENTE/rota-privada.sqlite
```

5. Gere `ADMIN_TOTP_SECRET` localmente com `node scripts/generate-totp.mjs` e registre a chave no aplicativo autenticador, salvando um backup seguro. **Não envie o segredo, código TOTP nem a senha para terceiros ou GitHub.**
6. Confirme HTTPS válido no endereço `PUBLIC_ORIGIN`, redirecionamento de HTTP para HTTPS, WAF/rate limiting, DNS e backups. Se usar domínio temporário, a variável `PUBLIC_ORIGIN` deve ser exatamente a origem HTTPS desse domínio durante os testes.
7. Faça um teste de login, registre um pedido fictício, publique uma alteração simples pelo GitHub e confirme que o pedido continua no banco. **Se os dados desaparecerem após o deploy, não inicie operação comercial.**
8. Configure as credenciais oficiais do iFood somente após habilitação junto ao iFood, autorização das lojas e homologação; sem isso, o conector de eventos não recebe pedidos reais.

Variáveis opcionais do iFood (inseridas somente no painel da Hostinger):

```env
IFOOD_CLIENT_ID=CLIENT_ID_HOMOLOGADO
IFOOD_CLIENT_SECRET=CLIENT_SECRET_HOMOLOGADO
IFOOD_MERCHANT_IDS=UUID_LOJA_AUTORIZADA
IFOOD_POLLING=false
```

**O conector do iFood não está homologado ou ativado.** A sincronização real depende de permissões do iFood e dos lojistas; verifique os contratos, tipos de entrega e a documentação oficial antes de produção.

## 4. Verificações mínimas antes de anunciar o site

- Testar autenticação, TOTP, bloqueio após tentativas, acesso limitado por perfil, CSRF e autorização no servidor.
- Criar política de privacidade/LGPD, regras de retenção, backup testado e plano de recuperação.
- Habilitar monitoramento de disponibilidade e logs (sem expor dados pessoais nem credenciais).
- Validar a permanência do banco após pelo menos dois deploys, restauração de backup e reinício da aplicação.
- Executar revisão de segurança e teste de intrusão antes de aceitar dados reais de clientes.

## 5. Referências oficiais

- Hostinger Node.js Web App: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/
- GitHub adicionar projeto local: https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github

**Estado do projeto:** pronto para o usuário importar como repositório; **não** foi criado repositório remoto, domínio público ou hospedagem nesta preparação. As contas e credenciais não estão conectadas nesta sessão.
