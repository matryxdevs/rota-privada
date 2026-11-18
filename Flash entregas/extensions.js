'use strict';
// Módulo complementar V2. Migrações aditivas; não remove as tabelas históricas.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

module.exports=function createExtensions({db,one,all,run,now,clean,send,error,bodyJSON,audit,ifood,DATA_FILE}) {
  db.exec(`CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pickup TEXT NOT NULL DEFAULT '',
    merchant_id TEXT UNIQUE, base_fee_cents INTEGER NOT NULL DEFAULT 1000,
    per_km_cents INTEGER NOT NULL DEFAULT 200, rider_base_cents INTEGER NOT NULL DEFAULT 700,
    rider_per_km_cents INTEGER NOT NULL DEFAULT 120, restricted INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rider_store_access (
    rider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    PRIMARY KEY(rider_id,store_id)
  );
  CREATE TABLE IF NOT EXISTS rider_positions (
    rider_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lat REAL NOT NULL, lng REAL NOT NULL, accuracy_m REAL NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS delivery_proofs (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    code_hash TEXT, code_salt TEXT, code_attempts INTEGER NOT NULL DEFAULT 0,
    photo_file TEXT, photo_type TEXT,
    photo_submitted_at TEXT, verified_at TEXT, verified_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS operation_audit (
    id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    action TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_op_audit_at ON operation_audit(at);
  CREATE INDEX IF NOT EXISTS idx_store_orders ON orders(merchant);
  `);
  const columns=new Set(all('PRAGMA table_info(orders)').map(x=>x.name));
  const add={store_id:'INTEGER REFERENCES stores(id) ON DELETE SET NULL',distance_km:'REAL',
    manual_stage:"TEXT NOT NULL DEFAULT 'new'", proof_required:'INTEGER NOT NULL DEFAULT 0'};
  for(const [field,definition] of Object.entries(add))if(!columns.has(field))db.exec(`ALTER TABLE orders ADD COLUMN ${field} ${definition}`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);');
  const legacyStages={pending:'new',assigned:'rider_assigned',collected:'picked_up',in_route:'on_route',delivered:'delivered',cancelled:'cancelled'};
  for(const [status,stage] of Object.entries(legacyStages)) run(`UPDATE orders SET manual_stage=? WHERE source='manual' AND status=? AND manual_stage='new'`,stage,status);
  function track(actor,action,orderId=null,storeId=null){run('INSERT INTO operation_audit(actor_id,store_id,order_id,action,at) VALUES(?,?,?,?,?)',actor,storeId,orderId,action,now());}
  function syncStores() {
    const known=all('SELECT merchant_id,name,pickup FROM ifood_stores');
    for(const s of known){
      const exists=one('SELECT id FROM stores WHERE merchant_id=?',s.merchant_id);
      if(exists)continue;
      const conflict=one('SELECT id FROM stores WHERE name=? COLLATE NOCASE',s.name);
      if(conflict){run('UPDATE stores SET merchant_id=? WHERE id=? AND merchant_id IS NULL',s.merchant_id,conflict.id);continue;}
      run('INSERT OR IGNORE INTO stores(name,pickup,merchant_id,created_at) VALUES(?,?,?,?)',s.name,s.pickup||'',s.merchant_id,now());
    }
    // Preserva e associa os registros legados, sem apagar dados.
    const legacy=all("SELECT DISTINCT merchant,pickup FROM orders WHERE merchant<>'' AND store_id IS NULL AND (source IS NULL OR source='manual')");
    for(const m of legacy){
      run('INSERT OR IGNORE INTO stores(name,pickup,created_at) VALUES(?,?,?)',m.merchant,m.pickup||'',now());
    }
    run("UPDATE orders SET store_id=(SELECT s.id FROM stores s WHERE s.merchant_id=orders.merchant_id) WHERE source='ifood' AND store_id IS NULL AND merchant_id IS NOT NULL");
    run("UPDATE orders SET store_id=(SELECT s.id FROM stores s WHERE s.name=orders.merchant COLLATE NOCASE) WHERE (source='manual' OR source IS NULL) AND store_id IS NULL");
  }
  syncStores();
  const accessible=(user,storeId)=>{
    if(user.role==='admin')return true;
    if(!storeId)return false;
    return !!one(`SELECT 1 FROM stores s WHERE s.id=? AND s.active=1 AND (s.restricted=0 OR EXISTS(SELECT 1 FROM rider_store_access a WHERE a.store_id=s.id AND a.rider_id=?))`,storeId,user.id);
  };
  function canViewOrder(user,order){return user.role==='admin'||(user.role==='rider'&&order.rider_id===user.id);}
  function checkActive(user,order,res){
    if(!order||!canViewOrder(user,order)){error(res,404,'Entrega não encontrada.');return false;}
    if(['delivered','cancelled'].includes(order.status)){error(res,409,'Entrega já finalizada.');return false;}
    return true;
  }
  function addOrderStore(order){
    if(!order)return order;
    return {...order,fee:order.fee_cents/100,payout:order.payout_cents/100};
  }
  function quote(store,distance){
    if(!Number.isFinite(distance)||distance<0||distance>300)throw Object.assign(Error('Distância inválida (0 a 300 km).'),{statusCode:400});
    const km=Math.max(0,distance);
    const fee=store.base_fee_cents+Math.ceil(km*store.per_km_cents);
    const payout=store.rider_base_cents+Math.ceil(km*store.rider_per_km_cents);
    if(payout>fee)throw Object.assign(Error('Tabela de valores inválida: repasse excede taxa.'),{statusCode:422});
    return {fee:fee/100,payout:payout/100,distance_km:km};
  }
  function storeList(){syncStores();return all('SELECT * FROM stores ORDER BY active DESC,name ASC');}
  function requestStoreId(body){const n=Number(body.store_id);return Number.isSafeInteger(n)&&n>0?n:null;}
  function normalizeOrder(body) {
    const storeId=requestStoreId(body);
    if(!storeId)return {store_id:null,distance_km:null,fee:body.fee,payout:body.payout};
    const store=one('SELECT * FROM stores WHERE id=? AND active=1',storeId);
    if(!store)throw Object.assign(Error('Estabelecimento indisponível.'),{statusCode:400});
    const distance=body.distance_km===''||body.distance_km===undefined?null:Number(body.distance_km);
    let fee=body.fee,payout=body.payout;
    if(body.apply_distance_rate===true){if(distance===null)throw Object.assign(Error('Informe a distância estimada.'),{statusCode:400});const price=quote(store,distance);fee=price.fee;payout=price.payout;}
    if(distance!==null&&(!Number.isFinite(distance)||distance<0||distance>300))throw Object.assign(Error('Distância inválida.'),{statusCode:400});
    return {store_id:storeId,distance_km:distance,fee,payout,merchant:store.name,pickup:store.pickup};
  }
  async function handle(req,res,user,route,method) {
    const admin=()=>{if(user.role!=='admin'){error(res,403,'Acesso exclusivo do administrador.');return false;}return true;};
    if(route==='/api/stores'&&method==='GET'){
      const stores=storeList();
      return send(res,200,{stores:user.role==='admin'?stores:stores.filter(s=>accessible(user,s.id)).map(s=>({id:s.id,name:s.name,pickup:s.pickup}))}),true;
    }
    if(route==='/api/stores'&&method==='POST'){
      if(!admin())return true;
      const b=await bodyJSON(req),name=clean(b.name,100),pickup=clean(b.pickup,250);
      if(!name||!pickup)return error(res,400,'Nome e endereço da loja são obrigatórios.'),true;
      if(one('SELECT id FROM stores WHERE name=? COLLATE NOCASE',name))return error(res,409,'Estabelecimento já cadastrado.'),true;
      const id=run('INSERT INTO stores(name,pickup,created_at) VALUES(?,?,?)',name,pickup,now()).lastInsertRowid;
      track(user.id,'store_created',null,Number(id));return send(res,201,{id:Number(id),ok:true}),true;
    }
    let m=route.match(/^\/api\/stores\/(\d+)$/);
    if(m&&method==='PATCH'){
      if(!admin())return true;
      const id=Number(m[1]),s=one('SELECT * FROM stores WHERE id=?',id),b=await bodyJSON(req);
      if(!s)return error(res,404,'Estabelecimento não encontrado.'),true;
      const str=x=>String(x??'');const cents=x=>Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=1e5?Math.round(Number(x)*100):null;
      const name=clean(b.name??s.name,100),pickup=clean(b.pickup??s.pickup,250);
      const base=cents(b.base_fee??s.base_fee_cents/100),per=cents(b.per_km??s.per_km_cents/100);
      const riderBase=cents(b.rider_base??s.rider_base_cents/100),riderPer=cents(b.rider_per_km??s.rider_per_km_cents/100);
      if(!name||!pickup||[base,per,riderBase,riderPer].some(x=>x===null)||base<riderBase||per<riderPer)return error(res,400,'Informe tarifas válidas (taxa maior ou igual ao repasse).'),true;
      if(one('SELECT id FROM stores WHERE id<>? AND name=? COLLATE NOCASE',id,name))return error(res,409,'Nome de loja já cadastrado.'),true;
      run('UPDATE stores SET name=?,pickup=?,base_fee_cents=?,per_km_cents=?,rider_base_cents=?,rider_per_km_cents=?,restricted=?,active=? WHERE id=?',
        name,pickup,base,per,riderBase,riderPer,b.restricted===undefined?s.restricted:(b.restricted?1:0),b.active===undefined?s.active:(b.active?1:0),id);
      track(user.id,'store_updated',null,id);return send(res,200,{ok:true}),true;
    }
    m=route.match(/^\/api\/stores\/(\d+)\/access$/);
    if(m&&method==='PUT'){
      if(!admin())return true;
      const id=Number(m[1]),b=await bodyJSON(req);
      if(!one('SELECT 1 FROM stores WHERE id=?',id))return error(res,404,'Loja inexistente.'),true;
      if(!Array.isArray(b.rider_ids)||b.rider_ids.length>500)return error(res,400,'Lista inválida.'),true;
      const ids=[...new Set(b.rider_ids.map(Number))];
      if(ids.some(x=>!Number.isSafeInteger(x)||!one("SELECT 1 FROM users WHERE id=? AND role='rider'",x)))return error(res,400,'Entregador inválido.'),true;
      db.exec('BEGIN IMMEDIATE');try{run('DELETE FROM rider_store_access WHERE store_id=?',id);for(const rid of ids)run('INSERT INTO rider_store_access(rider_id,store_id) VALUES(?,?)',rid,id);run('UPDATE stores SET restricted=? WHERE id=?',b.restricted?1:0,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      track(user.id,'store_access_changed',null,id);return send(res,200,{ok:true}),true;
    }
    if(m&&method==='GET'){
      if(!admin())return true;
      const id=Number(m[1]);return send(res,200,{rider_ids:all('SELECT rider_id FROM rider_store_access WHERE store_id=?',id).map(x=>x.rider_id)}),true;
    }
    m=route.match(/^\/api\/stores\/(\d+)\/quote$/);
    if(m&&method==='POST'){
      if(!admin())return true;
      const store=one('SELECT * FROM stores WHERE id=?',Number(m[1]));if(!store)return error(res,404,'Loja não encontrada.'),true;
      const b=await bodyJSON(req);return send(res,200,quote(store,Number(b.distance_km))),true;
    }
    if(route==='/api/board'&&method==='GET'){
      syncStores();
      const query=`SELECT o.id,o.code,o.source,o.merchant,o.store_id,o.neighborhood,o.pickup,o.distance_km,o.payout_cents,o.created_at,o.delivery_stage,o.delivered_by,
        s.active,s.restricted FROM orders o JOIN stores s ON s.id=o.store_id
        WHERE o.status='pending' AND o.rider_id IS NULL AND s.active=1 AND (o.source<>'ifood' OR (o.delivered_by IS NULL OR o.delivered_by<>'IFOOD') AND o.delivery_stage IN ('preparing','ready','new')) ORDER BY o.created_at DESC LIMIT 120`;
      const rows=all(query).filter(x=>accessible(user,x.store_id)&&!(x.source==='ifood'&&ifood.enabled&&x.delivery_stage==='new')&&!(x.source==='ifood'&&!ifood.enabled&&process.env.NODE_ENV==='production')).map(x=>({id:x.id,code:x.code,source:x.source,merchant:x.merchant,store_id:x.store_id,neighborhood:x.neighborhood,pickup:x.pickup,
        distance_km:x.distance_km,payout:x.payout_cents/100,created_at:x.created_at}));
      return send(res,200,{orders:rows}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/accept$/);
    if(m&&method==='POST'){
      if(user.role!=='rider')return error(res,403,'Apenas entregadores podem aceitar.'),true;
      const id=Number(m[1]);syncStores();
      const order=one('SELECT * FROM orders WHERE id=?',id);
      if(!order||order.status!=='pending'||order.rider_id!==null||!accessible(user,order.store_id))return error(res,409,'Essa entrega já foi aceita ou está indisponível.'),true;
      if(order.source==='ifood'&&order.delivered_by==='IFOOD')return error(res,409,'Pedido operado pela frota do iFood.'),true;
      if(order.source==='ifood'&&!ifood.enabled&&process.env.NODE_ENV==='production')return error(res,409,'Integração iFood não configurada.'),true;
      if(order.source==='ifood'&&ifood.enabled&&order.delivery_stage==='new')return error(res,409,'Aguardando confirmação do pedido pela loja no iFood.'),true;
      if(order.source==='ifood'&&ifood.enabled&&!user.phone)return error(res,400,'Cadastre seu telefone para aceitar pedidos iFood.'),true;
      const result=run("UPDATE orders SET rider_id=?,status='assigned',manual_stage=CASE WHEN source='manual' THEN 'rider_assigned' ELSE manual_stage END,updated_at=? WHERE id=? AND rider_id IS NULL AND status='pending'",user.id,now(),id);
      if(result.changes!==1)return error(res,409,'Outro entregador aceitou primeiro.'),true;
      track(user.id,'order_accepted',id,order.store_id);
      run('INSERT INTO events(order_id,user_id,event,at) VALUES(?,?,?,?)',id,user.id,'Entrega aceita por entregador',now());
      if(order.source==='ifood'&&ifood.enabled){
        try{const result=await ifood.action({...order,rider_id:user.id},'assignDriver',{workerName:user.name,workerPhone:String(user.phone).replace(/\D/g,''),workerVehicleType:'MOTORCYCLE'});
          return send(res,202,{ok:true,id,awaiting_ifood:true,message:result.message}),true;
        }catch(e){
          run("UPDATE orders SET rider_id=NULL,status='pending',updated_at=? WHERE id=? AND rider_id=? AND status='assigned'",now(),id,user.id);
          track(user.id,'ifood_assignment_failed',id,order.store_id);
          return error(res,502,'Não foi possível atribuir oficialmente no iFood. Entrega liberada novamente.'),true;
        }
      }
      if(order.source==='ifood'&&!ifood.enabled){
        // Apenas no modo local: gerar notificação fictícia para exercitar a jornada.
        try{await ifood.demoEvent(id,'ASSIGN_DRIVER');}catch{}
      }
      return send(res,200,{ok:true,id}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/journey$/);
    if(m&&method==='PATCH'){
      const id=Number(m[1]),b=await bodyJSON(req);
      const o=one('SELECT * FROM orders WHERE id=?',id);
      if(!checkActive(user,o,res))return true;
      if(o.source==='ifood')return error(res,409,'Pedidos iFood exigem confirmação pela API oficial.'),true;
      const current=o.manual_stage==='new'&&o.status==='assigned'?'rider_assigned':o.manual_stage;
      const map={rider_assigned:['going_origin','assigned'],going_origin:['at_origin','assigned'],at_origin:['picked_up','collected'],picked_up:['on_route','in_route'],on_route:['at_destination','in_route'],at_destination:['delivered','delivered']};
      const transition=map[current];if(!transition||b.stage!==transition[0])return error(res,409,'Etapa fora da sequência.'),true;
      if(b.stage==='delivered'&&o.proof_required && !one('SELECT 1 FROM delivery_proofs WHERE order_id=? AND (photo_file IS NOT NULL OR verified_at IS NOT NULL)',id))return error(res,409,'Antes de concluir, registre foto ou valide o código de entrega.'),true;
      run('UPDATE orders SET manual_stage=?,status=?,updated_at=?,delivered_at=? WHERE id=?',transition[0],transition[1],now(),transition[1]==='delivered'?now():null,id);
      track(user.id,'journey_'+b.stage,id,o.store_id);run('INSERT INTO events(order_id,user_id,event,at) VALUES(?,?,?,?)',id,user.id,'Jornada: '+b.stage,now());
      return send(res,200,{ok:true}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/proof\/code$/);
    if(m&&method==='POST'){
      if(!admin())return true;
      const id=Number(m[1]),o=one('SELECT * FROM orders WHERE id=?',id);
      if(!o||o.source==='ifood'||['cancelled','delivered'].includes(o.status))return error(res,409,'Código disponível apenas para entregas próprias em andamento.'),true;
      const code=String(crypto.randomInt(10000000,100000000));const salt=crypto.randomBytes(16).toString('hex');
      const hash=crypto.scryptSync(code,salt,64).toString('hex');
      run(`INSERT INTO delivery_proofs(order_id,code_hash,code_salt,code_attempts,verified_at,verified_by) VALUES(?,?,?,?,NULL,NULL)
        ON CONFLICT(order_id) DO UPDATE SET code_hash=excluded.code_hash,code_salt=excluded.code_salt,code_attempts=0,verified_at=NULL,verified_by=NULL`,id,hash,salt,0);
      run('UPDATE orders SET proof_required=1 WHERE id=?',id);track(user.id,'proof_code_generated',id,o.store_id);
      return send(res,200,{code,message:'Exiba este código uma única vez ao cliente por canal seguro; ele não ficará disponível novamente.'}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/proof\/verify$/);
    if(m&&method==='POST'){
      const id=Number(m[1]),o=one('SELECT * FROM orders WHERE id=?',id);if(!checkActive(user,o,res))return true;
      if(o.source==='ifood')return error(res,409,'Para iFood, use somente a validação oficial.'),true;
      const proof=one('SELECT * FROM delivery_proofs WHERE order_id=?',id);if(!proof?.code_hash||proof.code_attempts>=5)return error(res,429,'Código indisponível ou limite de tentativas atingido.'),true;
      const b=await bodyJSON(req),value=clean(b.code,15);
      const hashed=/^\d{8}$/.test(value)?crypto.scryptSync(value,proof.code_salt,64):Buffer.alloc(64);
      const ok=crypto.timingSafeEqual(hashed,Buffer.from(proof.code_hash,'hex'));
      run('UPDATE delivery_proofs SET code_attempts=code_attempts+1 WHERE order_id=?',id);
      if(!ok){track(user.id,'proof_code_failed',id,o.store_id);return error(res,403,'Código inválido.'),true;}
      run('UPDATE delivery_proofs SET verified_at=?,verified_by=? WHERE order_id=?',now(),user.id,id);track(user.id,'proof_code_verified',id,o.store_id);
      return send(res,200,{ok:true}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/proof\/photo$/);
    if(m&&method==='POST'){
      const id=Number(m[1]),o=one('SELECT * FROM orders WHERE id=?',id);if(!checkActive(user,o,res))return true;
      // A comprovação local não substitui a confirmação oficial de conclusão no iFood.
      const b=await bodyJSON(req,1650000);
      const match=String(b.image||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if(!match)return error(res,415,'Aceitamos somente imagens JPEG, PNG ou WebP.'),true;
      const type=match[1],data=Buffer.from(match[2],'base64');
      if(data.length<100||data.length>950000)return error(res,413,'A imagem deve ter até 950 KB.'),true;
      const magic=type==='png'?data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):type==='jpeg'?data.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
      if(!magic)return error(res,415,'Assinatura da imagem inválida.'),true;
      const dir=path.join(path.dirname(DATA_FILE),'proofs');fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const filename=crypto.randomBytes(24).toString('hex')+'.'+(type==='jpeg'?'jpg':type),full=path.join(dir,filename);
      fs.writeFileSync(full,data,{flag:'wx',mode:0o600});
      const previous=one('SELECT photo_file FROM delivery_proofs WHERE order_id=?',id);
      try{
        run(`INSERT INTO delivery_proofs(order_id,photo_file,photo_type,photo_submitted_at) VALUES(?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET photo_file=excluded.photo_file,photo_type=excluded.photo_type,photo_submitted_at=excluded.photo_submitted_at`,id,filename,type,now());
      }catch(e){fs.unlinkSync(full);throw e;}
      if(previous?.photo_file&&previous.photo_file!==filename)try{fs.unlinkSync(path.join(dir,previous.photo_file));}catch{}
      run('UPDATE orders SET proof_required=1 WHERE id=?',id);track(user.id,'proof_photo_submitted',id,o.store_id);
      return send(res,201,{ok:true}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/proof$/);
    if(m&&method==='GET'){
      const id=Number(m[1]),o=one('SELECT * FROM orders WHERE id=?',id);
      if(!o||!canViewOrder(user,o))return error(res,404,'Entrega não encontrada.'),true;
      const proof=one('SELECT photo_file,photo_type,photo_submitted_at,verified_at FROM delivery_proofs WHERE order_id=?',id);
      return send(res,200,{has_photo:!!proof?.photo_file,photo_at:proof?.photo_submitted_at||null,code_verified:!!proof?.verified_at,photo_url:proof?.photo_file?`/api/orders/${id}/proof/image`:null}),true;
    }
    m=route.match(/^\/api\/orders\/(\d+)\/proof\/image$/);
    if(m&&method==='GET'){
      const id=Number(m[1]),o=one('SELECT * FROM orders WHERE id=?',id);
      if(!o||!canViewOrder(user,o))return error(res,404,'Entrega não encontrada.'),true;
      const proof=one('SELECT photo_file,photo_type FROM delivery_proofs WHERE order_id=?',id);
      if(!proof?.photo_file)return error(res,404,'Foto indisponível.'),true;
      const loc=path.join(path.dirname(DATA_FILE),'proofs',proof.photo_file);
      if(!/^[a-f0-9]{48}\.(png|webp|jpg)$/.test(proof.photo_file)||!fs.existsSync(loc))return error(res,404,'Foto não encontrada.'),true;
      res.writeHead(200,{'Content-Type':'image/'+(proof.photo_type==='jpeg'?'jpeg':proof.photo_type),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'});
      fs.createReadStream(loc).pipe(res);return true;
    }
    if(route==='/api/gps'&&method==='POST'){
      if(user.role!=='rider')return error(res,403,'Apenas entregadores podem compartilhar localização.'),true;
      const b=await bodyJSON(req),lat=Number(b.lat),lng=Number(b.lng),accuracy=Number(b.accuracy_m);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(accuracy)||Math.abs(lat)>90||Math.abs(lng)>180||accuracy<0||accuracy>10000)return error(res,400,'Localização inválida.'),true;
      run(`INSERT INTO rider_positions(rider_id,lat,lng,accuracy_m,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(rider_id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,accuracy_m=excluded.accuracy_m,updated_at=excluded.updated_at`,user.id,lat,lng,accuracy,now());
      return send(res,200,{ok:true}),true;
    }
    if(route==='/api/gps'&&method==='DELETE'){
      if(user.role!=='rider')return error(res,403,'Apenas entregadores podem interromper a localização.'),true;
      run('DELETE FROM rider_positions WHERE rider_id=?',user.id);track(user.id,'gps_stopped');return send(res,200,{ok:true}),true;
    }
    if(route==='/api/gps'&&method==='GET'){
      if(!admin())return true;
      return send(res,200,{positions:all(`SELECT p.rider_id,u.name,p.lat,p.lng,p.accuracy_m,p.updated_at FROM rider_positions p JOIN users u ON u.id=p.rider_id WHERE p.updated_at>=? ORDER BY p.updated_at DESC`,new Date(Date.now()-15*60*1000).toISOString())}),true;
    }
    if(route==='/api/operations/audit'&&method==='GET'){
      if(!admin())return true;
      return send(res,200,{events:all(`SELECT a.id,a.action,a.at,u.name actor,o.code order_code,s.name store_name FROM operation_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN orders o ON o.id=a.order_id LEFT JOIN stores s ON s.id=a.store_id ORDER BY a.id DESC LIMIT 100`),
        security:all('SELECT event,username,at FROM security_audit ORDER BY id DESC LIMIT 50')}),true;
    }
    if(route==='/api/rider/history'&&method==='GET'){
      if(user.role!=='rider')return error(res,403,'Área do entregador.'),true;
      const orders=all(`SELECT id,code,merchant,status,source,payout_cents,created_at,delivered_at FROM orders WHERE rider_id=? ORDER BY created_at DESC LIMIT 500`,user.id);
      return send(res,200,{orders:orders.map(o=>({...o,payout:o.payout_cents/100, payout_cents:undefined})),total_earned:orders.filter(o=>o.status==='delivered').reduce((s,o)=>s+o.payout_cents,0)/100}),true;
    }
    return false;
  }
  setInterval(()=>{try{run('DELETE FROM rider_positions WHERE updated_at<?',new Date(Date.now()-24*3600*1000).toISOString());run('DELETE FROM operation_audit WHERE at<?',new Date(Date.now()-180*86400*1000).toISOString());}catch(e){console.warn('Retenção V2:',e.message);}},3600000).unref();
  return {handle,syncStores,normalizeOrder,track,quote};
};
