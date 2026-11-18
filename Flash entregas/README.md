# Flash Entregas 2.3 — Plataforma de gestão e rastreamento de entregas

**ATUALIZAÇÃO V2:** antes de alterar seu repositório GitHub/Hostinger existente, leia **[ATUALIZAR_GITHUB_HOSTINGER_V2.md](ATUALIZAR_GITHUB_HOSTINGER_V2.md)**. Esta versão preserva o banco existente mediante migrações aditivas, desde que você conserve o `DB_PATH` e realize backup seguro.

Inclui central compartilhada de entregas, aceite exclusivo, etapas, comprovantes por foto/código, GPS consentido, lojas e tarifas, histórico individual, auditoria e tema vermelho/preto/branco. Na V2.1, Web Push permite avisos em segundo plano nos dispositivos compatíveis, após consentimento e configuração VAPID. iFood real requer autorização e homologação.

---

# Flash Entregas — Gestão de entregadores e entregas

Sistema web responsivo com administração de pedidos, atribuição de entregadores, etapas da entrega, financeiro, exportação CSV e acesso individual para cada entregador.

**Este é um projeto original inspirado na categoria de sistemas de gestão de entregas.** Não reproduz a interface interna do site de referência nem importa dados daquele serviço. Nome e identidade visual são provisórios.

## Requisitos

- Node.js **22.13 ou mais recente** (o projeto utiliza `node:sqlite`, módulo nativo do Node 22; em algumas versões poderá haver aviso de recurso experimental).
- Hospedagem Node.js com disco persistente **fora da pasta do deploy** e HTTPS para produção. Em planos gerenciados, confirme que este armazenamento é permitido e sobrevive a reinicializações e atualizações.
- Nenhuma dependência externa é necessária: basta executar `npm start`.

## Testar em seu computador (VS Code)

1. Descompacte a pasta `rota-privada`.
2. Abra a pasta no VS Code e abra o terminal integrado.
3. Verifique `node -v` (necessário Node 22.13+).
4. Execute `npm start`.
5. Abra **http://localhost:3000** no navegador.

**Acessos de demonstração somente em desenvolvimento (sem NODE_ENV=production e acessíveis apenas em localhost):**

- Administrador — usuário `admin`, senha `Admin@123456`.
- Entregador de exemplo — usuário `lucas`, senha `Entregador@123`.

Outros usuários de demonstração: `mariana` e `rafael`, com a mesma senha de exemplo. O banco de desenvolvimento é preenchido com dados fictícios. **Nunca utilize essas credenciais em produção.**

## Preparar para publicar na Hostinger (Node.js)

1. Crie uma aplicação do tipo **Node.js**, com versão Node 22.13+ (não publique como site HTML estático).
2. No hPanel, escolha **Sites → Criar site → Aplicativo Web**, importe o repositório GitHub e selecione o preset **Other** se o framework não for reconhecido; escolha **Node 22.x**. Não use o menu antigo **Avançado → Git**, destinado a outro fluxo. O ponto de entrada é `server.js`; comando de inicialização `npm start` ou `node server.js`. Não envie o banco `.sqlite` de desenvolvimento.
3. Gere a chave para o código de segurança com `node scripts/generate-totp.mjs` e escaneie o QR opcionalmente utilizando o URI `otpauth://...` em um aplicativo autenticador compatível. Depois configure as variáveis de ambiente no painel de sua hospedagem:

   ```env
   NODE_ENV=production
   PUBLIC_ORIGIN=https://entregas.seudominio.com.br
   ADMIN_USER=seu_usuario_administrativo
   ADMIN_PASSWORD=uma_senha_exclusiva_com_12_ou_mais_caracteres
   ADMIN_TOTP_SECRET=SUA_CHAVE_BASE32_DE_32_CARACTERES
   PORT=3000
   DB_PATH=/caminho/absoluto/PERSISTENTE/fora-de-hbuilds/rota-privada.sqlite
   ```

