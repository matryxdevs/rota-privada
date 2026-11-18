'use strict';
const crypto = require('node:crypto');

// Adaptador oficial iFood: OAuth, webhooks validados, eventos persistidos, polling opcional,
// consulta de detalhes e ações de Logistics. Nunca expor clientSecret no navegador.
module.exports = function createIfood({db, one, all, run, now, clean}) {
  const base = (process.env.IFOOD_API_BASE || 'https://merchant-api.ifood.com.br').replace(/\/$/, '');
  const clientId = process.env.IFOOD_CLIENT_ID || '';
  const secret = process.env.IFOOD_CLIENT_SECRET || '';
  const enabled = !!(clientId && secret);
  if (enabled && process.env.NODE_ENV==='production' && !(process.env.IFOOD_MERCHANT_IDS||'').trim()) {
    throw new Error('Configure IFOOD_MERCHANT_IDS em produção para permitir somente lojas autorizadas.');
  }
  const pollingEnabled = enabled && process.env.IFOOD_POLLING === 'true';
  const allowedMerchants = new Set((process.env.IFOOD_MERCHANT_IDS || '').split(',').map(s=>s.trim()).filter(Boolean));
  let token = null, expires = 0, draining = false, polling = false, lastPollAt = null, lastPollError = '';
  db.exec(`CREATE TABLE IF NOT EXISTS ifood_events (
    event_id TEXT PRIMARY KEY, order_id TEXT, merchant_id TEXT, payload TEXT NOT NULL,
    received_at TEXT NOT NULL, processed_at TEXT, attempts INTEGER DEFAULT 0,
    last_error TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS ifood_stores (
    merchant_id TEXT PRIMARY KEY, name TEXT NOT NULL, pickup TEXT DEFAULT '', added_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ifood_events_pending ON ifood_events(processed_at, received_at);`);
  const columns = all('PRAGMA table_info(orders)').map(c=>c.name);
  const alterations = {
    source: "TEXT NOT NULL DEFAULT 'manual'",
    external_order_id: 'TEXT', merchant_id: 'TEXT',
    delivery_stage: "TEXT DEFAULT 'new'", ifood_event: 'TEXT',
    ifood_event_at: 'TEXT', pending_action: 'TEXT',
    delivered_by: 'TEXT', requires_code: 'INTEGER DEFAULT 0'
  };
  for (const [name,definition] of Object.entries(alterations)) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ifood_order ON orders(external_order_id) WHERE external_order_id IS NOT NULL');

  const statusForStage = {
    new:'pending', preparing:'pending', ready:'pending', rider_assigned:'assigned',
    going_origin:'assigned', at_origin:'assigned', picked_up:'collected',
    on_route:'in_route', at_destination:'in_route', delivered:'delivered', cancelled:'cancelled'
  };
  const stageForEvent = {
    PLC:'new',PLACED:'new',CFM:'preparing',CONFIRMED:'preparing',RTP:'ready',READY_TO_PICKUP:'ready',
    ADR:'rider_assigned',ASSIGN_DRIVER:'rider_assigned', GTO:'going_origin',GOING_TO_ORIGIN:'going_origin',
    AAO:'at_origin',ARRIVED_AT_ORIGIN:'at_origin',CLT:'picked_up',COLLECTED:'picked_up',
    DSP:'on_route',DISPATCHED:'on_route',AAD:'at_destination',ARRIVED_AT_DESTINATION:'at_destination',
    CON:'delivered',CONCLUDED:'delivered',CAN:'cancelled',CANCELLED:'cancelled'
  };
  const stageRank = {new:0,preparing:1,ready:2,rider_assigned:3,going_origin:4,at_origin:5,picked_up:6,on_route:7,at_destination:8,delivered:9,cancelled:100};
  const actionMap = {goingToOrigin:'goingToOrigin',arrivedAtOrigin:'arrivedAtOrigin',dispatch:'dispatch',arrivedAtDestination:'arrivedAtDestination',verifyDeliveryCode:'verifyDeliveryCode',assignDriver:'assignDriver'};

  const safePathId = x => encodeURIComponent(String(x));
  function allowed(merchantId){return !allowedMerchants.size || allowedMerchants.has(merchantId);}
  async function accessToken(force=false) {
    if (!enabled) throw new Error('Credenciais iFood ainda não configuradas.');
    if (!force && token && Date.now()<expires-60_000) return token;
    const form=new URLSearchParams({grantType:'client_credentials',clientId,clientSecret:secret});
    const resp=await fetch(`${base}/authentication/v1.0/oauth/token`, {
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:form,
      signal:AbortSignal.timeout(12000)
    });
    const payload=await resp.json().catch(()=>({}));
    if (!resp.ok || !payload.accessToken) throw new Error(`Falha na autenticação iFood (HTTP ${resp.status}).`);
    token=payload.accessToken;expires=Date.now()+Number(payload.expiresIn||3600)*1000;return token;
  }
  async function call(endpoint, method='GET', data) {
    const exec=async(force=false)=>{
      const headers={Authorization:`Bearer ${await accessToken(force)}`,Accept:'application/json'};
      if (process.env.IFOOD_CUSTOMER_ID) headers['X-iFood-Customer-ID']=process.env.IFOOD_CUSTOMER_ID;
      if (data!==undefined) headers['Content-Type']='application/json';
      const resp=await fetch(base+endpoint,{method,headers,body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
      if (resp.status===401 && !force) return null;
      const raw=await resp.text();let parsed;try{parsed=raw?JSON.parse(raw):{};}catch{parsed={message:raw.slice(0,160)}}
      if (!resp.ok) throw new Error(`iFood respondeu HTTP ${resp.status}${parsed?.message?' — '+String(parsed.message).slice(0,180):''}`);
      return {status:resp.status,data:parsed};
    };
    const first=await exec();return first===null?exec(true):first;
  }
  function getStatus() {
    return {configured:enabled,polling:pollingEnabled,mode:pollingEnabled?'polling + webhook':'webhook',lastPollAt,lastPollError,
      storedEvents:one('SELECT COUNT(*) n FROM ifood_events').n,
      pendingEvents:one('SELECT COUNT(*) n FROM ifood_events WHERE processed_at IS NULL').n,
      merchants:all('SELECT * FROM ifood_stores ORDER BY name'),
      webhookUrl:'/webhooks/ifood', activeAuthorization:enabled?'Credenciais presentes (homologação não verificada)':'Credenciais ausentes'};
  }
  function verifySignature(raw, signature) {
    if (!secret || typeof signature!=='string' || !/^[a-f\d]{64}$/i.test(signature)) return false;
    const actual=Buffer.from(signature,'hex');const want=crypto.createHmac('sha256',secret).update(raw).digest();
    return actual.length===want.length && crypto.timingSafeEqual(actual,want);
  }
  function storeEvent(event) {
    if (!event || typeof event!=='object' || !event.id || !event.orderId || !event.merchantId) return false;
    if (!allowed(String(event.merchantId))) return false;
    const result=run(`INSERT OR IGNORE INTO ifood_events(event_id,order_id,merchant_id,payload,received_at) VALUES(?,?,?,?,?)`,
      clean(event.id,128),clean(event.orderId,128),clean(event.merchantId,128),JSON.stringify(event),now());
    return result.changes>0;
  }
  function formatAddress(addr) {
    if (!addr) return '';
    if (typeof addr==='string') return clean(addr,250);
    return clean(addr.formattedAddress || [addr.streetName,addr.streetNumber,addr.complement,addr.neighborhood,addr.city].filter(Boolean).join(', '),250);
  }
  function ingestEvent(event) {
    const external=clean(event.orderId,128), merchantId=clean(event.merchantId,128);
    const code=clean(event.fullCode||event.code,80).toUpperCase();
    const stage=stageForEvent[code] || stageForEvent[String(event.code||'').toUpperCase()];
    if (!allowed(merchantId)) return;
    if(!one('SELECT merchant_id FROM ifood_stores WHERE merchant_id=?',merchantId)) {
      run('INSERT INTO ifood_stores(merchant_id,name,added_at) VALUES(?,?,?)',merchantId,'Loja iFood '+merchantId.slice(0,8),now());
    }
    const store=one('SELECT * FROM ifood_stores WHERE merchant_id=?',merchantId);
    const exists=one('SELECT * FROM orders WHERE external_order_id=?',external);
    const happened=event.createdAt && !Number.isNaN(Date.parse(event.createdAt)) ? new Date(event.createdAt).toISOString() : now();
    if (!exists) {
      // Não supor endereços e clientes: ficam "Aguardando detalhes" até o GET oficial.
      const rawCode=clean(event.displayId||external.slice(0,8),50);
      const display='IF-'+rawCode;
      const unique=one('SELECT 1 FROM orders WHERE code=?',display) ? 'IF-'+external : display;
      const firstStatus=statusForStage[stage]||'pending';
      const timestamp=now();
      const id=run(`INSERT INTO orders(code,merchant,customer_name,pickup,dropoff,status,created_at,updated_at,source,external_order_id,merchant_id,delivery_stage,ifood_event,ifood_event_at,requires_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,unique,store.name,'Aguardando detalhes iFood',store.pickup||'Aguardando detalhes iFood',
        'Aguardando detalhes iFood',firstStatus,timestamp,timestamp,'ifood',external,merchantId,stage||'new',code,happened,
        code==='DELIVERY_DROP_CODE_REQUESTED'?1:0).lastInsertRowid;
      run('INSERT INTO events(order_id,event,at) VALUES(?,?,?)',Number(id),'Notificação iFood: '+code,now());
      return;
    }
    const existingAt=exists.ifood_event_at && Date.parse(exists.ifood_event_at) || 0;
    const stageValid = !stage || existingAt<=Date.parse(happened);
    const rankValid = !stage || stage==='cancelled' || (existingAt<=Date.parse(happened) && (stageRank[stage]??0)>=(stageRank[exists.delivery_stage]??0));
    const nextStage=rankValid?stage:exists.delivery_stage;
    const nextStatus=statusForStage[nextStage] || exists.status;
    const needCode=code==='DELIVERY_DROP_CODE_REQUESTED'?1:exists.requires_code;
    run(`UPDATE orders SET delivery_stage=?,status=?,ifood_event=?,ifood_event_at=?,requires_code=?,pending_action=?,
      updated_at=?,delivered_at=? WHERE id=?`,nextStage,nextStatus,stageValid?code:exists.ifood_event,
      stageValid?happened:exists.ifood_event_at,needCode,stageValid?null:exists.pending_action,now(),
      nextStatus==='delivered'?(exists.delivered_at||now()):exists.delivered_at,exists.id);
    run('INSERT INTO events(order_id,event,at) VALUES(?,?,?)',exists.id,'Notificação iFood: '+code,now());
  }
  async function refreshOrder(external) {
    if (!enabled) return;
    const order=one('SELECT * FROM orders WHERE external_order_id=?',external);
    if (!order) return;
    const result=await call(`/logistics/v1.0/orders/${safePathId(external)}`);
    const data=result?.data||{};
    const customer=clean(data.customer?.name||data.customer?.fullName||data.customer?.firstName||'',100);
    const phone=clean(data.customer?.phone?.number||data.customer?.phone||'',30);
    const merchant=clean(data.merchant?.name||data.merchant?.tradeName||'',100);
    const pickup=formatAddress(data.merchant?.address||data.merchant?.location||data.pickupAddress);
    const dropoff=formatAddress(data.delivery?.deliveryAddress||data.deliveryAddress);
    const neighborhood=clean(data.delivery?.deliveryAddress?.neighborhood||data.deliveryAddress?.neighborhood||'',100);
    const mode=clean(data.delivery?.deliveredBy||'',40).toUpperCase();
    if (merchant) run('UPDATE ifood_stores SET name=?,pickup=CASE WHEN ?<>\'\' THEN ? ELSE pickup END WHERE merchant_id=?',merchant,pickup,pickup,order.merchant_id);
    run(`UPDATE orders SET code=CASE WHEN ?<>'' AND NOT EXISTS(SELECT 1 FROM orders x WHERE x.code=? AND x.id<>orders.id) THEN ? ELSE code END,
       merchant=CASE WHEN ?<>'' THEN ? ELSE merchant END,customer_name=CASE WHEN ?<>'' THEN ? ELSE customer_name END,
       customer_phone=CASE WHEN ?<>'' THEN ? ELSE customer_phone END,
       pickup=CASE WHEN ?<>'' THEN ? ELSE pickup END,dropoff=CASE WHEN ?<>'' THEN ? ELSE dropoff END,
       neighborhood=CASE WHEN ?<>'' THEN ? ELSE neighborhood END,
       delivered_by=CASE WHEN ?<>'' THEN ? ELSE delivered_by END,updated_at=? WHERE id=?`,
      clean(data.displayId?'IF-'+data.displayId:'',80),clean(data.displayId?'IF-'+data.displayId:'',80),clean(data.displayId?'IF-'+data.displayId:'',80),
      merchant,merchant,customer,customer,phone,phone,pickup,pickup,dropoff,dropoff,neighborhood,neighborhood,mode,mode,now(),order.id);
  }
  async function drain() {
    if (draining) return;draining=true;
    try {
      const jobs=all('SELECT * FROM ifood_events WHERE processed_at IS NULL AND attempts<12 ORDER BY received_at LIMIT 50');
      for (const job of jobs) {
        try {
          const evt=JSON.parse(job.payload);
          ingestEvent(evt); // persistência idempotente do estado antes de marcar evento processado
          run('UPDATE ifood_events SET processed_at=?,attempts=attempts+1,last_error=\'\' WHERE event_id=?',now(),job.event_id);
          if (enabled) {
            try {await refreshOrder(job.order_id)} catch(error) {console.warn('iFood: detalhes indisponíveis para pedido',job.order_id, String(error.message).slice(0,160));}
          }
        } catch(err) {run('UPDATE ifood_events SET attempts=attempts+1,last_error=? WHERE event_id=?',clean(err.message,250),job.event_id);}
      }
    } finally {draining=false;}
  }
  async function action(order, action, extras={}) {
    if (!enabled) throw new Error('A integração oficial ainda não foi habilitada.');
    if (order.source!=='ifood'||!order.external_order_id) throw new Error('Pedido não é originado no iFood.');
    if (!actionMap[action]) throw new Error('Ação iFood não permitida.');
    if (order.delivered_by==='IFOOD') throw new Error('Pedido sob logística do iFood. Etapas são somente leitura.');
    const end=['delivered','cancelled'];if(end.includes(order.status))throw new Error('Pedido finalizado.');
    const payload=action==='assignDriver' ? extras : action==='verifyDeliveryCode' ? extras : undefined;
    const reserved=run('UPDATE orders SET pending_action=?,updated_at=? WHERE id=? AND pending_action IS NULL',action,now(),order.id);
    if(reserved.changes!==1)throw new Error('Há uma ação pendente de confirmação pelo iFood.');
    try {
      const response=await call(`/logistics/v1.0/orders/${safePathId(order.external_order_id)}/${action}`,'POST',payload);
      run('INSERT INTO events(order_id,event,at) VALUES(?,?,?)',order.id,'Ação enviada ao iFood: '+action,now());
      return {accepted:true,httpStatus:response.status, message:'Solicitação enviada ao iFood. A confirmação ocorrerá por notificação oficial.'};
    } catch(err) {
      run('UPDATE orders SET pending_action=NULL WHERE id=? AND pending_action=?',order.id,action);
      throw err;
    }
  }
  async function poll() {
    if(!enabled)throw new Error('Credenciais iFood ausentes.');
    if(polling)return {busy:true};polling=true;
    try {
      const result=await call('/events/v1.0/events:polling?excludeHeartbeat=true');
      const events=Array.isArray(result?.data)?result.data:(result?.data?.events||[]);
      const ids=[];
      for(const event of events){
        if(!event?.id)continue;
        // Persistir evento em SQLite antes de enviar ACK ao iFood.
        if(event.orderId&&event.merchantId) storeEvent(event);
        ids.push({id:event.id});
      }
      if(ids.length) await call('/events/v1.0/events/acknowledgment','POST',ids);
      lastPollAt=now();lastPollError='';setImmediate(()=>drain().catch(console.error));
      return {received:events.length,stored:ids.length};
    }catch(e){lastPollError=String(e.message).slice(0,250);throw e;}
    finally{polling=false;}
  }
  function demoEvent(orderId,code) {
    if (enabled || process.env.NODE_ENV==='production') throw new Error('Simulação indisponível em produção ou com integração ativa.');
    const order=one('SELECT * FROM orders WHERE id=? AND source=\'ifood\'',orderId);
    if(!order)throw new Error('Pedido de demonstração não encontrado.');
    const event={id:crypto.randomUUID(),code,fullCode:code,orderId:order.external_order_id,
      merchantId:order.merchant_id,createdAt:now()};
    storeEvent(event);return drain();
  }
  if(pollingEnabled) setInterval(()=>poll().catch(e=>console.error('iFood polling:',e.message)),30_000).unref();
  setInterval(()=>drain().catch(e=>console.error('iFood events:',e.message)),15_000).unref();
  setInterval(()=>{
    try{run('DELETE FROM ifood_events WHERE processed_at IS NOT NULL AND processed_at<?',new Date(Date.now()-90*86400000).toISOString());}
    catch(e){console.error('iFood event retention:',e.message);}
  },3600_000).unref();
  setImmediate(()=>drain().catch(console.error));
  return {enabled, getStatus,verifySignature,storeEvent,drain,action,call,poll,demoEvent,refreshOrder};
};
