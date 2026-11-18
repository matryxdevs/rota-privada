# Flash Entregas v2.3 — atualização na Hostinger

## O que mudou
- Nome Flash Entregas no navegador, login, menu, rodapé, PWA e notificações. Logo de raio amarelo preservada.
- Acompanhamento GPS dentro do painel **GPS da equipe**, em mapa interativo Leaflet/OpenStreetMap. Dados visíveis somente ao administrador autenticado. Atualização automática a cada 8 segundos quando a aba está aberta; o entregador deve autorizar o GPS e manter a página ativa. Sem rastreamento em segundo plano.
- Envio de fotos: compressão local automática para JPEG até cerca de 320 KB, feedback de upload e mensagens de erro; entregas concluídas aceitam comprovante por até 72 horas para entregadores, e a qualquer momento para administradores.

## Implantação sem perda de dados
1. Faça backup do arquivo SQLite definido em `DB_PATH` e dos arquivos da pasta privada `proofs/`, que está no mesmo diretório do banco. Faça cópia consistente com aplicação parada ou API de backup do SQLite, incluindo as transações WAL.
2. Extraia o ZIP e envie os arquivos **na raiz** de `matryxdevs/rota-privada` na branch `main`. A raiz do repositório precisa conter `package.json` e `server.js`.
3. Em Hostinger, diretório raiz `./` (ou `/` conforme o painel), entrada `server.js`, comando `npm start`, Node.js >=22.13. Não configure `npm run build` como obrigatório.
4. Preserve `DB_PATH`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOTP_SECRET`, `PUBLIC_ORIGIN`, chaves VAPID e credenciais iFood atuais.
5. Publique e teste login admin, tela de entregadores, foto de comprovante e GPS. Se o atalho antigo do aplicativo continuar com o nome anterior, remova-o da tela inicial e adicione novamente para atualizar o manifesto.

## Testar GPS
- Em uma conta de entregador no celular, abra o Flash Entregas com HTTPS, entre em **Minha operação** e clique em **Ativar compartilhamento de localização**. Autorize a geolocalização no navegador.
- Em outra sessão, login de administrador → **GPS da equipe**. Aguarde até 15 segundos. Clique no entregador para centralizar. A posição é atualizada em até 8-15 segundos enquanto a página do entregador continua ativa e a conexão funciona. Não funciona de modo confiável com tela bloqueada ou navegador fechado.
- O mapa utiliza a biblioteca Leaflet 1.9.4 com integridade verificada (SRI) e mapas do OpenStreetMap. Precisa de acesso à Internet. Para alto volume, contrate um provedor de tiles com licença e SLA próprios.

## Comprovantes
- Abra uma entrega atribuída → **Comprovante** → selecione uma foto (JPEG/PNG; HEIC quando o navegador conseguir decodificar) → **Enviar foto**.
- Fotos são convertidas em JPEG, metadados EXIF e geolocalização original não são enviados.
- Fotos permanecem em `proofs/` ao lado do banco, fora de `public/`.
- O servidor pode recusar o upload se o volume persistente estiver sem permissão de escrita; um aviso específico aparecerá no formulário.
- Atenção: pedidos iFood continuam sujeitos à confirmação oficial e o comprovante local não confirma sozinho a entrega no iFood.

## Segurança e privacidade
- GPS somente por consentimento do entregador; acesso administrativo exclusivo; somente a última posição é registrada e posições com mais de 15 minutos não aparecem.
- Fotos somente para admin ou entregador responsável; validação do formato e limites de tamanho mantidos.
- Scripts de mapas via CDN fixado e SRI; imagens de mapa vão ao serviço OpenStreetMap, que recebe os quadrantes geográficos visualizados no navegador administrativo.