4. **Obrigatório antes da primeira publicação:** providencie um diretório de dados persistente, com permissão de gravação e fora de `hbuilds/` e `public_html/`, acessível à aplicação Node e incluído em backups. Teste a persistência em **duas publicações sucessivas**. Se sua hospedagem gerenciada não oferecer esse recurso, **não use este SQLite com pedidos reais**: migre para banco gerenciado com adaptação de código ou escolha um VPS com volume persistente.
5. Conecte o seu domínio e habilite HTTPS. Nunca exponha a aplicação de produção sem TLS.
6. Inicie a aplicação. O usuário administrador será criado automaticamente **somente quando o banco estiver vazio**. O painel de produção não carrega pedidos ou entregadores fictícios.
7. Faça login, vá em **Minha conta → Alterar senha**, cadastre os entregadores e comece a criar pedidos.

**Importante:** alterar `ADMIN_PASSWORD` depois do primeiro login **não altera a senha no banco existente**. Para isso, use a tela "Minha conta → Alterar senha". O diretório `data/` interno ao projeto serve **apenas para desenvolvimento local**. A Hostinger usa pastas de builds versionadas, por isso `DB_PATH` é obrigatório e deve apontar para um volume externo persistente. Se não puder garantir persistência e backup, não opere dados reais.

### Publicar no GitHub

1. Crie um repositório **privado** (preferível por conter lógica administrativa, embora nenhuma credencial real deva entrar no repositório).
2. Dentro da pasta do projeto, execute (com Git instalado e autenticado na sua conta):

   ```bash
   git init
   git add .
   git commit -m "MVP de gestão de entregas privadas"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
   git push -u origin main
   ```

3. Se a Hostinger oferecer integração com GitHub, conecte esse repositório ao seu projeto Node.js.
4. **Não publique** o arquivo `.env`, credenciais, arquivos de banco `.sqlite` ou dados pessoais de clientes.

## Funções incluídas

| Recurso | Administrador | Entregador |
|---|:---:|:---:|
| Login individual | ✓ | ✓ |
| Visão geral | ✓ | ✓ |
| Cadastrar e editar pedido | ✓ | — |
| Designar entregador | ✓ | — |
| Consultar pedidos atribuídos | ✓ | ✓ (apenas os seus) |
| Confirmar coleta, iniciar rota, concluir | ✓ | ✓ (apenas os seus) |
| Cancelar pedidos pendentes/em andamento | ✓ | — |
| Cadastrar, ativar/desativar entregadores | ✓ | — |
| Redefinir senha do entregador | ✓ | — |
| Relatórios financeiros e CSV | ✓ | — |
| Alterar senha própria | ✓ | ✓ |
| Abrir coleta/destino no Google Maps | ✓ | ✓ |

### Fluxo das entregas

**Pendente → Atribuída → Coletada → Em rota → Entregue.** O administrador também pode cancelar uma entrega que ainda não foi concluída. Os eventos das alterações ficam registrados no banco de dados.

## Estrutura

```text
rota-privada/
  server.js              API, autenticação, SQLite e arquivos estáticos
  ifood.js               Conector OAuth, webhooks e logística iFood
  scripts/
    generate-totp.mjs    Geração segura da chave MFA do administrador
  tests/                 Testes de segurança e do fluxo demonstrativo iFood
  public/
    index.html           Interface da aplicação
    styles.css           Layout responsivo
    app.js               Lógica do painel e integração com a API
    favicon.svg          Marca provisória
  data/
    .gitkeep             Pasta do banco local, vazio no ZIP
  package.json
  .env.example
  .gitignore
  README.md
```

## Segurança e limitações

