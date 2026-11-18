'use strict';
// Módulo fake APENAS para testes: não faz rede nem substitui web-push em produção.
const fs=require('node:fs');
module.exports={
  setVapidDetails(){},
  async sendNotification(subscription,payload){
    fs.appendFileSync(process.env.RP_PUSH_TEST_CAPTURE,JSON.stringify({endpoint:subscription.endpoint,payload:JSON.parse(payload)})+'\n');
    return {statusCode:201};
  }
};
