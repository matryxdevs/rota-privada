'use strict';
const crypto = require('node:crypto');
const {URL} = require('node:url');

// Push opt-in por dispositivo. Só armazena subscrições, sem dados pessoais de pedidos.
// Não realiza requisições de push para URLs arbitrárias (proteção SSRF).
module.exports = function createNotifications({db,one,all,run,now,send,error,bodyJSON,production,ifood,syncStores}) {
  const publicKey=String(process.env.VAPID_PUBLIC_KEY||'').trim();
  const privateKey=String(process.env.VAPID_PRIVATE_KEY||'').trim();
  const subject=String(process.env.VAPID_SUBJECT||'').trim();
  const configured=!!(publicKey&&privateKey&&subject);
  if ((publicKey||privateKey||subject) && !configured) {
    console.warn('Push desativado: configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT em conjunto.');
  }
  const keyPattern=/^[A-Za-z0-9_-]+$/;
  if(configured && (!keyPattern.test(publicKey)||!keyPattern.test(privateKey) || !/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$|^https:\/\/[^\s]+$/.test(subject))) {
    throw Error('Chaves VAPID ou VAPID_SUBJECT inválidos.');
  }
  let webpush=null;
  if(configured) {
    try{ webpush=require('web-push'); }
    catch {throw new Error('Para ativar notificações Web Push, instale a dependência npm web-push.');}
    webpush.setVapidDetails(subject,publicKey,privateKey);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);`);
  // Endpoint é uma URL com capacidade de entrega. Não registrar os valores ou os segredos em logs.
  function allowedEndpoint(endpoint) {
    if(typeof endpoint!=='string'||endpoint.length>1200)return false;
    try{
      const u=new URL(endpoint);
      if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
      const host=u.hostname.toLowerCase();
      return host==='fcm.googleapis.com'||host==='fcm-xm.googleapis.com'||host==='android.googleapis.com'||
        host==='updates.push.services.mozilla.com'||host==='push.services.mozilla.com'||
        host==='web.push.apple.com'||host.endsWith('.push.apple.com')||
        host==='notify.windows.com'||host.endsWith('.notify.windows.com');
    } catch {return false;}
  }
  const b64pattern=/^[A-Za-z0-9_-]+={0,2}$/;
  function validKey(value,bytes) {
    if(typeof value!=='string'||!b64pattern.test(value)||value.length>180)return false;
    try{return Buffer.from(value,'base64url').length===bytes;}catch{return false;}
  }
  function onlyRider(user,res) {
    if(user.role!=='rider') {error(res,403,'Notificações de entregas são exclusivas dos entregadores.');return false;}
    return true;
  }
  async function handle(req,res,user,route,method) {
    if(!route.startsWith('/api/push/'))return false;
    if(!onlyRider(user,res))return true;
    if(route==='/api/push/config'&&method==='GET'){
      return send(res,200,{enabled:configured,publicKey:configured?publicKey:null,
        devices:one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?',user.id).n}),true;
    }
    if(route==='/api/push/subscribe'&&method==='POST'){
      if(!configured)return error(res,503,'Notificações push ainda não foram configuradas no servidor.'),true;
      const b=await bodyJSON(req);
      const s=b.subscription;
      if(!s||!allowedEndpoint(s.endpoint)||!validKey(s.keys?.p256dh,65)||!validKey(s.keys?.auth,16)) {
        return error(res,400,'Inscrição do navegador inválida ou serviço push não permitido.'),true;
      }
      const other=one('SELECT user_id FROM push_subscriptions WHERE endpoint=?',s.endpoint);
      if(other&&other.user_id!==user.id)return error(res,409,'Essa inscrição já pertence a outra conta. Remova-a neste dispositivo antes de trocar de usuário.'),true;
      run(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`,
        user.id,s.endpoint,s.keys.p256dh,s.keys.auth,now(),now());
      const older=all('SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 5',user.id);
      for(const record of older)run('DELETE FROM push_subscriptions WHERE id=? AND user_id=?',record.id,user.id);
      return send(res,200,{ok:true}),true;
    }
    if(route==='/api/push/subscribe'&&method==='DELETE'){
      const b=await bodyJSON(req);
      if(typeof b.endpoint!=='string'||b.endpoint.length>1200)return error(res,400,'Inscrição inválida.'),true;
      run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?',b.endpoint,user.id);
      return send(res,200,{ok:true}),true;
    }
    if(route==='/api/push/test'&&method==='POST'){
      if(!configured)return error(res,503,'Notificações push ainda não foram configuradas no servidor.'),true;
      const count=one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?',user.id).n;
      if(!count)return error(res,409,'Ative primeiro as notificações neste dispositivo.'),true;
      const sent=await pushToUsers([user.id],{type:'test',title:'Notificações ativadas',body:'Seu dispositivo pode receber avisos de novas entregas.',url:'/?view=board'},true);
      return send(res,202,{ok:true,queued:count,sent}),true;
    }
    return error(res,404,'Rota não encontrada.'),true;
  }
  const lastTest=new Map();
  async function pushToUsers(ids,payload,test=false){
    if(!configured||!ids.length)return 0;
    if(test){const id=ids[0],t=Date.now();if((lastTest.get(id)||0)>t-60000)throw Object.assign(new Error('Teste limitado a uma tentativa por minuto.'),{statusCode:429});lastTest.set(id,t);}
    const unique=[...new Set(ids)].filter(Number.isSafeInteger);
    const placeholders=unique.map(()=>'?').join(',');
    const subscriptions=all(`SELECT p.id,p.endpoint,p.p256dh,p.auth,p.user_id FROM push_subscriptions p JOIN users u ON u.id=p.user_id
      WHERE p.user_id IN (${placeholders}) AND u.role='rider' AND u.active=1`,...unique);
    let accepted=0;
    const tasks=subscriptions.map(async s=>{
      try{
        await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify(payload),{TTL:90,urgency:'high',timeout:5000});
        accepted++;
      }catch(e){
        // 404/410 indicam inscrição revogada/expirada. Outras falhas não interrompem pedidos.
        if([404,410].includes(e.statusCode))run('DELETE FROM push_subscriptions WHERE id=?',s.id);
        else console.warn('Push: envio não confirmado; status',Number(e.statusCode)||'indisponível');
      }
    });
    await Promise.allSettled(tasks);
    return accepted;
  }
  function eligibleRiders(order) {
    if(!order||order.status!=='pending'||order.rider_id!==null||!order.store_id)return [];
    // Reaproveita as condições da central compartilhada, inclusive restrições por loja.
    const store=one('SELECT id,active,restricted FROM stores WHERE id=?',order.store_id);
    if(!store||!store.active)return [];
    if(order.source==='ifood'){
      if(order.delivered_by==='IFOOD'||(production&&!ifood.enabled)||
         !['preparing','ready'].includes(order.delivery_stage))return [];
    }
    return all(`SELECT u.id FROM users u WHERE u.role='rider' AND u.active=1 AND
      (?=0 OR EXISTS (SELECT 1 FROM rider_store_access a WHERE a.store_id=? AND a.rider_id=u.id)) AND
      (?<>'ifood' OR ?=0 OR length(trim(coalesce(u.phone,'')))>0)`,store.restricted,store.id,order.source,ifood.enabled?1:0).map(x=>x.id);
  }
  function enqueue(orderId) {
    if(!configured)return;
    setImmediate(()=>{
      try{
        syncStores();
        const order=one('SELECT * FROM orders WHERE id=?',orderId);
        const userIds=eligibleRiders(order);
        if(userIds.length)pushToUsers(userIds,{type:'new_delivery',orderId:order.id,
          title:'Nova entrega disponível',body:'Toque para visualizar e aceitar na Rota Privada.',url:'/?view=board'})
          .catch(e=>console.warn('Push: falha no disparo:',e.message));
      }catch(e){console.warn('Push: falha ao verificar oferta:',e.message);}
    });
  }
  return {enabled:configured,handle,enqueue};
};