- Senhas armazenadas com `scrypt` e salt aleatório; sessões com cookies HttpOnly, SameSite e Secure no ambiente de produção.
- Autorização de funções aplicada no servidor; usuários entregadores não podem consultar os dados dos demais.
- Endpoint de login possui limitação básica de tentativas **em memória**; para operação com muitos usuários, use também rate limiting no proxy e monitoramento.
- O sistema é um **MVP executável**. O conector iFood está implementado, mas requer credenciais oficiais, autorização das lojas e homologação. Não inclui rastreamento GPS ao vivo, envio automático de mensagens de WhatsApp/SMS, cobranças Pix automáticas, notificações push, logs administrativos consultáveis na UI, multiempresas, ou aplicativo nativo. Essas funcionalidades exigem serviços externos, permissões e/ou desenvolvimento adicional.
- Esta versão usa SQLite local, adequado a um servidor Node persistente de baixo volume. Para operação intensiva e múltiplos servidores, recomenda-se banco gerenciado como PostgreSQL.
- Conforme o uso real, é preciso definir prazos de retenção de dados, política de privacidade, controles LGPD, logs, backups, testes e procedimentos de recuperação antes do lançamento comercial.

## Personalização

- Para alterar nome, slogan e textos: edite `public/index.html`.
- Para alterar a identidade visual: edite as variáveis CSS no começo de `public/styles.css`.
- Para novas regras de negócio: edite os endpoints em `server.js` e as telas em `public/app.js`.


## Proteção da aplicação e de dados pessoais — versão reforçada

A aplicação utiliza práticas alinhadas à **OWASP ASVS 5.0** como ponto de partida, mas **nenhum sistema pode ser declarado invulnerável apenas com código**. Para publicação comercial, pentest independente, operação segura, manutenção e revisão LGPD são requisitos de implantação.

**Controles implementados no código:**

- **TLS obrigatório na URL pública de produção:** `PUBLIC_ORIGIN` deve ser HTTPS, com certificado válido e redirecionamento HTTP → HTTPS configurados na hospedagem. O login administrativo exige código TOTP (em produção); os cookies de sessão têm atributos `HttpOnly`, `Secure` (em produção), `SameSite=Strict` e expiram após 12 horas; a troca de senha invalida todas as sessões.
- **Proteção CSRF:** qualquer alteração via API requer o cabeçalho não-simples `X-Requested-With: XMLHttpRequest`, com validação da origem e do contexto de navegação. Não ativar CORS irrestrito na hospedagem.
- **Proteção de navegador:** CSP, HSTS em produção, `X-Frame-Options: DENY`, `nosniff`, política de referenciador e bloqueio de recursos não necessários.
- **Senhas:** derivação com `scrypt`, salt criptográfico exclusivo, comparação em tempo constante, no mínimo 12 caracteres ao criar ou alterar senhas; senhas jamais retornam nas respostas.
- **Autorização no backend:** o entregador acessa apenas os pedidos atribuídos; valores de receita/taxa ficam restritos ao administrador. O histórico de tentativas de login, criação/bloqueio de motoboys e alterações de senha é registrado com IP pseudonimizado.
- **Antiabuso:** limitação de tentativas de login por IP/usuário e cotas gerais por IP em memória; requisições JSON limitadas a 32 KiB. Em produção use WAF/rate limit também no reverse proxy/CDN, pois limites em memória não protegem contra ataque distribuído.
- **Integração iFood:** token OAuth e segredo somente no servidor; webhooks validados por HMAC antes da ingestão, eventos persistidos com deduplicação, lojas permitidas por `IFOOD_MERCHANT_IDS` e confirmação assíncrona das etapas antes da mudança de status. A operação real requer homologação/autorização do iFood.

**Requisitos antes de receber pedidos reais:**

