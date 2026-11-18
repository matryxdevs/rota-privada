# Rota Privada V2.1 — Ativar notificações de novas entregas

## O que muda

- Na **Central de entregas** e no **painel do motoboy** aparece **Ativar notificações**.
- Mediante autorização de cada entregador, o navegador registra um dispositivo para Web Push.
- Entregas **manuais não atribuídas** e ofertas elegíveis do **iFood** geram push aos dispositivos inscritos dos entregadores ativos autorizados para a loja.
- A notificação **não exibe cliente, telefone ou endereço**, mesmo na tela bloqueada.
- Ao clicar na notificação, o motoboy abre a Central de entregas. O pedido continua disponível somente até alguém aceitá-lo.
- Um entregador aceita a entrega de forma atômica; os demais não poderão aceitá-la depois.
- Em navegadores que não suportam Push, há avisos locais somente enquanto a página estiver aberta (se o navegador autorizar).

## Implantar com segurança

1. Faça backup consistente do SQLite com `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` (idealmente usando backup nativo SQLite ou com o processo parado), e **teste a restauração**.
2. Preserve o `DB_PATH` existente e as variáveis `ADMIN_TOTP_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `PUBLIC_ORIGIN`, integrações iFood e demais configurações. **Não apague dados nem recrie o banco.**
3. Extraia o ZIP e atualize os arquivos do repositório GitHub já existente, sem enviar `.env`, bancos, arquivos privados ou chaves.
4. A nova dependência `web-push` 3.6.7 será instalada por `npm install` no processo de build Node.js da Hostinger. Se sua Hostinger usar `npm ci`, gere e versione um `package-lock.json` legítimo executando `npm install` em ambiente com acesso à internet e Node 22.13+ antes de implantar. Nunca invente um lockfile manualmente.
5. Antes do deploy, em seu computador com Node.js 22+, execute `npm run generate:vapid`. O comando gera **chaves exclusivas** para este sistema. Guarde-as em um gerenciador de senhas. **Nunca as envie por mensagens ou ao GitHub**.
6. No painel Hostinger → Aplicação Web → Variáveis de ambiente, adicione:

   - `VAPID_PUBLIC_KEY`: chave pública gerada.
   - `VAPID_PRIVATE_KEY`: chave privada gerada.
   - `VAPID_SUBJECT`: `mailto:contato@seudominio.com.br` (substitua por um endereço de contato válido).

7. Garanta que `PUBLIC_ORIGIN` corresponda **exatamente** ao domínio HTTPS atual. Mantenha a página em HTTPS. Salve as variáveis e faça a implantação/reinício.
8. Abra o site com a conta de um **entregador**, não de administrador. Toque em **Ativar notificações**, permita os avisos e pressione **Enviar teste**. Faça isso em cada celular desejado.
9. Cadastre uma **entrega nova** sem motoboy previamente atribuído e confirme que os entregadores autorizados recebem a notificação. Ao aceitar, o pedido deve desaparecer da Central dos demais.
10. A mudança é aditiva: cria tabela `push_subscriptions` para dispositivos opt-in, sem apagar registros antigos.

> Não use as chaves TOTP administrativas para push. VAPID e TOTP são coisas distintas.

## Android e computadores

Utilize navegador atualizado, HTTPS e notificações permitidas no navegador **e no sistema operacional**. Se o navegador estiver fechado, o recebimento depende do serviço push e das restrições do dispositivo, da rede e do sistema. O funcionamento não é garantido em todas as situações.

## iPhone (iOS)

No Safari, abra o site HTTPS, toque em **Compartilhar → Adicionar à Tela de Início**. Inicie o site pelo ícone instalado e pressione **Ativar notificações**, permitindo os alertas. Web Push em iPhone/iPad requer uma versão compatível do iOS/iPadOS e instalação do aplicativo Web na Tela de Início. Verifique também Focus/Não Perturbe e as configurações de notificações do dispositivo.

## Se o botão mostrar apenas “Avisos nesta página”

Isso indica que o servidor ainda não recebeu as três variáveis VAPID ou que o navegador não suporta Push. No primeiro caso, confira as variáveis na Hostinger e reinicie a aplicação. No segundo, teste em navegador/dispositivo compatível.

## Se não chegar aviso

- Verifique o HTTPS, a permissão do navegador e a permissão do sistema operacional.
- Clique em **Enviar teste** para separar erro de Push de erro na disponibilidade do pedido.
- Confirme que a entrega está **pendente**, sem motoboy atribuído, e que a loja está ativa e permite acesso ao entregador.
- Para iFood: só há aviso quando um evento oficial coloca o pedido em uma etapa elegível para oferta (por exemplo, confirmado/pronto para retirada), se a integração e a logística da loja autorizarem. A integração real exige credenciais e homologação do iFood.
- Se alterou as chaves VAPID, cada entregador precisa desativar e ativar novamente as notificações. Evite mudanças de chaves desnecessárias.
- Inscrições expiradas são removidas quando o serviço push responde 404/410. A base de inscrições é privada no SQLite.

## Segurança e limites

- **Não existe garantia de entrega** de mensagens push: podem existir atraso, economia de bateria, bloqueios do sistema, navegadores incompatíveis ou serviços indisponíveis.
- O servidor valida autenticação por sessão, papel `rider`, endpoint HTTPS de provedor push reconhecido, estrutura da inscrição, limites por usuário e escopo por loja.
- O banco armazena endpoint e chaves públicas de inscrição do navegador; proteja armazenamento, backups, privilégios e retenção conforme LGPD. Nunca exponha os valores em logs.
- O envio é iniciado de forma assíncrona, sem travar a criação do pedido. Em alto volume de operações, evolua para fila persistente de notificações e observabilidade.
- Este pacote foi verificado com testes automatizados de API e **transporte push simulado**. Antes da operação comercial, valide em Android, desktop e iOS reais; não foi realizado um envio final por serviço push público a um dispositivo real nesta sessão.
