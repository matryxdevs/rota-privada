'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const adminTotpSecret = String(process.env.ADMIN_TOTP_SECRET || '').trim().replace(/\s/g,'').toUpperCase();
if (production && !/^[A-Z2-7]{32,64}$/.test(adminTotpSecret)) {
  throw new Error('Em produção, configure ADMIN_TOTP_SECRET (Base32, 32 a 64 caracteres) para autenticação em duas etapas.');
}
if (adminTotpSecret && !/^[A-Z2-7]{32,64}$/.test(adminTotpSecret))throw Error('ADMIN_TOTP_SECRET deve ter 32 a 64 caracteres Base32.');
function fromBase32(value) {
  let bits=0,buf=0;const bytes=[];
  for(const ch of value){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);if(n<0)throw Error('Base32 inválida');buf=(buf<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((buf>>>bits)&255);}}
  return Buffer.from(bytes);
}
function totpCounter(code) {
  if (!adminTotpSecret || !/^\d{6}$/.test(String(code||'')))return null;
  const secret=fromBase32(adminTotpSecret),current=Math.floor(Date.now()/30000);
  for(const step of [current,current-1,current+1]){
    const data=Buffer.alloc(8);data.writeBigUInt64BE(BigInt(step));
    const digest=crypto.createHmac('sha1',secret).update(data).digest();
    const at=digest[digest.length-1]&15;
    const n=(digest.readUInt32BE(at)&0x7fffffff)%1000000;
    const expected=Buffer.from(String(n).padStart(6,'0'));
    const actual=Buffer.from(code);
    if(actual.length===expected.length && crypto.timingSafeEqual(actual,expected))return step;
  }
  return null;
}

if (production && (!publicOrigin || !/^https:\/\/[^/]+$/.test(publicOrigin))) {
  throw new Error('Em produção, PUBLIC_ORIGIN deve ser uma origem HTTPS, ex.: https://entregas.seudominio.com.br');
}
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(self), payment=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  ...(production ? {'Strict-Transport-Security':'max-age=31536000'} : {})
};
// Não confiar em X-Forwarded-For sem configurar e validar explicitamente um proxy confiável.
const rateBuckets = new Map();
function rateLimit(req, res, key, max=180, windowMs=60000) {
  const nowMs=Date.now(), old=rateBuckets.get(key);
  const record=old && old.expires>nowMs ? old : {count:0, expires:nowMs+windowMs};
  record.count++;
  rateBuckets.set(key,record);
  if(rateBuckets.size>50000)for(const [k,v] of rateBuckets){if(v.expires<nowMs)rateBuckets.delete(k);}
  if(record.count>max){error(res,429,'Limite de solicitações excedido.');return false;}
  return true;
}
function safeMutation(req,res){
  if(!['POST','PATCH','PUT','DELETE'].includes(req.method))return true;
  // Cabeçalho não-simple impede envio via formulário/cross-site sem preflight CORS autorizado.
  if(req.headers['x-requested-with']!=='XMLHttpRequest'){error(res,403,'Solicitação não autorizada.');return false;}
  if(req.headers['sec-fetch-site'] && req.headers['sec-fetch-site']!=='same-origin'){
    error(res,403,'Origem não autorizada.');return false;
  }
  const origin=req.headers.origin;
  if(origin){
    try{
      const expected=production?publicOrigin:`http://${req.headers.host}`;
      if(new URL(origin).origin!==new URL(expected).origin){error(res,403,'Origem não autorizada.');return false;}
    }catch{error(res,403,'Origem inválida.');return false;}
  }
  return true;
}