1. Configure HTTPS, `PUBLIC_ORIGIN`, credenciais exclusivas, senhas novas e `IFOOD_MERCHANT_IDS` estritamente limitado às lojas que autorizaram sua aplicação.
2. Habilite WAF com mitigação DDoS, rate limiting na borda, monitoramento e alerta de falhas de login; restrinja o acesso administrativo quando possível. Não confie em `X-Forwarded-For` sem um proxy de confiança explicitamente configurado.
3. Faça backups criptografados e testados do SQLite ou migre para PostgreSQL gerenciado com backups/alta disponibilidade. Proteja o acesso ao diretório de dados e defina um procedimento de restauração.
4. Tenha política de privacidade, controle de retenção e descarte de dados, canal de atendimento ao titular e avaliação da base legal de tratamento conforme LGPD.
5. Execute varredura de vulnerabilidades, testes de autorização entre perfis, teste de intrusão externo, testes de carga e revisão das permissões da API do iFood **antes do lançamento comercial**. A autenticação multifator TOTP é **obrigatória para o administrador em produção** e impede o reuso do mesmo código de 30 segundos. Para múltiplas contas administrativas futuramente, será necessária a configuração individual de chaves por usuário.
6. Acompanhe atualizações de Node.js, host, certificados, DNS e regras do firewall. Evite divulgar detalhes de erros internos no cliente.

**Atenção:** o login informado pelo usuário para visualizar o sistema de referência não é usado nesta aplicação e não deve ser reutilizado como credencial administrativa. Se estiver em uso em outros serviços, altere-o antes de integrar dados de clientes.


### Como preparar o autenticador TOTP do administrador

Execute `node scripts/generate-totp.mjs`. Guarde a chave exibida em um gerenciador de senhas. Adicione uma conta no aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou equivalente) usando a **chave Base32** ou um gerador local de QR Code a partir do URI `otpauth://...`. Configure `ADMIN_TOTP_SECRET` com a mesma chave e preencha os 6 dígitos exibidos no autenticador no login do administrador. O relógio do servidor deve estar sincronizado por NTP. Nunca compartilhe a chave nem o URI público; uma perda de chave requer procedimento de recuperação fora da aplicação, com acesso seguro ao servidor.


## Testes de validação

Com Python 3 disponível no computador, execute `python tests/security_smoke.py` e `python tests/ifood_demo_smoke.py` para simular controles de acesso, proteção CSRF, TOTP administrativo, cabeçalhos de segurança e o fluxo de acompanhamento de uma entrega iFood **em modo de demonstração**. Os testes não usam credenciais reais nem certificam a segurança contra todos os tipos de ataque; testes profissionais adicionais são necessários para produção.

## CI e publicação automática

O fluxo `.github/workflows/ci.yml` executa testes do projeto em cada push e pull request na branch `main`. No hPanel, **Sites → Criar site → Aplicativo Web → Importar repositório Git**: conecte sua conta GitHub, selecione o repositório privado e habilite implantação automática para a branch `main` quando a configuração de produção estiver pronta. A Hostinger pode republicar imediatamente após cada push; revisão de código e testes continuam necessários antes de enviar alterações à branch publicada. A ligação do GitHub não configura automaticamente o banco persistente, DNS, HTTPS, segredos ou acesso iFood.

**Documentação oficial:** https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/


## V2.1 — Notificações push para entregadores

O painel já inclui o botão **Ativar notificações** para cada entregador e a opção **Enviar teste**. As notificações Web Push usam `web-push` e precisam de três variáveis VAPID. As inscrições são específicas de cada navegador/dispositivo e armazenadas numa nova tabela SQLite, sem apagar pedidos ou usuários. Cada entrega elegível é enviada apenas às contas autorizadas para a loja. Veja **`ATIVAR_NOTIFICACOES_HOSTINGER.md`** para publicação, ativação Android/iPhone e testes.

Para gerar novas chaves (não incluir em commits): `npm run generate:vapid`.


## Atualização para Flash Entregas 2.3
Veja `ATUALIZACAO_FLASH_ENTREGAS_V23.md`. Esta versão renomeia a interface, inclui mapa GPS administrativo com atualização de posições consentidas, e aprimora o envio de fotos de comprovantes para celular, inclusive após conclusão da entrega.
