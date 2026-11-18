# Rota Privada V2 — atualização segura no GitHub e na Hostinger

**Versão:** 2.0.0 — **Data:** 18/11/2026

Este pacote atualiza o **repositório existente** `matryxdevs/rota-privada`. NÃO cria outro sistema nem substitui o banco de dados.

## 1. Antes de atualizar (obrigatório)

1. Confirme que a Hostinger está executando a V1 com o `DB_PATH` apontando para um volume persistente e gravável, **fora de `hbuilds/versions` e de `public_html`**.
2. Faça um **backup íntegro e restaurável** do SQLite (use a API de backup do SQLite ou desligue a aplicação durante a cópia de todos os arquivos relevantes do banco, incluindo WAL quando aplicável). Copiar apenas o `.sqlite` enquanto o banco está em uso no modo WAL pode gerar um backup incompleto. Faça um teste de restauração em ambiente isolado.
3. Salve fora do GitHub uma cópia das configurações da Hostinger (sem as publicar): `PUBLIC_ORIGIN`, `NODE_ENV`, `ADMIN_TOTP_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD` se necessário, `DB_PATH` e credenciais do iFood, se presentes.
4. Garanta que `DB_PATH` **não foi alterado**. A V2 acrescenta tabelas e colunas no mesmo arquivo de banco; não remove usuários, pedidos, sessões ou certificados de acesso.
5. Programe janela de manutenção para implantação e tenha plano de retorno à V1 **junto com o backup do banco anterior à migração** (apenas reverter o código pode não ser suficiente após alterações de esquema).

## 2. Publicar os arquivos no mesmo repositório

### Com VS Code + Git

```bash
# No terminal, em uma pasta de sua escolha:
git clone https://github.com/matryxdevs/rota-privada.git
cd rota-privada
```

Extraia `rota-privada-v2-github-hostinger.zip`. Copie **o conteúdo interno** da pasta `rota-privada` do ZIP sobre os arquivos correspondentes do diretório recém-clonado; permita a substituição de `server.js`, `ifood.js`, `public/`, `README.md` etc. **Não copie nem apague a pasta `.git` do repositório**, e não inclua arquivos `.sqlite`, `.env` ou senhas.

```bash
# Revise a lista de arquivos alterados:
git status
# Garanta que NÃO aparecem .env, .sqlite, fotos de clientes ou chaves.
git add .
git commit -m "Rota Privada V2: despacho, GPS consentido, lojas e auditoria"
git push origin main
```

Se o GitHub pedir autenticação, use o mecanismo oficial de login do GitHub/VS Code, nunca sua senha em arquivo de código. Se o repositório estiver público, considere torná-lo privado antes de publicar a aplicação.

### Se preferir a interface do GitHub

Atualize os arquivos no repositório existente, na branch `main`, mantendo a mesma estrutura de pastas; **não envie o ZIP fechado como arquivo do repositório**. Ferramentas de sincronização Git/VS Code são mais confiáveis para atualizar muitos arquivos.

## 3. Reimplantar na Hostinger

1. Abra **hPanel → Sites → Rota Privada → Gerenciar → Node.js**.
2. Selecione a origem GitHub `matryxdevs/rota-privada`, branch `main` e solicite nova implantação (ou confirme que o deploy automático foi executado).
3. Mantenha `npm start`, entrada `server.js` e Node.js 22.13 ou superior.
4. Reutilize as variáveis de ambiente da V1. **Não use DB_PATH dentro da pasta do deploy**, não desative 2FA, e não insira chaves no GitHub.
5. Quando o processo iniciar, entre na plataforma. Verifique que os antigos entregadores e pedidos ainda aparecem. Acesse **Lojas e tarifas**: as lojas antigas são associadas automaticamente aos pedidos existentes.
6. Faça um teste com uma nova loja e um pedido de teste. Entre com um motoboy de teste em outro navegador, confira se a oferta aparece na Central de entregas e se some da fila depois do aceite.
7. Teste as etapas e comprovante, permissões por loja, ganho do entregador, GPS com consentimento e logs de execução.
8. Se o site exibir erro 503, confira os Runtime Logs da Hostinger. Não apague o banco e não altere o `DB_PATH` apenas para iniciar o serviço.

## 4. Integração iFood oficial

O projeto reutiliza o conector já existente `ifood.js`. Para pedidos reais, obtenha habilitação/autorização oficial e configure **somente no ambiente da Hostinger**:

```env
IFOOD_CLIENT_ID=valor_oficial
IFOOD_CLIENT_SECRET=valor_oficial
IFOOD_MERCHANT_IDS=merchant-id-1,merchant-id-2
# Se o iFood habilitou polling para sua aplicação:
IFOOD_POLLING=true
```

Webhook assinado: `https://SEU-DOMINIO/webhooks/ifood`. Configure-o de acordo com a documentação e a homologação do Portal do Desenvolvedor iFood. O projeto valida `X-iFood-Signature` com HMAC do conteúdo bruto. Não publique o segredo. O iFood só entrega dados de lojas autorizadas e o módulo Logistics pode depender de habilitação específica. Pedidos operados pela frota do iFood são acompanhados, não atribuídos pela frota privada.

**Atenção às etapas oficiais:** ações de logística podem responder HTTP 202. Isso **não** significa confirmação definitiva; o status final é atualizado a partir do evento oficial subsequente. Revise fluxos, eventos, payloads e permissões em sandbox/homologação antes do uso comercial.

## 5. O que a V2 acrescenta

- Central compartilhada de ofertas com **aceite atômico**: o primeiro entregador autorizado que aceitar passa a ser o responsável; os demais recebem indisponibilidade.
- Área privada do entregador: seus pedidos, etapas da jornada, repasses e histórico.
- Lojas e estabelecimentos, tabelas de taxa base e por quilômetro e atribuição de acesso por estabelecimento (aberto ou restrito).
- Etapas da jornada manual: atribuído → indo à loja → chegou à loja → coletou → em entrega → chegou ao cliente → concluído.
- Comprovante fotográfico (arquivo privado) ou código de oito dígitos gerado pelo administrador; pedidos novos exigem um desses comprovantes antes de concluir a entrega própria.
- GPS opt-in pelo celular em HTTPS; o administrador só consulta a última posição (não o histórico); dados expirados são eliminados periodicamente.
- Atualização da fila a cada 8 segundos com página aberta. Na V2.1, Web Push fica disponível para dispositivos compatíveis após configuração VAPID e aceite individual. Consulte `ATIVAR_NOTIFICACOES_HOSTINGER.md`.
- Histórico individual e painel de auditoria operacional e de acessos administrativos.
- Nova interface responsiva vermelho, preto e branco.

**Distâncias:** são informadas manualmente pelo administrador; a V2 não chama Google Maps ou outro geocodificador para calcular distância real. Tarifas calculadas usando valor informado, não têm vínculo com repasses iFood. Valores históricos não são recalculados.

## 6. Segurança e limitações

- As migrações SQLite usam `CREATE TABLE IF NOT EXISTS` e `ALTER TABLE ... ADD COLUMN` somente se a coluna não existir. **Não removem tabelas existentes**.
- Autenticação administrativa TOTP preservada, hash scrypt de senha, CSRF, validação de origem, escopos por loja, segredos do iFood só no servidor.
- A fila não expõe nome/telefone/endereço completo do cliente antes do aceite. Apenas o entregador designado e a administração veem os detalhes.
- Fotos armazenadas em `proofs/` ao lado do arquivo indicado por `DB_PATH`, nunca na pasta `public/`. Somente administrador ou entregador da entrega consegue consultar. Configure backups cifrados e política de retenção LGPD; as fotos **não** são eliminadas automaticamente nesta versão.
- GPS somente com consentimento explícito, navegação HTTPS e página ativa; entregadores podem interromper a qualquer momento. A última posição fica disponível para o administrador durante 15 minutos, com retenção técnica máxima de 24h até a limpeza periódica.
- Auditoria operacional retida por até 180 dias; segurança até 90 dias (valores padrão do código). Avalie prazos reais com seu encarregado LGPD.
- A V2 é um sistema web Node.js com banco SQLite, indicado para **uma única instância persistente**. Para múltiplas instâncias, alto volume ou infraestrutura efêmera, é necessário adaptar para banco transacional gerenciado. A hospedagem Hostinger pode oferecer MySQL conforme o plano, mas isso requer migração específica do projeto; não basta trocar `DB_PATH`.
- Segurança absoluta não existe. Antes da operação com dados reais, faça pentest, backup/restauração testada, monitoramento, política de privacidade, gestão de incidentes e homologação iFood.

## 7. Testes

```bash
node --version  # >=22.13
npm test
```

O comando executa testes existentes de segurança/iFood e o teste V2 de migrações, RBAC, aceite, comprovantes, GPS e financeiro. Usa **Node.js e Python 3** apenas para testes, sem dependências extras. As telas de interface foram pré-visualizadas com dados de exemplo, sem um navegador conectado à sua Hostinger.