// Deploys na Hostinger recriam a pasta de build. O banco de produção deve ficar fora dela.
// Um caminho externo persistente precisa ser preparado e validado na hospedagem.
if (production) {
  const configuredPath = process.env.DB_PATH;
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw new Error('Em produção, configure DB_PATH como caminho absoluto em armazenamento persistente fora da pasta da aplicação.');
  }
  const appRoot = path.resolve(__dirname);
  const dbResolved = path.resolve(configuredPath);
  if (dbResolved === appRoot || dbResolved.startsWith(appRoot + path.sep)) {
    throw new Error('DB_PATH deve apontar para fora da pasta da aplicação para evitar perda de dados em deploys.');
  }
}
const DATA_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'rota-privada.sqlite');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
const db = new DatabaseSync(DATA_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '', role TEXT NOT NULL CHECK(role IN ('admin','rider')),
  password_hash TEXT NOT NULL, active INTEGER DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, merchant TEXT NOT NULL,
  customer_name TEXT NOT NULL, customer_phone TEXT DEFAULT '',
  pickup TEXT NOT NULL, dropoff TEXT NOT NULL, neighborhood TEXT DEFAULT '',
  fee_cents INTEGER NOT NULL DEFAULT 0, payout_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Pix', notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','assigned','collected','in_route','delivered','cancelled')),
  rider_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS security_audit (
  id INTEGER PRIMARY KEY, event TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_audit_at ON security_audit(at);
CREATE TABLE IF NOT EXISTS admin_totp_usage (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, last_counter INTEGER NOT NULL
);`);

const now = () => new Date().toISOString();
function audit(req,event,username='') {
  const ipHash=crypto.createHash('sha256').update(String(req.socket.remoteAddress||'unknown')).digest('hex').slice(0,24);
  db.prepare('INSERT INTO security_audit(event,username,ip_hash,at) VALUES (?,?,?,?)').run(event,String(username).slice(0,80),ipHash,now());
}

const hashPassword = (value) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`; };
const unknownUserHash = hashPassword(crypto.randomBytes(32).toString('hex'));
const checkPassword = (value, stored) => {
  if (typeof value !== 'string' || !stored?.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(value, salt, 64); const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && crypto.timingSafeEqual(actual, want);
};
const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const money = (value) => { const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) : null; };
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
function seed() {
  if (one('SELECT COUNT(*) n FROM users').n) return;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin@123456';
  if (production && (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD || adminPass.length < 12)) {
    throw new Error('Em produção, configure ADMIN_USER e ADMIN_PASSWORD (mínimo 12 caracteres).');
  }
  run('INSERT INTO users (name, username, phone, role, password_hash, created_at) VALUES (?,?,?,?,?,?)',
    'Administrador', adminUser, '', 'admin', hashPassword(adminPass), now());
  if (production) return;
  const riders = [
    ['Lucas Ferreira','lucas','(94) 99911-1010'],
    ['Mariana Costa','mariana','(94) 99922-2020'],
    ['Rafael Lima','rafael','(94) 99933-3030']
  ];
  for (const [name, username, phone] of riders) {
    run('INSERT INTO users (name, username, phone, role, password_hash, created_at) VALUES (?,?,?,?,?,?)',
      name, username, phone, 'rider', hashPassword('Entregador@123'), now());
  }
  const samples = [
    ['Bistrô Central','Ana Martins','Rua das Palmeiras, 92','Rua F, 110','Cidade Nova',16,10,'delivered',2,-4],
    ['Pizzaria 24h','Pedro Souza','Av. Liberdade, 640','Rua 15, 201','União',19,13,'in_route',3,0],
    ['Farmácia Vida','Juliana Alves','Av. Principal, 400','Rua H, 88','Da Paz',12,8,'assigned',4,0],
    ['Mercado Popular','Carlos Melo','Rua Rio Branco, 19','Av. E, 130','Rio Verde',14,9,'pending',null,0],
    ['Açaí do Norte','Bianca Silva','Rua São João, 230','Rua N, 24','Cidade Jardim',15,10,'collected',2,0],
    ['Restaurante Sabor','Mateus Oliveira','Av. Liberdade, 90','Rua M, 54','Liberdade',18,12,'delivered',3,-1],
    ['Empório Mais','Renata Costa','Av. G, 200','Rua 4, 340','Da Paz',11,7,'delivered',4,-2],
    ['Bistrô Central','Marcos Silva','Rua das Palmeiras, 92','Rua J, 15','União',17,11,'delivered',2,-3],
    ['Farmácia Vida','Carla Rocha','Av. Principal, 400','Rua A, 98','Rio Verde',13,9,'cancelled',null,-1],
    ['Pizzaria 24h','André Ribeiro','Av. Liberdade, 640','Rua 7, 25','Cidade Nova',20,14,'delivered',3,-5]
  ];
  for (let i = 0; i < samples.length; i++) {
    const [merchant, customer, pickup, dropoff, neighborhood, fee, payout, status, rider, days] = samples[i];
    const at = new Date(Date.now() + days*86400000 - i*1200000).toISOString();
    run(`INSERT INTO orders (code,merchant,customer_name,pickup,dropoff,neighborhood,fee_cents,payout_cents,status,rider_id,created_at,updated_at,delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RP-${String(i+1001).padStart(5,'0')}`,merchant,customer,pickup,dropoff,neighborhood,fee*100,payout*100,status,rider,at,at,status==='delivered'?at:null);
  }
}
seed();
let notifications;
const ifood = require('./ifood')({db,one,all,run,now,clean,onAvailableOrder:id=>notifications?.enqueue(id)});
const extensions = require('./extensions')({db,one,all,run,now,clean,send,error,bodyJSON,audit,ifood,DATA_FILE});
notifications = require('./notifications')({db,one,all,run,now,send,error,bodyJSON,production,ifood,syncStores:extensions.syncStores});
const staticTypes = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function send(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra }); res.end(body);
}
function error(res, status, message) { return send(res, status, { error: message }); }
function cookies(req) {
  const out={};
  for(const part of (req.headers.cookie||'').split(';')) {
    const idx=part.indexOf('=');if(idx<1)continue;
    const key=part.slice(0,idx).trim(),val=part.slice(idx+1).trim();
    if(key==='sid')out.sid=val;
  }
  return out;
}
function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  return one(`SELECT u.id,u.name,u.username,u.phone,u.role,u.active FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, crypto.createHash('sha256').update(sid).digest('hex'), now()) || null;
}
function bodyJSON(req, maxBytes=32*1024) { return new Promise((resolve, reject) => {
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')){
    reject(Object.assign(new Error('Envie JSON válido.'),{statusCode:415}));return;
  }
  const chunks=[];let length=0,finished=false;
  req.on('data', chunk => {
    length+=chunk.length;
    if(length>maxBytes && !finished){finished=true;reject(Object.assign(new Error('Solicitação muito grande.'),{statusCode:413}));req.resume();}
    else if(!finished)chunks.push(chunk);
  });
  req.on('end', () => {if(finished)return;try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();resolve(value);} catch {reject(Object.assign(new Error('JSON inválido.'),{statusCode:400}));}});
  req.on('error', reject);
}); }
function safeViewOrder(order) { return { ...order, fee: order.fee_cents / 100, payout: order.payout_cents / 100 }; }
const listOrders = (where, params) => all(`SELECT o.*,u.name rider_name FROM orders o LEFT JOIN users u ON u.id=o.rider_id ${where} ORDER BY o.created_at DESC`, ...params).map(safeViewOrder);
function emit(orderId, userId, event) { run('INSERT INTO events (order_id,user_id,event,at) VALUES (?,?,?,?)',orderId,userId,event,now()); }
let nextOrder = () => { const q = one('SELECT COALESCE(MAX(id),0) AS id FROM orders'); return `RP-${String(q.id+1001).padStart(5,'0')}`; };
const failCount = new Map();
const methods = ['GET','POST','PATCH','PUT','DELETE'];
const statuses = ['pending','assigned','collected','in_route','delivered','cancelled'];
function requireAdmin(user,res) { if (user.role !== 'admin') {error(res,403,'Acesso restrito à administração.'); return false;} return true; }
function validOrder(body, res) {
  const fields = {merchant:clean(body.merchant,100), customer_name:clean(body.customer_name,100), customer_phone:clean(body.customer_phone,30), pickup:clean(body.pickup,250), dropoff:clean(body.dropoff,250), neighborhood:clean(body.neighborhood,100), payment_method:clean(body.payment_method || 'Pix',30), notes:clean(body.notes,500)};
  const fee_cents = money(body.fee); const payout_cents = money(body.payout);
  if (!fields.merchant || !fields.customer_name || !fields.pickup || !fields.dropoff || fee_cents===null || payout_cents===null) {
    error(res,400,'Preencha estabelecimento, cliente, coleta, destino e valores válidos.'); return null;
  }
  if (payout_cents > fee_cents) { error(res,400,'O repasse ao entregador não pode superar a taxa de entrega.'); return null; }
  const rider_id = body.rider_id ? Number(body.rider_id) : null;
  if (rider_id && !one("SELECT id FROM users WHERE id=? AND role='rider' AND active=1",rider_id)) { error(res,400,'Entregador inválido ou inativo.');return null; }
  return {...fields,fee_cents,payout_cents,rider_id};
}
function validateDates(from,to) { return (!from || /^\d{4}-\d{2}-\d{2}$/.test(from)) && (!to || /^\d{4}-\d{2}-\d{2}$/.test(to)); }
const escCSV = val => { let v = String(val ?? ''); if (/^[\s\x00-\x1f]*[=+@-]/.test(v)) v = "'"+v; return '"' + v.replace(/"/g,'""') + '"'; };
const sessionSeconds = 12*3600;
const loginCookie = (sid) => `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${production?'; Secure':''}`;
const clearCookie = () => `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production?'; Secure':''}`;
async function api(req,res,url) {
  const route = url.pathname; const method = req.method;
  if (!methods.includes(method)) return error(res,405,'Método não permitido.');
  if(!safeMutation(req,res))return;
  if (route === '/api/login' && method==='POST') {
    const payload = await bodyJSON(req);
    const username = clean(payload.username,80).toLowerCase(); const ip = req.socket.remoteAddress || 'unknown'; const key = `${ip}:${username}`;
    if(!rateLimit(req,res,`login-ip:${ip}`,35,15*60000))return;
    let bad = failCount.get(key) || {count:0,until:0};
    if (bad.count >= 6 && bad.until > Date.now()) {audit(req,'login_blocked',username);return error(res,429,'Muitas tentativas. Tente novamente em 15 minutos.');}
    const user = one('SELECT * FROM users WHERE lower(username)=? AND active=1',username);
    const passwordMatches = checkPassword(payload.password,user?.password_hash||unknownUserHash);
    const correctPassword = !!user && passwordMatches;
    let step = null;
    if(correctPassword && user.role==='admin' && adminTotpSecret){
      step=totpCounter(payload.otp);
      const used=one('SELECT last_counter FROM admin_totp_usage WHERE user_id=?',user.id);
      if (step===null || (used && step<=used.last_counter))step=null;
    }
    if (!correctPassword || (user?.role==='admin' && adminTotpSecret && step===null)) {
      failCount.set(key,{count:bad.count+1,until:Date.now()+15*60000});
      audit(req,'login_failure',username);
      return error(res,401,'Usuário ou senha incorretos.');
    }
    if (user.role==='admin' && adminTotpSecret){
      run('INSERT INTO admin_totp_usage(user_id,last_counter) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_counter=excluded.last_counter',user.id,step);
    }
    failCount.delete(key);audit(req,'login_success',username);
    const sid=crypto.randomBytes(32).toString('hex');
    run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',crypto.createHash('sha256').update(sid).digest('hex'),user.id,new Date(Date.now()+sessionSeconds*1000).toISOString());
    return send(res,200,{user:{id:user.id,name:user.name,username:user.username,role:user.role}}, {'Set-Cookie':loginCookie(sid)});
  }
  const user=currentUser(req);
  if (!user) return error(res,401,'Faça login para continuar.');
  if (route==='/api/logout' && method==='POST') {
    const sid = cookies(req).sid;
    if (sid) run('DELETE FROM sessions WHERE token_hash=?',crypto.createHash('sha256').update(sid).digest('hex'));
    audit(req,'logout',user.username);
    return send(res,200,{ok:true},{'Set-Cookie':clearCookie()});
  }
  if (route==='/api/me' && method==='GET') return send(res,200,{user});
  if(await notifications.handle(req,res,user,route,method))return;
  if(await extensions.handle(req,res,user,route,method))return;
  if (route==='/api/change-password' && method==='POST') {
    const b=await bodyJSON(req);
    const record=one('SELECT password_hash FROM users WHERE id=?',user.id);
    if (!checkPassword(b.current_password,record.password_hash)) return error(res,403,'Senha atual incorreta.');
    if (typeof b.new_password!=='string' || b.new_password.length<12 || b.new_password.length>128) return error(res,400,'A nova senha deve conter de 12 a 128 caracteres.');
    if (b.current_password===b.new_password) return error(res,400,'Defina uma senha diferente da anterior.');
    run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(b.new_password),user.id);
    run('DELETE FROM sessions WHERE user_id=?',user.id);audit(req,'password_changed',user.username);
    return send(res,200,{ok:true},{'Set-Cookie':clearCookie()});
  }
  if (route==='/api/ifood/status' && method==='GET') {
    if (!requireAdmin(user,res))return;
    return send(res,200,ifood.getStatus());
  }
  if (route==='/api/ifood/poll' && method==='POST') {
    if(!requireAdmin(user,res))return;
    if(!ifood.enabled)return error(res,409,'Configure credenciais oficiais para sincronizar pedidos.');
    try{return send(res,200,await ifood.poll());}catch(e){console.warn('iFood polling:',String(e.message).slice(0,180));return error(res,502,'Não foi possível sincronizar com o iFood.');}
  }
  if (route==='/api/ifood/stores' && method==='POST') {
    if(!requireAdmin(user,res))return;
    const b=await bodyJSON(req);const id=clean(b.merchant_id,128);const name=clean(b.name,100);const pickup=clean(b.pickup,250);
    if(!/^[a-zA-Z0-9_-]{8,128}$/.test(id)||!name)return error(res,400,'Informe ID da loja do iFood e nome.');
    run(`INSERT INTO ifood_stores(merchant_id,name,pickup,added_at) VALUES(?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET name=excluded.name,pickup=excluded.pickup`,id,name,pickup,now());
    run('UPDATE orders SET merchant=?,pickup=CASE WHEN ?<>\'\' THEN ? ELSE pickup END WHERE merchant_id=? AND source=\'ifood\'',name,pickup,pickup,id);
    return send(res,201,{ok:true});
  }
  if (route==='/api/ifood/demo-order' && method==='POST') {
    if(!requireAdmin(user,res))return;
    if(ifood.enabled || production)return error(res,403,'O simulador funciona apenas no ambiente local sem integração ativa.');
    const b=await bodyJSON(req);const id=crypto.randomUUID(),merchantId=clean(b.merchant_id,128)||'demo-merchant-001';
    const store=one('SELECT * FROM ifood_stores WHERE merchant_id=?',merchantId);
    if(!store)run('INSERT INTO ifood_stores(merchant_id,name,pickup,added_at) VALUES(?,?,?,?)',merchantId,clean(b.merchant,100)||'Loja demonstração iFood','Av. Liberdade, 100',now());
    const event={id:crypto.randomUUID(),orderId:id,merchantId,code:'PLC',fullCode:'PLACED',createdAt:now(),displayId:String(Math.floor(Math.random()*90000+10000))};
    ifood.storeEvent(event);await ifood.drain();
    const order=one('SELECT id FROM orders WHERE external_order_id=?',id);
    run(`UPDATE orders SET customer_name=?,customer_phone=?,dropoff=?,pickup=?,fee_cents=?,payout_cents=?,delivered_by='MERCHANT' WHERE id=?`,
      'Cliente demonstração','',clean(b.dropoff,250)||'Rua 10, 250, Centro',store?.pickup||'Av. Liberdade, 100',1400,1000,order.id);
    return send(res,201,{ok:true,id:order.id});
  }
  let ifoodMatch=route.match(/^\/api\/orders\/(\d+)\/ifood\/assign$/);
  if (ifoodMatch && method==='POST') {
    if(!requireAdmin(user,res))return;
    const order=one('SELECT * FROM orders WHERE id=?',Number(ifoodMatch[1]));
    if(!order||order.source!=='ifood')return error(res,404,'Pedido iFood não encontrado.');
    const b=await bodyJSON(req), rider=one("SELECT * FROM users WHERE id=? AND role='rider' AND active=1",Number(b.rider_id));
    if(!rider||!rider.phone)return error(res,400,'Selecione entregador ativo com telefone cadastrado.');
    if(order.rider_id && order.rider_id!==rider.id)return error(res,409,'Pedido já atribuído a outro entregador.');
    try {
      const result=await ifood.action(order,'assignDriver',{
        workerName:rider.name, workerPhone:rider.phone.replace(/\D/g,''),workerVehicleType:'MOTORCYCLE'});
      run('UPDATE orders SET rider_id=?,updated_at=? WHERE id=?',rider.id,now(),order.id);
      return send(res,202,result);
    }catch(e){console.warn('iFood ação:',String(e.message).slice(0,180));return error(res,502,'Operação não confirmada pelo iFood. Verifique a habilitação e tente novamente.');}
  }
  ifoodMatch=route.match(/^\/api\/orders\/(\d+)\/ifood\/action$/);
  if(ifoodMatch && method==='POST') {
    const order=one('SELECT * FROM orders WHERE id=?',Number(ifoodMatch[1]));
    if(!order||order.source!=='ifood'||(user.role==='rider'&&order.rider_id!==user.id))return error(res,404,'Pedido não encontrado.');
    const b=await bodyJSON(req);const action=clean(b.action,50);
    const expected={goingToOrigin:['rider_assigned','ready','new','preparing'],arrivedAtOrigin:['going_origin'],
      dispatch:['at_origin','picked_up'],arrivedAtDestination:['on_route','picked_up'],verifyDeliveryCode:['at_destination']};
    if(!(action in expected)||!expected[action].includes(order.delivery_stage))return error(res,409,'Ação incompatível com a etapa atual do pedido.');
    if(!order.rider_id)return error(res,409,'Atribua um entregador antes de iniciar o percurso.');
    if(order.pending_action)return error(res,409,'Aguardando confirmação anterior do iFood.');
    if(action==='verifyDeliveryCode'&&!order.requires_code)return error(res,409,'O iFood não solicitou código de entrega para este pedido.');
    let extras={};
    if(action==='verifyDeliveryCode') {
      const code=clean(b.code,16);
      if(!/^[a-zA-Z0-9]{3,12}$/.test(code))return error(res,400,'Informe o código de entrega exigido pelo iFood.');
      extras={code};
    }
    try{return send(res,202,await ifood.action(order,action,extras));}
    catch(e){return error(res,502,e.message);}
  }
  ifoodMatch=route.match(/^\/api\/orders\/(\d+)\/ifood\/demo-assign$/);
  if(ifoodMatch && method==='POST') {
    if(!requireAdmin(user,res))return;
    if(production||ifood.enabled)return error(res,403,'Simulador local apenas.');
    const o=one('SELECT * FROM orders WHERE id=? AND source=\'ifood\'',Number(ifoodMatch[1]));
    if(!o)return error(res,404,'Pedido não encontrado.');
    const b=await bodyJSON(req);const rider=one("SELECT * FROM users WHERE id=? AND role='rider' AND active=1",Number(b.rider_id));
    if(!rider)return error(res,400,'Entregador inválido.');
    run('UPDATE orders SET rider_id=?,updated_at=? WHERE id=?',rider.id,now(),o.id);
    await ifood.demoEvent(o.id,'ASSIGN_DRIVER');
    return send(res,200,{ok:true});
  }
  ifoodMatch=route.match(/^\/api\/orders\/(\d+)\/ifood\/demo-stage$/);
  if (ifoodMatch && method==='POST') {
    if(!requireAdmin(user,res))return;
    if(production||ifood.enabled)return error(res,403,'Simulador disponível apenas em ambiente local.');
    const b=await bodyJSON(req);const event=clean(b.event,100).toUpperCase();
    const valid=['CONFIRMED','READY_TO_PICKUP','ASSIGN_DRIVER','GOING_TO_ORIGIN','ARRIVED_AT_ORIGIN','COLLECTED','DISPATCHED','ARRIVED_AT_DESTINATION','DELIVERY_DROP_CODE_REQUESTED','CONCLUDED','CANCELLED'];
    if(!valid.includes(event))return error(res,400,'Evento de demonstração inválido.');
    try{await ifood.demoEvent(Number(ifoodMatch[1]),event);return send(res,200,{ok:true});}
    catch(e){return error(res,400,e.message);}
  }
  ifoodMatch=route.match(/^\/api\/orders\/(\d+)\/ifood\/settlement$/);
  if(ifoodMatch && method==='PATCH') {
    if(!requireAdmin(user,res))return;
    const order=one('SELECT * FROM orders WHERE id=? AND source=\'ifood\'',Number(ifoodMatch[1]));
    if(!order)return error(res,404,'Pedido iFood não encontrado.');
    const b=await bodyJSON(req),fee=money(b.fee),payout=money(b.payout);
    if(fee===null||payout===null||payout>fee)return error(res,400,'Informe taxas e repasses válidos.');
    run('UPDATE orders SET fee_cents=?,payout_cents=?,updated_at=? WHERE id=?',fee,payout,now(),order.id);
    return send(res,200,{ok:true});
  }
  if (route==='/api/riders' && method==='GET') {
    if (!requireAdmin(user,res)) return;
    return send(res,200,{riders:all(`SELECT u.id,u.name,u.username,u.phone,u.active,u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status IN ('assigned','collected','in_route')) active_orders,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='delivered') delivered_orders,
      (SELECT COALESCE(SUM(payout_cents),0) FROM orders o WHERE o.rider_id=u.id AND o.status='delivered') payout_cents
      FROM users u WHERE role='rider' ORDER BY active DESC,name ASC`)});
  }
  if (route==='/api/riders' && method==='POST') {
    if (!requireAdmin(user,res)) return;
    const b=await bodyJSON(req); const name=clean(b.name,100); const username=clean(b.username,60).toLowerCase();const phone=clean(b.phone,30);
    if (!name || !/^[a-z0-9._-]{3,60}$/.test(username) || typeof b.password!=='string' || b.password.length<12 || b.password.length>128) return error(res,400,'Informe nome, usuário (mínimo 3 caracteres) e senha de 12 a 128 caracteres.');
    if (one('SELECT id FROM users WHERE username=?',username)) return error(res,409,'Nome de usuário já cadastrado.');
    const id=run('INSERT INTO users (name,username,phone,role,password_hash,created_at) VALUES (?,?,?,?,?,?)',name,username,phone,'rider',hashPassword(b.password),now()).lastInsertRowid;
    audit(req,'rider_created',user.username);return send(res,201,{id:Number(id),ok:true});
  }
  let match=route.match(/^\/api\/riders\/(\d+)\/password$/);
  if (match && method==='PATCH') {
    if (!requireAdmin(user,res)) return;
    const id=Number(match[1]);const rider=one("SELECT id FROM users WHERE id=? AND role='rider'",id);
    if (!rider) return error(res,404,'Entregador não encontrado.');
    const b=await bodyJSON(req);
    if(typeof b.password!=='string'||b.password.length<12||b.password.length>128) return error(res,400,'A nova senha deve conter de 12 a 128 caracteres.');
    run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(b.password),id);
    run('DELETE FROM sessions WHERE user_id=?',id);audit(req,'rider_password_reset',user.username);
    return send(res,200,{ok:true});
  }
  match=route.match(/^\/api\/riders\/(\d+)$/);
  if (match && method==='PATCH') {
    if (!requireAdmin(user,res)) return;
    const id=Number(match[1]); const rider=one("SELECT id FROM users WHERE id=? AND role='rider'",id);
    if (!rider) return error(res,404,'Entregador não encontrado.');
    const b=await bodyJSON(req);
    if (typeof b.active!=='boolean') return error(res,400,'Estado inválido.');
    if (!b.active && one(`SELECT COUNT(*) n FROM orders WHERE rider_id=? AND status IN ('assigned','collected','in_route')`,id).n) return error(res,409,'Reatribua as entregas ativas antes de desativar este entregador.');
    run('UPDATE users SET active=? WHERE id=?',b.active?1:0,id);if(!b.active)run('DELETE FROM sessions WHERE user_id=?',id);audit(req,b.active?'rider_activated':'rider_deactivated',user.username); return send(res,200,{ok:true});
  }
  if (route==='/api/orders' && method==='GET') {
    const rows=listOrders(user.role==='rider'?'WHERE o.rider_id=?':'',user.role==='rider'?[user.id]:[]);
    if(user.role==='rider')for(const order of rows){delete order.fee;delete order.fee_cents;}
    return send(res,200,{orders:rows});
  }
  if (route==='/api/orders' && method==='POST') {
    if (!requireAdmin(user,res)) return;
    const raw=await bodyJSON(req);const storeData=extensions.normalizeOrder(raw);
    const b=validOrder({...raw,...storeData},res);if (!b) return;
    const timestamp=now();const code=nextOrder(); const status=b.rider_id?'assigned':'pending';
    const id=run(`INSERT INTO orders (code,merchant,customer_name,customer_phone,pickup,dropoff,neighborhood,fee_cents,payout_cents,payment_method,notes,status,rider_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,code,b.merchant,b.customer_name,b.customer_phone,b.pickup,b.dropoff,b.neighborhood,b.fee_cents,b.payout_cents,b.payment_method,b.notes,status,b.rider_id,timestamp,timestamp).lastInsertRowid;
    run('UPDATE orders SET store_id=?,distance_km=?,proof_required=1,manual_stage=? WHERE id=?',storeData.store_id,storeData.distance_km,b.rider_id?'rider_assigned':'new',Number(id));
    extensions.syncStores();extensions.track(user.id,'order_created',Number(id),storeData.store_id);
    emit(Number(id),user.id,'Pedido criado');
    if(!b.rider_id)notifications.enqueue(Number(id));
    return send(res,201,{ok:true,id:Number(id),code});
  }
  match=route.match(/^\/api\/orders\/(\d+)$/);
  if (match && method==='PUT') {
    if (!requireAdmin(user,res)) return;
    const id=Number(match[1]); const order=one('SELECT * FROM orders WHERE id=?',id);
    if (!order) return error(res,404,'Pedido não encontrado.');
    if (order.source==='ifood')return error(res,409,'Dados do pedido iFood são sincronizados automaticamente. Altere apenas as taxas no painel iFood.');
    if (['delivered','cancelled'].includes(order.status)) return error(res,409,'Pedidos concluídos ou cancelados não podem ser editados.');
    const raw=await bodyJSON(req);const storeData=extensions.normalizeOrder(raw);
    const b=validOrder({...raw,...storeData},res); if (!b) return;
    if (['collected','in_route'].includes(order.status) && order.rider_id!==b.rider_id) return error(res,409,'Não é possível trocar o entregador após a coleta.');
    const status=['pending','assigned'].includes(order.status)?(b.rider_id?'assigned':'pending'):order.status;
    run(`UPDATE orders SET merchant=?,customer_name=?,customer_phone=?,pickup=?,dropoff=?,neighborhood=?,fee_cents=?,payout_cents=?,payment_method=?,notes=?,status=?,rider_id=?,updated_at=? WHERE id=?`,
      b.merchant,b.customer_name,b.customer_phone,b.pickup,b.dropoff,b.neighborhood,b.fee_cents,b.payout_cents,b.payment_method,b.notes,status,b.rider_id,now(),id);
    run("UPDATE orders SET store_id=?,distance_km=?,manual_stage=CASE WHEN status='assigned' AND manual_stage='new' THEN 'rider_assigned' ELSE manual_stage END WHERE id=?",storeData.store_id,storeData.distance_km,id);
    extensions.syncStores();extensions.track(user.id,'order_updated',id,storeData.store_id);
    emit(id,user.id,'Pedido atualizado');return send(res,200,{ok:true});
  }
  match=route.match(/^\/api\/orders\/(\d+)\/status$/);
  if (match && method==='PATCH') {
    const id=Number(match[1]);const b=await bodyJSON(req);
    const order=one('SELECT * FROM orders WHERE id=?',id);
    if (!order || (user.role==='rider'&&order.rider_id!==user.id)) return error(res,404,'Pedido não encontrado.');
    if (order.source==='ifood')return error(res,409,'Use as ações oficiais iFood para pedidos sincronizados.');
    if (!statuses.includes(b.status)) return error(res,400,'Status inválido.');
    const transitions={pending:[],assigned:['collected'],collected:['in_route'],in_route:['delivered'],delivered:[],cancelled:[]};
    if (user.role==='admin' && !['delivered','cancelled'].includes(order.status)) transitions[order.status].push('cancelled');
    if (!transitions[order.status].includes(b.status)) return error(res,409,'Transição de status não permitida.');
    if(b.status==='delivered' && order.proof_required && !one('SELECT 1 FROM delivery_proofs WHERE order_id=? AND (photo_file IS NOT NULL OR verified_at IS NOT NULL)',id))return error(res,409,'Registre comprovante fotográfico ou código antes de concluir.');
    run('UPDATE orders SET status=?,manual_stage=?,updated_at=?,delivered_at=? WHERE id=?',b.status,({collected:'picked_up',in_route:'on_route',delivered:'delivered',cancelled:'cancelled'}[b.status]||order.manual_stage),now(),b.status==='delivered'?now():null,id);
    extensions.track(user.id,'order_status_'+b.status,id,order.store_id);
    emit(id,user.id,`Status: ${order.status} → ${b.status}`);return send(res,200,{ok:true});
  }
  if (route==='/api/report' && method==='GET') {
    if (!requireAdmin(user,res)) return;
    const from=url.searchParams.get('from')||''; const to=url.searchParams.get('to')||'';
    if (!validateDates(from,to)) return error(res,400,'Período inválido.');
    const filters=[]; const vals=[];
    if (from){filters.push('substr(o.created_at,1,10)>=?');vals.push(from);}
    if (to){filters.push('substr(o.created_at,1,10)<=?');vals.push(to);}
    const rows=listOrders(filters.length?'WHERE '+filters.join(' AND '):'',vals);
    const delivered=rows.filter(o=>o.status==='delivered');
    const revenue=delivered.reduce((a,o)=>a+o.fee_cents,0),payout=delivered.reduce((a,o)=>a+o.payout_cents,0);
    if (url.searchParams.get('format')==='csv') {
      const headers=['Código','Data','Estabelecimento','Cliente','Bairro','Entregador','Situação','Taxa (R$)','Repasse (R$)','Coleta','Destino'];
      const records=rows.map(o=>[o.code,o.created_at,o.merchant,o.customer_name,o.neighborhood,o.rider_name||'',o.status,o.fee.toFixed(2),o.payout.toFixed(2),o.pickup,o.dropoff]);
      const csv='\uFEFF'+[headers,...records].map(row=>row.map(escCSV).join(';')).join('\r\n');
      res.writeHead(200,{...securityHeaders,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="relatorio-entregas.csv"','Cache-Control':'no-store'});res.end(csv);return;
    }
    const perRider=Object.values(delivered.reduce((acc,o)=>{
      const key=o.rider_id||'unassigned'; if (!acc[key])acc[key]={rider:o.rider_name||'Não atribuído',deliveries:0,payout:0};
      acc[key].deliveries++;acc[key].payout+=o.payout;return acc;
    },{})).sort((a,b)=>b.deliveries-a.deliveries);
    return send(res,200,{orders:rows,totals:{count:rows.length,delivered:delivered.length,revenue:revenue/100,payout:payout/100,margin:(revenue-payout)/100},perRider});
  }
  return error(res,404,'Rota não encontrada.');
}
const root=path.join(__dirname,'public');
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/webhooks/ifood') {
      if(req.method!=='POST')return error(res,405,'Método não permitido.');
      if(!ifood.enabled)return error(res,503,'Webhook iFood não configurado.');
      let total=0;const chunks=[];
      for await (const chunk of req){total+=chunk.length;if(total>64*1024)return error(res,413,'Payload muito grande.');chunks.push(chunk);}
      const raw=Buffer.concat(chunks);
      if(!ifood.verifySignature(raw,req.headers['x-ifood-signature']))return error(res,401,'Assinatura iFood inválida.');
      let payload;
      try{payload=JSON.parse(raw.toString('utf8'));}catch{return error(res,400,'JSON inválido.');}
      const items=Array.isArray(payload)?payload:(Array.isArray(payload?.events)?payload.events:[payload]);
      if(items.length>100)return error(res,413,'Muitos eventos.');
      for(const item of items){if(item?.id&&item?.orderId&&item?.merchantId)ifood.storeEvent(item);}
      send(res,202,{received:true});
      setImmediate(()=>ifood.drain().catch(e=>console.error('Webhook:',e.message)));
      return;
    }
    if(url.pathname.startsWith('/api/')) {
      if(!rateLimit(req,res,`api:${req.socket.remoteAddress||'unknown'}`,240,60000))return;
      return await api(req,res,url);
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const filename=url.pathname==='/'?'index.html':url.pathname.replace(/^\//,'');
    const absolute=path.resolve(root,filename);
    if(!absolute.startsWith(root+path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {res.writeHead(404);res.end('Não encontrado');return;}
    res.writeHead(200,{...securityHeaders,'Content-Type':staticTypes[path.extname(absolute)]||'application/octet-stream','Cache-Control':['.html','.js','.css'].includes(path.extname(filename))?'no-store':'public, max-age=3600'});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(absolute).pipe(res);
  } catch(err) {console.error('Falha na requisição:',err?.message||'erro desconhecido');if(!res.headersSent)error(res,err?.statusCode||500,err?.statusCode?err.message:'Ocorreu um erro no servidor.');else res.end();}
});
// A instalação de desenvolvimento com credenciais de demonstração aceita apenas conexões locais.
// Uma instância aberta à Internet só pode subir em modo production com as proteções obrigatórias.
const listenHost=production?'0.0.0.0':'127.0.0.1';
// Limpeza periódica de sessões expiradas e auditoria antiga. Retenção de pedidos exige política institucional própria.
setInterval(()=>{
  try{
    run('DELETE FROM sessions WHERE expires_at<?',now());
    run('DELETE FROM security_audit WHERE at<?',new Date(Date.now()-90*86400000).toISOString());
  }catch(e){console.error('Limpeza de dados operacionais:',e.message);}
},3600_000).unref();
server.listen(PORT,listenHost,()=>console.log(`Rota Privada disponível em http://localhost:${PORT}`));
