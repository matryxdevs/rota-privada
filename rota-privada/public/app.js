'use strict';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const icon = (name, extra='') => `<svg ${extra} aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const brl = v => Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const dates = v => v ? new Date(v).toLocaleDateString('pt-BR') : '—';
const time = v => v ? new Date(v).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '—';
const todayISO = () => new Date().toLocaleDateString('en-CA');
const statuses = {pending:'Pendente',assigned:'Atribuída',collected:'Coletada',in_route:'Em rota',delivered:'Entregue',cancelled:'Cancelada'};
const stages = {new:'Pedido recebido',preparing:'Em preparação',ready:'Pronto para coleta',rider_assigned:'Entregador atribuído',going_origin:'Indo ao estabelecimento',at_origin:'No estabelecimento',picked_up:'Produto coletado',on_route:'Em processo de entrega',at_destination:'Chegou ao destino',delivered:'Entrega concluída',cancelled:'Cancelado'};
const stageActions = {new:['goingToOrigin','Iniciar deslocamento'],preparing:['goingToOrigin','Iniciar deslocamento'],ready:['goingToOrigin','Iniciar deslocamento'],rider_assigned:['goingToOrigin','Iniciar deslocamento'],going_origin:['arrivedAtOrigin','Cheguei ao estabelecimento'],at_origin:['dispatch','Produto coletado · sair para entrega'],picked_up:['dispatch','Iniciar entrega'],on_route:['arrivedAtDestination','Cheguei ao local'],at_destination:['verifyDeliveryCode','Validar código de entrega']};
const timelineStages=['new','rider_assigned','going_origin','at_origin','picked_up','on_route','at_destination','delivered'];
const ifoodTag=o=>o.source==='ifood'?`<span class="source-tag">iFood</span>`:'';
const displayBadge=o=>o.source==='ifood'?`<span class="badge ifood-stage" title="Notificação oficial: ${esc(o.ifood_event||'')}">${esc(stages[o.delivery_stage]||'Aguardando iFood')}</span>`:badge(o.status);
const ifoodActionButton=o=>{if(o.source!=='ifood'||o.delivered_by==='IFOOD'||o.status==='cancelled'||o.status==='delivered')return '';if(o.pending_action)return `<span class="pending-sync">${icon('clock')} Aguardando confirmação do iFood</span>`;if(!o.rider_id)return isAdmin()?`<button type="button" class="btn btn-primary" data-action="ifood-assign" data-id="${o.id}">Atribuir motoboy</button>`:'';
 const step=stageActions[o.delivery_stage];if(!step)return '';if(step[0]==='verifyDeliveryCode'&&!o.requires_code)return `<span class="pending-sync">Aguardando conclusão do iFood</span>`;return `<button type="button" class="btn btn-primary" data-action="ifood-stage" data-id="${o.id}" data-stage="${step[0]}">${icon('arrow')} ${step[1]}</button>`;};
const nextSteps = {assigned:['collected','Confirmar coleta'],collected:['in_route','Iniciar rota'],in_route:['delivered','Concluir entrega']};
const state = {user:null,orders:[],riders:[],ifood:null,board:[],stores:[],history:null,audit:null,positions:[],view:'dashboard',query:'',status:'all',report:null,reportFrom:'',reportTo:''};
let toastTimer;
function toast(message,type='ok') { const el=$('#toast');el.textContent=message;el.className='toast show'+(type==='error'?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3500); }
async function request(url, {method='GET',body}={}) {
  const init={method,credentials:'same-origin',headers:method==='GET'?{}:{'X-Requested-With':'XMLHttpRequest'}};
  if(body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
  const response=await fetch(url,init);
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error || `Erro ${response.status}`);
  return payload;
}
const badge = s => `<span class="badge ${esc(s)}">${esc(statuses[s] || s)}</span>`;
const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()||'').join('');
const activeOrders = () => state.orders.filter(o=>['assigned','collected','in_route'].includes(o.status) || (o.source==='ifood'&&o.status==='pending'&&o.rider_id));
const isAdmin=()=>state.user?.role==='admin';
const heading=(eyebrow,title,desc,actions='')=>`<header class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions">${actions}</div></header>`;
const newButton=()=>`<button type="button" class="btn btn-primary" data-action="new-order">${icon('plus')} Nova entrega</button>`;
const empty=(title='Nenhuma entrega encontrada',subtitle='Os registros aparecerão aqui assim que forem cadastrados.')=>`<div class="empty-state"><div class="empty-icon">${icon('package')}</div><h3>${title}</h3><p>${subtitle}</p></div>`;
const stat=(title,value,subtitle,symbol,tone)=>`<div class="stat-card"><div class="stat-top"><span>${title}</span><span class="stat-icon ${tone}">${icon(symbol)}</span></div><div class="stat-value">${value}</div><div class="stat-bottom">${subtitle}</div></div>`;
function orderTable(orders,compact=false) {
  if (!orders.length) return empty();
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Pedido</th><th>Estabelecimento / Cliente</th><th>Entregador</th><th>${isAdmin()?'Taxa':'Repasse'}</th><th>Status</th><th>Ação</th></tr></thead><tbody>${orders.map(o=>`<tr><td class="primary-cell">${esc(o.code)} ${ifoodTag(o)}<span class="subline">${dates(o.created_at)} · ${time(o.created_at)}</span></td><td class="primary-cell">${esc(o.merchant)}<span class="subline">${esc(o.customer_name)}</span></td><td>${esc(o.rider_name||'Não atribuído')}</td><td class="primary-cell">${brl(isAdmin()?o.fee:o.payout)}</td><td>${displayBadge(o)}</td><td><button type="button" class="view-btn" data-action="view-order" data-id="${o.id}" title="Ver detalhes">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function viewDashboard() {
  if (!isAdmin()) return viewRiderDashboard();
  const o=state.orders;const delivered=o.filter(x=>x.status==='delivered');
  const today=o.filter(x=>x.created_at.slice(0,10)===todayISO());
  const sum=delivered.reduce((s,x)=>s+x.fee,0); const ongoing=activeOrders().length;
  const series=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(6-i));return {date:d.toLocaleDateString('en-CA'),day:d.toLocaleDateString('pt-BR',{weekday:'short'}).replace('.',''),n:o.filter(x=>x.created_at.slice(0,10)===d.toLocaleDateString('en-CA')).length};});
  const max=Math.max(...series.map(x=>x.n),1);
  return `${heading('PAINEL DE CONTROLE','Visão geral','Acompanhe o desempenho da sua operação em um só lugar.',newButton())}
  ${state.orders.some(x=>x.source==='ifood')?`<div class="ifood-inline"><strong>Pedidos iFood sincronizados</strong><span>${state.orders.filter(x=>x.source==='ifood').length} pedido(s) disponível(is) neste painel. ${state.ifood?.configured?'Conector configurado':'Modo demonstrativo; integração não habilitada.'}</span><button data-view="ifood" class="text-link">Ver integração ${icon('arrow')}</button></div>`:''}
  <div class="stats-grid">${stat('Entregas hoje',today.length,'Pedidos registrados hoje','package','orange')}${stat('Em andamento',ongoing,'Em coleta, atribuição ou rota','clock','blue')}${stat('Entregas concluídas',delivered.length,'Total no histórico','check','green')}${stat('Receita de entregas',brl(sum),'Taxas de entregas concluídas','wallet','purple')}</div>
  <div class="section-grid"><section class="panel"><div class="panel-header"><div><h2>Volume de entregas</h2><p>Movimentação nos últimos 7 dias</p></div><span class="eyebrow">ÚLTIMOS 7 DIAS</span></div><div class="chart">${series.map((d,i)=>`<div class="chart-col"><span class="bar-number">${d.n}</span><div class="bar-track"><div class="bar ${i===6?'active':''}" style="height:${Math.max(3,Math.round(d.n/max*100))}%"></div></div><label>${esc(d.day)}</label></div>`).join('')}</div></section>
  <section class="panel"><div class="panel-header"><div><h2>Operação em tempo real</h2><p>Status dos pedidos mais recentes</p></div></div><div class="activity-list">${o.length?o.slice(0,5).map(x=>`<div class="activity-row"><span class="activity-bubble">${icon('package')}</span><div class="activity-text"><strong>${esc(x.merchant)}</strong><span>${esc(x.code)} · ${dates(x.created_at)}</span></div>${displayBadge(x)}</div>`).join(''):empty()}</div></section></div>
  <section class="panel"><div class="panel-header"><div><h2>Entregas recentes</h2><p>Acompanhe seus últimos pedidos cadastrados</p></div><button class="text-link" type="button" data-view="orders">Ver todas ${icon('arrow')}</button></div>${orderTable(o.slice(0,6),true)}</section>`;
}
function deliveryCard(o) {
  const step=nextSteps[o.status];
  return `<article class="delivery-card"><div class="delivery-top"><div><h3>${esc(o.merchant)}</h3><small>${esc(o.code)} ${ifoodTag(o)} · ${dates(o.created_at)}</small></div>${displayBadge(o)}</div><div class="delivery-route"><div class="delivery-stop"><strong>LOCAL DE COLETA</strong>${esc(o.pickup)}</div><div class="delivery-stop"><strong>DESTINO DA ENTREGA</strong>${esc(o.dropoff)}${o.neighborhood?' · '+esc(o.neighborhood):''}</div></div><div class="delivery-actions"><span class="pay-info">Seu repasse<br><b>${brl(o.payout)}</b></span><div class="filter-row"><button type="button" class="btn btn-outline" data-action="view-order" data-id="${o.id}">Detalhes</button>${o.source==='ifood'?ifoodActionButton(o):manualJourney(o)}</div></div></article>`;
}
function viewRiderDashboard() {
  const o=state.orders;const delivered=o.filter(x=>x.status==='delivered');
  const active=activeOrders();const payout=delivered.reduce((s,x)=>s+x.payout,0);
  return `${heading('ÁREA DO ENTREGADOR','Minha operação',`Olá, ${esc(state.user.name.split(' ')[0])}. Confira suas entregas e organize sua jornada.`)}<div class="intro-banner"><div><div class="eyebrow">BOAS ENTREGAS!</div><h2>Pronto para mais uma rota?</h2><p>Suas entregas atribuídas estão organizadas aqui.</p></div>${icon('bike','style="width:58px;height:58px;color:#ff9d76"')}</div><div class="push-rider-banner"><div><strong>${icon('bell')} Receba avisos de novas entregas</strong><p>Ative as notificações deste dispositivo para receber ofertas de estabelecimentos autorizados.</p></div>${notificationControls()}</div><div class="stats-grid">${stat('Entregas ativas',active.length,'Aguardando conclusão','bike','orange')}${stat('Concluídas',delivered.length,'Total das suas entregas','check','green')}${stat('Total de repasses',brl(payout),'Referente às entregas concluídas','wallet','purple')}${stat('Todos os pedidos',o.length,'Histórico atribuído à sua conta','package','blue')}</div><section class="panel"><div class="panel-header"><div><h2>Minhas entregas em andamento</h2><p>Atualize cada etapa conforme concluir o serviço</p></div><button class="text-link" type="button" data-view="orders">Ver histórico ${icon('arrow')}</button></div><div style="padding:15px 23px 23px" class="rider-orders">${active.length?active.map(deliveryCard).join(''):empty('Sem entregas em andamento','Quando uma entrega for atribuída a você, ela aparecerá aqui.')}</div></section>${viewGpsControls()}`;
}
function viewOrders() {
  const admin=isAdmin();
  return `${heading('OPERAÇÃO',admin?'Gestão de entregas':'Minhas entregas',admin?'Visualize, atribua e acompanhe todos os pedidos da operação.':'Acompanhe seu histórico e atualize o andamento dos pedidos.',admin?newButton():'')}<section class="panel"><div class="toolbar"><div class="searchbox">${icon('search')}<input type="search" id="orderSearch" placeholder="Buscar por pedido, cliente ou local..." value="${esc(state.query)}" autocomplete="off" aria-label="Buscar entregas"></div><div class="filter-row"><span class="eyebrow">${icon('filter')}</span><select class="filter-select" id="statusFilter" aria-label="Filtrar por status"><option value="all">Todos os status</option>${Object.entries(statuses).map(([k,v])=>`<option value="${k}" ${state.status===k?'selected':''}>${v}</option>`).join('')}</select></div></div><div id="ordersResult">${filteredOrderTable()}</div></section><p class="footer-hint">${admin?'O repasse é calculado por entrega concluída.':'As alterações de status ficam registradas no sistema.'}</p>`;
}
function filteredOrderTable() {
  const q=state.query.toLowerCase();
  const orders=state.orders.filter(o=>(state.status==='all'||o.status===state.status)&&(!q||[o.code,o.merchant,o.customer_name,o.neighborhood,o.dropoff,o.rider_name].some(s=>String(s||'').toLowerCase().includes(q))));
  return orderTable(orders);
}
function viewRiders() {
  if(!isAdmin())return '';
  return `${heading('EQUIPE','Entregadores','Gerencie sua equipe e acompanhe os resultados individuais.',`<button class="btn btn-primary" type="button" data-action="new-rider">${icon('plus')} Novo entregador</button>`)}<div class="rider-grid">${state.riders.length?state.riders.map(r=>`<article class="rider-card"><div class="rider-top"><div class="rider-portrait">${esc(initials(r.name))}</div><div><div class="rider-name">${esc(r.name)}</div><div class="rider-user">@${esc(r.username)} · ${esc(r.phone||'Sem telefone')}</div></div></div><div class="rider-details"><div><strong>${r.active_orders}</strong><span>Em andamento</span></div><div><strong>${r.delivered_orders}</strong><span>Concluídas</span></div><div style="grid-column:1/-1"><strong>${brl(r.payout_cents/100)}</strong><span>Repasses concluídos</span></div></div><div class="rider-footer"><span class="${r.active?'active-tag':'inactive-tag'}">● ${r.active?'Ativo':'Inativo'}</span><div class="filter-row"><button type="button" data-action="reset-rider" data-id="${r.id}">Senha</button><button type="button" data-action="toggle-rider" data-id="${r.id}" data-active="${r.active?0:1}">${r.active?'Desativar':'Ativar'}</button></div></div></article>`).join(''):empty('Nenhum entregador cadastrado','Cadastre o primeiro entregador para iniciar a operação.')}</div>`;
}
function viewFinance() {
  if(!isAdmin())return '';
  const report=state.report;
  return `${heading('CONTROLE FINANCEIRO','Financeiro','Consulte taxas de entrega, repasses e resultados da operação.',`<button type="button" class="btn btn-outline" data-action="csv">${icon('download')} Exportar CSV</button>`)}<section class="panel"><div class="panel-header"><div><h2>Período de apuração</h2><p>Filtre os pedidos pela data de cadastro</p></div></div><form class="report-filters" id="reportForm"><label class="date-field">Data inicial<input type="date" name="from" id="reportFrom" value="${esc(state.reportFrom)}"></label><label class="date-field">Data final<input type="date" name="to" id="reportTo" value="${esc(state.reportTo)}"></label><button type="submit" class="btn btn-primary">${icon('filter')} Aplicar filtro</button><button type="button" class="btn btn-outline" data-action="clear-report">Limpar</button></form></section>${report?`<div class="financial-summary"><div class="financial-big"><small>Receita de entregas concluídas</small><div class="value">${brl(report.totals.revenue)}</div></div><div class="financial-big"><small>Repasses aos entregadores</small><div class="value">${brl(report.totals.payout)}</div></div><div class="financial-big"><small>Margem operacional bruta</small><div class="value">${brl(report.totals.margin)}</div></div></div><div class="section-grid"><section class="panel"><div class="panel-header"><div><h2>Entregas no período</h2><p>${report.totals.count} pedidos · ${report.totals.delivered} entregues</p></div></div>${orderTable(report.orders.slice(0,20))}</section><section class="panel"><div class="panel-header"><div><h2>Repasses por entregador</h2><p>Somente entregas concluídas</p></div></div><div class="activity-list">${report.perRider.length?report.perRider.map(r=>`<div class="activity-row"><span class="activity-bubble">${icon('bike')}</span><div class="activity-text"><strong>${esc(r.rider)}</strong><span>${r.deliveries} entrega(s)</span></div><strong>${brl(r.payout)}</strong></div>`).join(''):empty('Sem repasses','Não há entregas concluídas no período.')}</div></section></div>`:''}<p class="footer-hint">Receita, repasse e margem são apurados somente para entregas com status “Entregue”. A margem é bruta e não inclui custos administrativos ou tributos.</p>`;
}
function viewIfood(){
  if(!isAdmin())return '';
  const c=state.ifood||{};
  const all=state.orders.filter(o=>o.source==='ifood');
  const live=c.configured;
  const recent=all.slice(0,8);
  const tools=`<div class="filter-row"><button type="button" class="btn btn-outline" data-action="refresh-ifood">${icon('clock')} Atualizar</button>${live?`<button type="button" class="btn btn-primary" data-action="poll-ifood">${icon('arrow')} Buscar eventos</button>`:`<button type="button" class="btn btn-primary" data-action="simulate-ifood">${icon('plus')} Simular pedido iFood</button>`}</div>`;
  return `${heading('CONECTOR OFICIAL','Integração iFood','Receba pedidos autorizados e acompanhe notificações reais de logística.',tools)}
    <div class="ifood-hero"><div class="ifood-hero-symbol">i<span>Food</span></div><div><div class="eyebrow">CENTRAL DE INTEGRAÇÃO</div><h2>${live?'Credenciais configuradas':'Conecte suas lojas do iFood'}</h2><p>${live?'O servidor dispõe de credenciais. A autorização das lojas e a homologação devem ser confirmadas no Portal do Desenvolvedor.':'Use o simulador para testar o painel. Para pedidos reais, configure a API oficial no servidor.'}</p></div><span class="connection-status ${live?'connected':'disconnected'}">${live?'● Chaves configuradas':'○ Aguardando conexão'}</span></div>
    <div class="stats-grid">${stat('Pedidos iFood',all.length,'Recebidos neste painel','package','orange')}${stat('Em percurso',all.filter(x=>['going_origin','at_origin','picked_up','on_route','at_destination'].includes(x.delivery_stage)).length,'Etapas de logística','bike','blue')}${stat('Entregues',all.filter(x=>x.status==='delivered').length,'Confirmados pelo evento iFood','check','green')}${stat('Eventos recebidos',c.storedEvents||0,`${c.pendingEvents||0} evento(s) em fila`,'bell','purple')}</div>
    <div class="section-grid"><section class="panel"><div class="panel-header"><div><h2>Últimos pedidos iFood</h2><p>Pedidos de lojas com integração autorizada</p></div></div>${recent.length?`<div class="ifood-feed">${recent.map(o=>`<button class="ifood-feed-item" data-action="view-order" data-id="${o.id}"><div><strong>${esc(o.merchant)}</strong><small>${esc(o.code)} · ${esc(o.customer_name)}</small></div><div>${displayBadge(o)}<small>${time(o.updated_at)}</small></div></button>`).join('')}</div>`:empty('Nenhum pedido iFood','Ative a integração oficial ou utilize a simulação local.')}</section>
      <section class="panel"><div class="panel-header"><div><h2>Lojas vinculadas</h2><p>Identificação dos estabelecimentos cadastrados</p></div><button class="text-link" type="button" data-action="add-ifood-store">+ Loja</button></div><div class="ifood-stores">${(c.merchants||[]).length?(c.merchants||[]).map(m=>`<div class="ifood-store"><div><strong>${esc(m.name)}</strong><small>ID: ${esc(m.merchant_id)}</small><small>${esc(m.pickup||'Endereço não informado')}</small></div>${icon('check')}</div>`).join(''):empty('Nenhuma loja cadastrada','Adicione o ID da loja autorizado no iFood.')}</div></section></div>
    <section class="panel ifood-guide"><div class="panel-header"><div><h2>Etapas sincronizadas</h2><p>Correspondência entre o painel e os eventos de logística do iFood</p></div></div><div class="stage-flow">${['Pedido recebido','Motoboy atribuído','Indo à loja','Chegou à loja','Produto coletado','Em entrega','Chegou ao cliente','Concluído'].map((x,i)=>`<div class="stage-flow-item"><span>${i+1}</span>${x}</div>`).join('')}</div></section>
    <p class="footer-hint">Eventos via webhook assinado e polling opcional. Ações oficiais podem retornar HTTP 202 e só serão confirmadas após o evento de resposta. Pedidos da logística iFood ficam em modo de acompanhamento; operações de frota própria dependem da habilitação do módulo Logistics.</p>`;
}
function openIfoodStoreForm(){
  openModal('Cadastrar loja iFood',`<form id="ifoodStoreForm"><div class="form-grid">${formField('merchant_id','Merchant ID (UUID da loja) *','','wide placeholder="ID oficial da loja"')}${formField('name','Nome do estabelecimento *','','wide')}${formField('pickup','Endereço de coleta','','wide')}</div><p class="footer-hint">Cadastrar uma loja não autoriza automaticamente o acesso. O estabelecimento também precisa conceder permissão à aplicação no iFood.</p><div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button type="submit" class="btn btn-primary">Salvar loja</button></div></form>`);
}
function openIfoodAssign(id){
 const o=state.orders.find(x=>x.id===id);if(!o)return;
 openModal('Atribuir entregador',`<form id="ifoodAssignForm" data-id="${id}"><div class="form-grid"><div class="form-field wide"><label>Pedido</label><strong>${esc(o.merchant)} · ${esc(o.code)}</strong></div><div class="form-field wide"><label for="ifoodRider">Entregador disponível</label><select id="ifoodRider" name="rider_id" required><option value="">Selecione</option>${state.riders.filter(x=>x.active).map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div></div><p class="footer-hint">Atribuição real exige Logistics habilitada para a loja. Em ambiente demonstrativo, a atribuição é simulada.</p><div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button type="submit" class="btn btn-primary">Confirmar atribuição</button></div></form>`);
}
async function doIfoodAction(id,action){
 const o=state.orders.find(x=>x.id===id);if(!o)return;
 if(!state.ifood?.configured){toast('No modo demonstração, use os eventos simulados no detalhe do pedido.','error');return;}
 let body={action};
 if(action==='verifyDeliveryCode'){
   const value=prompt('Informe o código que o iFood solicitou ao cliente:');if(value===null)return;body.code=value;
 }
 try{const reply=await request(`/api/orders/${id}/ifood/action`,{method:'POST',body});closeModal();await loadData();render();toast(reply.message||'Ação enviada. Aguardando confirmação do iFood.');}catch(e){toast(e.message,'error');}
}
const demoEventOptions=['CONFIRMED','READY_TO_PICKUP','ASSIGN_DRIVER','GOING_TO_ORIGIN','ARRIVED_AT_ORIGIN','COLLECTED','DISPATCHED','ARRIVED_AT_DESTINATION','DELIVERY_DROP_CODE_REQUESTED','CONCLUDED','CANCELLED'];
async function demoIfoodEvent(id,event){
 try{await request(`/api/orders/${id}/ifood/demo-stage`,{method:'POST',body:{event}});closeModal();await loadData();render();toast('Notificação simulada: '+event);}catch(e){toast(e.message,'error');}
}
function viewAccount() {
  return `${heading('PERFIL','Minha conta','Informações do seu acesso à plataforma.')}<section class="panel account-card"><div class="rider-top"><div class="rider-portrait">${esc(initials(state.user.name))}</div><div><div class="rider-name">${esc(state.user.name)}</div><div class="rider-user">${isAdmin()?'Administrador':'Entregador'} · Conta ativa</div></div></div><div class="account-details"><div class="account-line"><span>Nome</span><strong>${esc(state.user.name)}</strong></div><div class="account-line"><span>Usuário</span><strong>@${esc(state.user.username)}</strong></div><div class="account-line"><span>Perfil de acesso</span><strong>${isAdmin()?'Administrador':'Entregador'}</strong></div><div class="account-line"><span>Telefone</span><strong>${esc(state.user.phone || 'Não informado')}</strong></div></div><div class="filter-row"><button type="button" class="btn btn-primary" data-action="change-password">${icon('lock')} Alterar senha</button><button type="button" class="btn btn-outline" data-action="logout">${icon('log-out')} Encerrar sessão</button></div></section>${!isAdmin()?viewGpsControls():''}<p class="footer-hint">Para redefinir senhas, utilize o procedimento administrativo do servidor. Nunca compartilhe sua senha.</p>`;
}
// === V2: central compartilhada, gestão de lojas, GPS consentido e comprovantes ===
const journeySteps={rider_assigned:['going_origin','Iniciar deslocamento'],going_origin:['at_origin','Cheguei ao estabelecimento'],at_origin:['picked_up','Produto coletado'],picked_up:['on_route','Iniciar entrega'],on_route:['at_destination','Cheguei ao endereço'],at_destination:['delivered','Concluir entrega']};
const manualJourney=o=>{
  if(o.source==='ifood'||['pending','delivered','cancelled'].includes(o.status))return '';
  const stage=o.manual_stage==='new'&&o.status==='assigned'?'rider_assigned':o.manual_stage;
  const step=journeySteps[stage];
  return step?`<button type="button" class="btn btn-primary" data-action="journey" data-id="${o.id}" data-stage="${step[0]}">${esc(step[1])} ${icon('arrow')}</button>`:'';
};
function boardCard(o){return `<article class="dispatch-card"><div class="dispatch-head"><span class="live-pill"><span class="live-dot"></span> DISPONÍVEL AGORA</span><span class="code">${esc(o.code)} ${o.source==='ifood'?ifoodTag(o):''}</span></div><h3>${esc(o.merchant)}</h3><div class="dispatch-details"><p><b>Coleta</b>${esc(o.pickup)}</p><p><b>Bairro de destino</b>${esc(o.neighborhood||'Informado após aceitar')}</p><p><b>Distância informada</b>${o.distance_km==null?'Não informada':`${Number(o.distance_km).toLocaleString('pt-BR')} km`}</p></div><div class="dispatch-bottom"><span><small>REPASSE PREVISTO</small><strong>${brl(o.payout)}</strong></span>${isAdmin()?`<button class="btn btn-outline" data-action="view-order" data-id="${o.id}">Detalhes</button>`:`<button type="button" class="btn btn-primary" data-action="accept" data-id="${o.id}">Aceitar entrega ${icon('arrow')}</button>`}</div></article>`;}
function viewBoard(){
 const orders=state.board||[];
 return `${heading('CENTRAL DE DESPACHO','Entregas disponíveis',isAdmin()?'Fila de pedidos aguardando um motoboy.':'Todos os entregadores autorizados podem visualizar a mesma fila. Quem aceitar primeiro assume a entrega.',`<button type="button" class="btn btn-outline" data-action="refresh-board">${icon('clock')} Atualizar</button>`)}
 <div class="dispatch-summary"><div><span class="live-pill"><span class="live-dot"></span> ATUALIZAÇÃO AUTOMÁTICA</span><h2>${orders.length} ${orders.length===1?'entrega disponível':'entregas disponíveis'}</h2><p>Atualização a cada 8 segundos com a página aberta. Com push ativado, novos pedidos também podem ser avisados em segundo plano.</p></div>${notificationControls()}</div>
 <div class="dispatch-grid">${orders.length?orders.map(boardCard).join(''):empty('Nenhuma entrega disponível','Os próximos pedidos aparecerão nesta central quando forem liberados.')}</div>`;
}
function viewHistory(){
 const history=state.history||{orders:[],total_earned:0};const completed=history.orders.filter(o=>o.status==='delivered');
 return `${heading('ÁREA EXCLUSIVA','Meu histórico e ganhos','Consulte somente os pedidos aceitos pela sua conta.')}
 <div class="stats-grid">${stat('Entregas realizadas',completed.length,'Histórico concluído','check','green')}${stat('Total de ganhos',brl(history.total_earned),'Repasse de pedidos concluídos','wallet','orange')}${stat('Entregas na conta',history.orders.length,'Inclui pedidos em andamento','package','blue')}${stat('Não concluídas',history.orders.filter(x=>x.status!=='delivered').length,'Pendentes, em andamento ou canceladas','clock','purple')}</div>
 <section class="panel"><div class="panel-header"><div><h2>Extrato de entregas</h2><p>Histórico individual preservado no banco</p></div></div>
 <div class="history-list">${history.orders.length?history.orders.map(o=>`<div class="history-item"><div><strong>${esc(o.code)} · ${esc(o.merchant)}</strong><span>${dates(o.created_at)} · ${esc(statuses[o.status]||o.status)}</span></div><strong>${brl(o.status==='delivered'?o.payout:0)}</strong></div>`).join(''):empty('Sem histórico','Aceite uma entrega na central para começar.')}</div></section>`;
}
function storeCard(s){return `<article class="store-card"><div class="store-head"><span class="store-icon">${icon('package')}</span><span class="${s.active?'active-tag':'inactive-tag'}">● ${s.active?'Ativa':'Inativa'}</span></div><h3>${esc(s.name)}</h3><p>${esc(s.pickup)}</p>${s.merchant_id?'<span class="source-tag">iFood vinculado</span>':''}<div class="tariff-grid"><div><small>Taxa base</small><strong>${brl(s.base_fee_cents/100)}</strong></div><div><small>Por km</small><strong>${brl(s.per_km_cents/100)}</strong></div><div><small>Repasse base</small><strong>${brl(s.rider_base_cents/100)}</strong></div><div><small>Repasse/km</small><strong>${brl(s.rider_per_km_cents/100)}</strong></div></div><div class="store-foot"><span class="${s.restricted?'restricted':'unrestricted'}">${s.restricted?'Acesso restrito':'Todos autorizados'}</span><div class="filter-row"><button class="btn btn-outline" data-action="store-access" data-id="${s.id}">Acesso</button><button class="btn btn-primary" data-action="store-edit" data-id="${s.id}">Editar</button></div></div></article>`;}
function viewStores(){return `${heading('REDE DE ESTABELECIMENTOS','Lojas e tarifas','Cadastre pontos de coleta, configure valores por distância e gerencie a visibilidade por estabelecimento.',`<button class="btn btn-primary" data-action="new-store">${icon('plus')} Nova loja</button>`)}
 <p class="footer-hint info-top">Os valores por km usam a distância informada pelo administrador — sem roteirização ou cálculo automático de mapas. Lojas iFood ainda dependem das credenciais e autorizações oficiais.</p>
 <div class="store-grid">${(state.stores||[]).length?state.stores.map(storeCard).join(''):empty('Nenhuma loja','Cadastre a primeira loja para associar pedidos e tarifas.')}</div>`;}
function viewTracking(){const gps=state.positions||[];return `${heading('MONITORAMENTO','Localização da equipe','Localizações compartilhadas voluntariamente pelos entregadores; somente posições recentes são exibidas.',`<button class="btn btn-outline" data-action="refresh-gps">Atualizar localizações</button>`)}
 <div class="stats-grid">${stat('Compartilhando agora',gps.length,'Atualizações dos últimos 15 minutos','pin','orange')}${stat('Entregadores cadastrados',state.riders.length,'Equipe da plataforma','users','blue')}</div>
 <section class="panel"><div class="panel-header"><div><h2>Posição mais recente por entregador</h2><p>O rastreamento só funciona com consentimento e página aberta no celular.</p></div></div><div class="history-list">${gps.length?gps.map(p=>`<div class="history-item"><div><strong>${esc(p.name)}</strong><span>Precisão aproximada: ${Math.round(p.accuracy_m)} m · ${dates(p.updated_at)} ${time(p.updated_at)}</span></div><a class="btn btn-outline" href="https://www.google.com/maps?q=${encodeURIComponent(p.lat+','+p.lng)}" target="_blank" rel="noopener noreferrer">Ver no mapa ${icon('external')}</a></div>`).join(''):empty('Nenhum GPS ativo','O entregador pode habilitar o compartilhamento em sua conta.')}</div></section>`;}
function viewAudit(){const events=state.audit?.events||[],security=state.audit?.security||[];return `${heading('GOVERNANÇA','Registro de auditoria','Histórico técnico de mudanças operacionais e eventos de segurança, disponível somente ao administrador.',`<button class="btn btn-outline" data-action="refresh-audit">Atualizar registros</button>`)}
 <section class="panel"><div class="panel-header"><div><h2>Operações recentes</h2><p>Últimas 100 ações registradas</p></div></div><div class="history-list">${events.length?events.map(x=>`<div class="history-item"><div><strong>${esc(x.action.replaceAll('_',' '))}</strong><span>${esc(x.actor||'Sistema')} · ${esc(x.store_name||x.order_code||'Operação')} · ${dates(x.at)} ${time(x.at)}</span></div></div>`).join(''):empty('Sem eventos','As próximas movimentações aparecerão aqui.')}</div></section><section class="panel" style="margin-top:22px"><div class="panel-header"><div><h2>Segurança dos acessos</h2><p>Últimos 50 eventos de segurança</p></div></div><div class="history-list">${security.map(x=>`<div class="history-item"><div><strong>${esc(x.event)}</strong><span>${esc(x.username)} · ${dates(x.at)} ${time(x.at)}</span></div></div>`).join('')||empty('Sem registros')}</div></section>`;}
function viewGpsControls(){return `<section class="panel gps-panel"><div class="panel-header"><div><h2>Compartilhamento de GPS</h2><p>Você decide se deseja compartilhar sua localização com o administrador. A posição não será armazenada continuamente se a página for fechada.</p></div></div><div class="gps-actions"><span class="${gpsWatchId!==null?'active-tag':'inactive-tag'}" id="gpsLabel">● ${gpsWatchId!==null?'Compartilhamento ativado':'Compartilhamento desativado'}</span><button type="button" class="btn ${gpsWatchId!==null?'btn-danger':'btn-primary'}" data-action="toggle-gps">${gpsWatchId!==null?'Parar GPS':'Ativar compartilhamento de localização'}</button></div></section>`;}
function storeModal(s=null){if(!isAdmin())return;const id=s?.id||'';
 const val=(k,d='')=>s?.[k]??d;
 openModal(s?'Editar loja':'Nova loja',`<form id="storeForm" data-id="${id}"><div class="form-grid">${formField('name','Nome do estabelecimento *',val('name'),'wide')}${formField('pickup','Endereço de coleta *',val('pickup'),'wide')}
 ${id?`${formField('base_fee','Taxa base (R$)',val('base_fee_cents')/100,'type="number" min="0" step="0.01"')}${formField('per_km','Taxa por km (R$)',val('per_km_cents')/100,'type="number" min="0" step="0.01"')}${formField('rider_base','Repasse base (R$)',val('rider_base_cents')/100,'type="number" min="0" step="0.01"')}${formField('rider_per_km','Repasse por km (R$)',val('rider_per_km_cents')/100,'type="number" min="0" step="0.01"')}
 <div class="form-field wide"><label><input type="checkbox" name="restricted" ${s.restricted?'checked':''}> Restringir a entregadores autorizados</label></div><div class="form-field wide"><label><input type="checkbox" name="active" ${s.active?'checked':''}> Loja ativa</label></div>`:''}</div><p class="footer-hint">Apenas o administrador altera tarifas e acessos. As mudanças não recalculam valores de pedidos anteriores.</p><div class="modal-actions"><button class="btn btn-outline" type="button" data-close-modal>Cancelar</button><button class="btn btn-primary" type="submit">Salvar estabelecimento</button></div></form>`);
}
async function storeAccess(id){const s=state.stores.find(x=>x.id===id);if(!s)return;
 try {const access=await request(`/api/stores/${id}/access`);const allowed=new Set(access.rider_ids);
 openModal('Permissões • '+s.name,`<form id="storeAccessForm" data-id="${id}"><p class="footer-hint">Com acesso aberto, todos os entregadores ativos veem os pedidos. Com acesso restrito, apenas os marcados abaixo recebem as ofertas.</p><label class="access-switch"><input type="checkbox" name="restricted" ${s.restricted?'checked':''}> Somente entregadores selecionados</label><div class="access-list">${state.riders.filter(r=>r.active).map(r=>`<label><input type="checkbox" name="rider_ids" value="${r.id}" ${allowed.has(r.id)?'checked':''}> ${esc(r.name)}</label>`).join('')}</div><div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button class="btn btn-primary" type="submit">Salvar permissões</button></div></form>`);
 }catch(e){toast(e.message,'error');}}
function openProof(id){const o=state.orders.find(x=>x.id===id);if(!o)return;
 openModal('Comprovante de entrega • '+o.code,`<div class="proof-options"><p class="footer-hint">Registre uma foto da entrega (até 950 KB) ou valide um código de 8 dígitos. Fotos ficam em pasta privada do servidor, fora dos arquivos públicos. Para pedidos iFood, a conclusão depende também da confirmação oficial.</p>
 <form id="photoProofForm" data-id="${id}"><label class="proof-upload">${icon('package')} Foto do comprovante<input name="photo" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" required></label><button class="btn btn-primary" type="submit">Enviar foto</button></form>
 ${o.source!=='ifood'?`<form id="codeProofForm" data-id="${id}"><div class="form-field"><label>Código de 8 dígitos recebido do cliente</label><input name="code" type="text" inputmode="numeric" maxlength="8" pattern="[0-9]{8}" required placeholder="00000000"></div><button class="btn btn-outline" type="submit">Validar código</button></form>${isAdmin()?`<button class="btn btn-outline" type="button" data-action="generate-proof" data-id="${id}">Gerar código para o cliente</button>`:''}`:''}
 <div id="proofResult" class="footer-hint"></div><button class="btn btn-outline" type="button" data-action="check-proof" data-id="${id}">Verificar comprovante salvo</button></div>`);
}
async function readProofImage(file){if(!file)throw Error('Selecione uma foto.');if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Use PNG, JPEG ou WebP.');if(file.size>10*1024*1024)throw Error('Arquivo original deve ter até 10 MB.');
 const url=URL.createObjectURL(file);try{
  const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('Foto inválida.'));im.src=url;});
  const c=document.createElement('canvas'),scale=Math.min(1,1250/Math.max(img.naturalWidth,img.naturalHeight));c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=c.getContext('2d');if(!ctx)throw Error('Não foi possível processar a imagem.');ctx.drawImage(img,0,0,c.width,c.height);
  const result=c.toDataURL('image/jpeg',0.73);if(result.length>1250000)throw Error('Foto muito grande. Tire outra com menor resolução.');return result;
 }finally{URL.revokeObjectURL(url);}}
async function refreshProof(id){const p=await request(`/api/orders/${id}/proof`);const el=$('#proofResult');if(el)el.innerHTML=`<strong>${p.has_photo?'Foto salva':'Sem foto'} · ${p.code_verified?'Código validado':'Código não validado'}</strong>${p.has_photo?`<p><a class="btn btn-outline" href="${p.photo_url}" target="_blank" rel="noopener noreferrer">Visualizar foto privada</a></p>`:''}`;}
let gpsWatchId=null,gpsLastSent=0;
async function toggleGPS(){
 if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;try{await request('/api/gps',{method:'DELETE',body:{}});}catch(e){toast(e.message,'error');}render();toast('Compartilhamento de localização interrompido.');return;}
 if(!navigator.geolocation||!window.isSecureContext){toast('GPS exige navegador compatível e conexão HTTPS.','error');return;}
 gpsLastSent=0;
 gpsWatchId=navigator.geolocation.watchPosition(async pos=>{if(Date.now()-gpsLastSent<15000)return;gpsLastSent=Date.now();
  try{await request('/api/gps',{method:'POST',body:{lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy_m:pos.coords.accuracy}});}catch(e){toast('Não foi possível enviar o GPS: '+e.message,'error');}
 },e=>{toast('Localização não autorizada: '+e.message,'error');if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;}render();},{enableHighAccuracy:true,maximumAge:15000,timeout:20000});render();toast('GPS ativado. Você pode interromper quando quiser.');
}
let boardReady=false,lastBoardIds=new Set(),notifying=false,refreshRunning=false;
let pushSubscribed=false,pushConfig=null;
const pushCompatible=()=>window.isSecureContext&&'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window;
function notificationControls(){
  if(isAdmin())return '';
  const enabled=pushSubscribed || (notifying&&Notification.permission==='granted');
  const label=pushSubscribed?'Push ativado':enabled?'Avisos nesta página':'Ativar notificações';
  return `<div class="push-controls"><button type="button" class="btn ${enabled?'btn-outline':'btn-primary'}" data-action="${enabled?'notify-disable':'notify-enable'}">${icon('bell')} ${label}</button>${pushSubscribed?`<button type="button" class="btn btn-outline" data-action="notify-test">Enviar teste</button>`:''}<small>${pushSubscribed?'Notificações push ativadas neste dispositivo.':'Ative para ser avisado sobre novos pedidos. Em celulares, autorize as notificações.'}</small></div>`;
}
function decodeVapidPublicKey(value){
  const padded=value+'='.repeat((4-value.length%4)%4);
  const str=atob(padded.replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(str,c=>c.charCodeAt(0));
}
async function enablePush(){
  if(isAdmin())return;
  if(!window.isSecureContext || !('Notification' in window))throw Error('Notificações exigem HTTPS e navegador compatível.');
  if(Notification.permission==='denied')throw Error('Notificações bloqueadas. Autorize o site nas configurações do navegador.');
  // Solicitar permissão diretamente após o toque do usuário.
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw Error('Permissão para avisos não concedida.');
  notifying=true;
  pushConfig=await request('/api/push/config');
  if(!pushConfig.enabled){render();toast('Avisos ativos somente enquanto a página estiver aberta. Para avisos em segundo plano, configure VAPID na Hostinger.');return;}
  if(!pushCompatible()){render();toast('Este navegador só permite avisos com a página aberta.','error');return;}
  const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  let subscription=await reg.pushManager.getSubscription();
  const requestedKey=decodeVapidPublicKey(pushConfig.publicKey);
  const priorKey=subscription?.options?.applicationServerKey;
  if(subscription && (!priorKey || new Uint8Array(priorKey).length!==requestedKey.length ||
      !Array.from(new Uint8Array(priorKey)).every((x,i)=>x===requestedKey[i]))){
    try{await request('/api/push/subscribe',{method:'DELETE',body:{endpoint:subscription.endpoint}});}catch{}
    await subscription.unsubscribe();subscription=null;
  }
  if(!subscription)subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:requestedKey});
  try {await request('/api/push/subscribe',{method:'POST',body:{subscription:subscription.toJSON()}});}
  catch(e){
    if(e.message.includes('outra conta')){
      await subscription.unsubscribe();subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeVapidPublicKey(pushConfig.publicKey)});
      await request('/api/push/subscribe',{method:'POST',body:{subscription:subscription.toJSON()}});
    }else throw e;
  }
  pushSubscribed=true;render();toast('Notificações push ativadas! Você receberá avisos de novas entregas.');
}
async function disablePush(){
  if(!isAdmin()&&pushCompatible()){
    const reg=await navigator.serviceWorker.getRegistration('/');
    const subscription=await reg?.pushManager?.getSubscription();
    if(subscription){try{await request('/api/push/subscribe',{method:'DELETE',body:{endpoint:subscription.endpoint}});}catch{}await subscription.unsubscribe();}
  }
  notifying=false;pushSubscribed=false;render();toast('Avisos desativados neste dispositivo.');
}
async function restorePush(){
  if(isAdmin()||!pushCompatible()||Notification.permission!=='granted')return;
  pushConfig=await request('/api/push/config');
  if(!pushConfig.enabled){notifying=true;return;}
  const reg=await navigator.serviceWorker.getRegistration('/');
  const subscription=await reg?.pushManager?.getSubscription();
  if(!subscription)return;
  const priorKey=subscription.options?.applicationServerKey;const key=decodeVapidPublicKey(pushConfig.publicKey);
  if(!priorKey||new Uint8Array(priorKey).length!==key.length||!Array.from(new Uint8Array(priorKey)).every((x,i)=>x===key[i]))return;
  await request('/api/push/subscribe',{method:'POST',body:{subscription:subscription.toJSON()}});
  notifying=true;pushSubscribed=true;
}

function notifyNewBoard(rows){const ids=new Set(rows.map(o=>o.id));if(boardReady&&state.user?.role==='rider'){
 const added=rows.filter(x=>!lastBoardIds.has(x.id));if(added.length){toast(`${added.length} nova(s) entrega(s) disponível(is)!`);
  if(notifying&&!pushSubscribed&&'Notification' in window&&Notification.permission==='granted'){new Notification('Nova entrega disponível • ⚡',{body:'Abra a central para visualizar e aceitar.',tag:'nova-entrega'});}
 }}boardReady=true;lastBoardIds=ids;
}
async function loadV2(){
 const [board,stores]=await Promise.all([request('/api/board'),request('/api/stores')]);state.board=board.orders;state.stores=stores.stores;notifyNewBoard(state.board);
 if(isAdmin()){
  if(state.view==='tracking')state.positions=(await request('/api/gps')).positions;
  if(state.view==='audit')state.audit=await request('/api/operations/audit');
 }else if(state.view==='history')state.history=await request('/api/rider/history');
}
async function refreshLive(){if(!state.user||refreshRunning||document.hidden)return;refreshRunning=true;try{const [orders,board]=await Promise.all([request('/api/orders'),request('/api/board')]);state.orders=orders.orders;state.board=board.orders;notifyNewBoard(board.orders);
 if(['dashboard','board','orders'].includes(state.view)&&$('#modalLayer').hidden&&!$('#orderSearch:focus'))render();
 }catch(e){if(e.message?.includes('login')){showLogin();}}finally{refreshRunning=false;}}
setInterval(refreshLive,8000);

const viewNames={dashboard:'Visão geral',board:'Central de entregas',orders:'Entregas',history:'Histórico e ganhos',stores:'Lojas e tarifas',tracking:'GPS da equipe',audit:'Auditoria',riders:'Entregadores',finance:'Financeiro',ifood:'Integração iFood',account:'Minha conta'};
function render() {
  $('#breadcrumbTitle').textContent=viewNames[state.view];
  $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===state.view));
  $('#navOrderCount').textContent=activeOrders().length;$('#navBoardCount').textContent=String((state.board||[]).length);$('#navHistory').hidden=isAdmin();
  $('#viewContent').innerHTML=({dashboard:viewDashboard,board:viewBoard,orders:viewOrders,history:viewHistory,stores:viewStores,tracking:viewTracking,audit:viewAudit,riders:viewRiders,finance:viewFinance,ifood:viewIfood,account:viewAccount}[state.view]||viewDashboard)();
}
async function loadData() {
  const results=await Promise.all([request('/api/orders'),...(isAdmin()?[request('/api/riders'),request('/api/ifood/status')]:[])]);
  state.orders=results[0].orders;
  if (isAdmin()){state.riders=results[1].riders;state.ifood=results[2];}
  if (state.view==='finance') await loadReport();
  await loadV2();
}
async function loadReport() {
  const params=new URLSearchParams(); if(state.reportFrom) params.set('from',state.reportFrom); if(state.reportTo) params.set('to',state.reportTo);
  state.report=await request('/api/report?'+params.toString());
}
async function changeView(view) {
  if (!viewNames[view] || (!isAdmin()&&['riders','finance','ifood','stores','tracking','audit'].includes(view)) || (isAdmin()&&view==='history'))return;
  state.view=view;closeNav();
  try {if(view==='finance'&&!state.report) await loadReport();await loadV2();render();}catch(e){toast(e.message,'error');}
}
function showShell(){
  $('#loginScreen').hidden=true;$('#appShell').hidden=false;
  $$('.admin-only').forEach(el=>el.hidden=!isAdmin());
  $('#topAvatar').textContent=initials(state.user.name);$('#topUser').textContent=state.user.name.split(' ')[0];
  $('#topRole').textContent=isAdmin()?'Administrador':'Entregador';
  $('#todayLabel').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'});
}
function showLogin(){pushSubscribed=false;notifying=false;pushConfig=null;if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;}boardReady=false;lastBoardIds=new Set();state.user=null;$('#appShell').hidden=true;$('#loginScreen').hidden=false;$('#loginPassword').value='';$('#loginOtp').value='';}
function openModal(title,content){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=content;$('#modalLayer').hidden=false;document.body.style.overflow='hidden';}
function closeModal(){ $('#modalLayer').hidden=true;document.body.style.overflow=''; }
function closeNav(){ $('#sidebar').classList.remove('open');$('#scrim').classList.remove('show'); }
function formField(name,label,value='',opts='') {return `<div class="form-field ${opts.includes('wide')?'wide':''}"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" value="${esc(value)}" ${opts.replace('wide','')} ${label.includes('*')?'required':''}></div>`;}
function openOrderForm(id) {
  if(!isAdmin())return;
  const o=state.orders.find(x=>x.id===id);
  if(o?.source==='ifood'){toast('Pedidos iFood são atualizados pelas notificações oficiais.','error');return;}
  const chooser=`<div class="form-field"><label for="field-rider">Entregador</label><select id="field-rider" name="rider_id"><option value="">Sem atribuição</option>${state.riders.filter(r=>r.active||r.id===o?.rider_id).map(r=>`<option value="${r.id}" ${o?.rider_id===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div>`;
  const html=`<form id="orderForm" data-id="${id||''}"><div class="form-grid">
    <div class="form-field wide"><label>Loja cadastrada</label><select name="store_id" id="orderStore"><option value="">Selecionar / preenchimento manual</option>${state.stores.filter(x=>x.active||x.id===o?.store_id).map(x=>`<option value="${x.id}" ${o?.store_id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
    ${formField('distance_km','Distância estimada (km)',o?.distance_km??'','type="number" min="0" max="300" step="0.1"')}
    <div class="form-field"><label><input type="checkbox" name="apply_distance_rate"> Calcular taxa e repasse pela tabela da loja</label></div>
    ${formField('merchant','Estabelecimento *',o?.merchant||'')}
    ${formField('customer_name','Nome do cliente *',o?.customer_name||'')}
    ${formField('customer_phone','Telefone do cliente',o?.customer_phone||'','type="tel" placeholder="(94) 9...."')}
    ${formField('neighborhood','Bairro',o?.neighborhood||'')}
    ${formField('pickup','Endereço da coleta *',o?.pickup||'','wide')}
    ${formField('dropoff','Endereço da entrega *',o?.dropoff||'','wide')}
    ${formField('fee','Taxa de entrega (R$) *',o?.fee??'','type="number" min="0" step="0.01"')}
    ${formField('payout','Repasse do entregador (R$) *',o?.payout??'','type="number" min="0" step="0.01"')}
    ${chooser}
    <div class="form-field"><label for="field-payment">Forma de pagamento</label><select id="field-payment" name="payment_method">${['Pix','Dinheiro','Cartão','Outro'].map(m=>`<option ${o?.payment_method===m?'selected':''}>${m}</option>`).join('')}</select></div>
    <div class="form-field wide"><label for="field-notes">Observações</label><textarea name="notes" id="field-notes" placeholder="Detalhes importantes para o entregador">${esc(o?.notes||'')}</textarea></div></div>
    <div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button type="submit" class="btn btn-primary">${icon('check')} ${id?'Salvar alterações':'Cadastrar entrega'}</button></div></form>`;
  openModal(id?'Editar entrega':'Nova entrega',html);
}
function openRiderForm() {
  if(!isAdmin())return;
  openModal('Cadastrar entregador',`<form id="riderForm"><div class="form-grid">${formField('name','Nome completo *','','wide')}${formField('username','Usuário de acesso *','','placeholder="Ex.: entregador01" pattern="[a-zA-Z0-9._-]{3,60}"')}${formField('phone','Telefone de contato','','type="tel" placeholder="(94) 9...."')}${formField('password','Senha provisória *','','wide type="password" minlength="12" autocomplete="new-password"')}</div><p class="footer-hint">Compartilhe a senha provisória com o entregador por um canal seguro e oriente a troca antes de usar o sistema em produção.</p><div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button type="submit" class="btn btn-primary">${icon('check')} Cadastrar</button></div></form>`);
}
function openPasswordForm(riderId=null) {
  if(riderId && !isAdmin())return;
  const fields=riderId
    ?`${formField('password','Nova senha (mínimo de 12 caracteres) *','','wide type="password" minlength="12" autocomplete="new-password"')}`
    :`${formField('current_password','Senha atual *','','wide type="password" autocomplete="current-password"')}${formField('new_password','Nova senha (mínimo de 12 caracteres) *','','wide type="password" minlength="12" autocomplete="new-password"')}`;
  openModal(riderId?'Redefinir senha do entregador':'Alterar minha senha',`<form id="passwordForm" data-id="${riderId||''}"><div class="form-grid">${fields}</div><p class="footer-hint">A alteração encerra as sessões anteriores. Utilize uma senha exclusiva e forte.</p><div class="modal-actions"><button type="button" class="btn btn-outline" data-close-modal>Cancelar</button><button type="submit" class="btn btn-primary">${icon('check')} Salvar nova senha</button></div></form>`);
}
async function savePassword(form) {
  const id=form.dataset.id;
  const values=Object.fromEntries(new FormData(form).entries());
  try {
    if(id){await request(`/api/riders/${id}/password`,{method:'PATCH',body:values});closeModal();toast('Senha do entregador redefinida.');}
    else{await request('/api/change-password',{method:'POST',body:values});await logout();toast('Senha alterada. Faça login novamente.');}
  }catch(e){toast(e.message,'error');}
}
function details(id) {
  const o=state.orders.find(x=>x.id===id); if(!o)return;
  const item=(label,value,wide=false)=>`<div class="detail-item ${wide?'wide':''}"><label>${label}</label><span>${esc(value||'—')}</span></div>`;
  const step=nextSteps[o.status];const canCancel=isAdmin()&&o.source!=='ifood'&&!['delivered','cancelled'].includes(o.status);
  const ifoodControl=o.source==='ifood'?`<div class="ifood-timeline"><div class="eyebrow">JORNADA DA ENTREGA NO IFOOD</div>${timelineStages.map((s,i)=>`<div class="ifood-timeline-item ${(stages[o.delivery_stage]&&timelineStages.indexOf(o.delivery_stage)>=i)?'done':''}"><span>${i+1}</span>${esc(stages[s])}</div>`).join('')}</div><p class="footer-hint">Último evento oficial: ${esc(o.ifood_event||'Nenhum')} ${o.pending_action?'· Aguardando confirmação: '+esc(o.pending_action):''}. ${o.delivered_by==='IFOOD'?'Entrega realizada por entregador iFood (acompanhamento apenas).':''}</p>`:'';
  const html=`<div class="details-grid">${item('Código do pedido',o.code)}<div class="detail-item"><label>Andamento</label>${displayBadge(o)}</div>${item('Estabelecimento',o.merchant)}${item('Cliente',o.customer_name)}${item('Telefone',o.customer_phone)}${item('Entregador',o.rider_name)}${item('Coleta',o.pickup,true)}${item('Destino',o.dropoff,true)}${item('Bairro',o.neighborhood)}${item('Pagamento',o.payment_method)}${isAdmin()?item('Taxa da entrega',brl(o.fee)):''}${item('Repasse ao entregador',brl(o.payout))}${item('Criado em',`${dates(o.created_at)} às ${time(o.created_at)}`)}${item('Concluído em',o.delivered_at?`${dates(o.delivered_at)} às ${time(o.delivered_at)}`:'—')}${o.notes?item('Observações',o.notes,true):''}</div>${ifoodControl}<div class="details-actions"><button type="button" class="btn btn-outline" data-action="proof" data-id="${o.id}">${icon('check')} Comprovante</button><button type="button" class="btn btn-outline" data-action="directions" data-id="${o.id}">${icon('map')} Abrir rota</button>${isAdmin()&&o.source!=='ifood'&&!['delivered','cancelled'].includes(o.status)?`<button type="button" class="btn btn-outline" data-action="edit-order" data-id="${o.id}">${icon('edit')} Editar</button>`:''}${o.source==='ifood'?ifoodActionButton(o):manualJourney(o)}${o.source==='ifood'&&!state.ifood?.configured&&isAdmin()?`<button class="btn btn-outline" data-action="ifood-demo-event" data-id="${o.id}">Simular notificação</button>`:''}${o.source==='ifood'&&isAdmin()?`<button class="btn btn-outline" data-action="ifood-settlement" data-id="${o.id}">Definir taxa/repasse</button>`:''}${canCancel?`<button type="button" class="btn btn-danger" data-action="status" data-id="${o.id}" data-status="cancelled">Cancelar entrega</button>`:''}</div>`;
  openModal('Pedido '+o.code,html);
}
async function doStatus(id,status) {
  if(status==='cancelled'&&!confirm('Deseja cancelar esta entrega? Esta ação não poderá ser desfeita.'))return;
  try {await request(`/api/orders/${id}/status`,{method:'PATCH',body:{status}});closeModal();await loadData();render();toast('Status atualizado com sucesso.');} catch(e){toast(e.message,'error');}
}
async function saveOrder(form) {
  const id=form.dataset.id;const data=Object.fromEntries(new FormData(form).entries());
  data.fee=Number(data.fee);data.payout=Number(data.payout);data.rider_id=data.rider_id||null;data.store_id=data.store_id||null;data.apply_distance_rate=form.elements.apply_distance_rate?.checked===true;
  try {await request(id?`/api/orders/${id}`:'/api/orders',{method:id?'PUT':'POST',body:data});closeModal();await loadData();render();toast(id?'Entrega atualizada.':'Entrega cadastrada.');}catch(e){toast(e.message,'error');}
}
async function saveRider(form) {
  try {await request('/api/riders',{method:'POST',body:Object.fromEntries(new FormData(form))});closeModal();await loadData();render();toast('Entregador cadastrado com sucesso.');}catch(e){toast(e.message,'error');}
}
async function toggleRider(id,active) {
  const verb=active?'ativar':'desativar'; if(!confirm(`Deseja ${verb} este entregador?`))return;
  try{await request(`/api/riders/${id}`,{method:'PATCH',body:{active:!!active}});await loadData();render();toast('Cadastro atualizado.');}catch(e){toast(e.message,'error');}
}
async function logout() {if(!isAdmin()&&pushSubscribed)try{await disablePush();}catch{}if(gpsWatchId!==null)try{await request('/api/gps',{method:'DELETE',body:{}});}catch{}try{await request('/api/logout',{method:'POST'});}catch{}showLogin();closeNav();closeModal();}
async function exportCSV(){
  try {const qs=new URLSearchParams();if(state.reportFrom)qs.set('from',state.reportFrom);if(state.reportTo)qs.set('to',state.reportTo);qs.set('format','csv');const resp=await fetch('/api/report?'+qs.toString(),{credentials:'same-origin'});if(!resp.ok)throw new Error('Falha ao exportar CSV');const blob=await resp.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='relatorio-entregas.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Relatório exportado.');}catch(e){toast(e.message,'error');}
}
document.addEventListener('click',async e=>{
  const close=e.target.closest('[data-close-modal]');if(close){closeModal();return;}
  const nav=e.target.closest('[data-view]');if(nav){await changeView(nav.dataset.view);return;}
  const a=e.target.closest('[data-action]');if(!a)return;
  const id=Number(a.dataset.id);
  switch(a.dataset.action){
    case 'refresh-board':await loadV2();render();break;
    case 'notify-enable':try{await enablePush();}catch(err){toast(err.message,'error');}break;
    case 'notify-disable':try{await disablePush();}catch(err){toast(err.message,'error');}break;
    case 'notify-test':try{const r=await request('/api/push/test',{method:'POST',body:{}});toast(r.sent?'Notificação enviada. Confira seu dispositivo.':'Teste solicitado, mas o serviço push não confirmou o envio.','ok');}catch(err){toast(err.message,'error');}break;
    case 'accept':try{const r=await request(`/api/orders/${id}/accept`,{method:'POST',body:{}});state.view='dashboard';await loadData();render();toast(r.awaiting_ifood?'Entrega reservada. Aguardando confirmação oficial do iFood.':'Entrega aceita! Ela agora está na sua área privada.');}catch(err){await loadV2();render();toast(err.message,'error');}break;
    case 'journey':try{await request(`/api/orders/${id}/journey`,{method:'PATCH',body:{stage:a.dataset.stage}});closeModal();await loadData();render();toast('Etapa registrada.');}catch(err){toast(err.message,'error');}break;
    case 'proof':openProof(id);break;
    case 'generate-proof':try{if(!confirm('Gerar novo código de entrega? O código anterior será invalidado.'))break;const v=await request(`/api/orders/${id}/proof/code`,{method:'POST',body:{}});const area=$('#proofResult');if(area)area.innerHTML='<strong>Código gerado (será mostrado uma única vez):</strong> <span class="one-time-code">'+esc(v.code)+'</span><p>Compartilhe com o cliente por canal seguro, nunca com o entregador.</p>'; }catch(err){toast(err.message,'error');}break;
    case 'check-proof':try{await refreshProof(id);}catch(err){toast(err.message,'error');}break;
    case 'new-store':storeModal();break;
    case 'store-edit':storeModal(state.stores.find(x=>x.id===id));break;
    case 'store-access':await storeAccess(id);break;
    case 'toggle-gps':await toggleGPS();break;
    case 'refresh-gps':state.positions=(await request('/api/gps')).positions;render();break;
    case 'refresh-audit':state.audit=await request('/api/operations/audit');render();break;
    case 'new-order':openOrderForm();break;
    case 'refresh-ifood':await loadData();render();toast('Painel atualizado.');break;
    case 'poll-ifood':try{const r=await request('/api/ifood/poll',{method:'POST'});await loadData();render();toast(`${r.received||0} evento(s) consultado(s).`);}catch(err){toast(err.message,'error');}break;
    case 'simulate-ifood':try{const r=await request('/api/ifood/demo-order',{method:'POST',body:{}});await loadData();render();details(r.id);toast('Pedido demonstrativo iFood criado.');}catch(err){toast(err.message,'error');}break;
    case 'add-ifood-store':openIfoodStoreForm();break;
    case 'ifood-assign':openIfoodAssign(id);break;
    case 'ifood-stage':await doIfoodAction(id,a.dataset.stage);break;
    case 'ifood-demo-event':openModal('Simular notificação do iFood',`<div class="demo-events">${demoEventOptions.map(x=>`<button type="button" class="btn btn-outline" data-action="send-demo-event" data-id="${id}" data-event="${x}">${x}</button>`).join('')}</div><p class="footer-hint">Os eventos acima são simulados para testar a interface. Não representam pedidos reais.</p>`);break;
    case 'send-demo-event':await demoIfoodEvent(id,a.dataset.event);break;
    case 'ifood-settlement':{const o=state.orders.find(x=>x.id===id);openModal('Taxa e repasse do pedido iFood',`<form id="ifoodSettlementForm" data-id="${id}"><div class="form-grid">${formField('fee','Taxa da entrega (R$) *',o?.fee||0,'type="number" min="0" step="0.01"')}${formField('payout','Repasse do entregador (R$) *',o?.payout||0,'type="number" min="0" step="0.01"')}</div><p class="footer-hint">Valores financeiros de gestão interna. Não alteram a cobrança do pedido no iFood.</p><div class="modal-actions"><button type="submit" class="btn btn-primary">Salvar</button></div></form>`);break;}
    case 'view-order':details(id);break;
    case 'edit-order':openOrderForm(id);break;
    case 'new-rider':openRiderForm();break;
    case 'reset-rider':openPasswordForm(id);break;
    case 'change-password':openPasswordForm();break;
    case 'status':await doStatus(id,a.dataset.status);break;
    case 'toggle-rider':await toggleRider(id,Number(a.dataset.active));break;
    case 'logout':await logout();break;
    case 'csv':await exportCSV();break;
    case 'clear-report':state.reportFrom='';state.reportTo='';await loadReport();render();break;
    case 'directions':{
      const o=state.orders.find(x=>x.id===id);if(!o)return;
      const url=`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o.pickup)}&destination=${encodeURIComponent(o.dropoff)}&travelmode=driving`;
      window.open(url,'_blank','noopener,noreferrer');break;
    }
  }
});
document.addEventListener('input',e=>{if(e.target.id==='orderSearch'){state.query=e.target.value;$('#ordersResult').innerHTML=filteredOrderTable();}});
document.addEventListener('change',e=>{if(e.target.id==='statusFilter'){state.status=e.target.value;$('#ordersResult').innerHTML=filteredOrderTable();}});
document.addEventListener('submit',async e=>{
  const f=e.target;if(!['loginForm','orderForm','riderForm','reportForm','passwordForm','ifoodStoreForm','ifoodAssignForm','ifoodSettlementForm','storeForm','storeAccessForm','photoProofForm','codeProofForm'].includes(f.id))return;e.preventDefault();
  const btn=f.querySelector('[type=submit]');if(btn)btn.disabled=true;
  try {
    if(f.id==='loginForm'){
      $('#loginError').hidden=true;
      try{const res=await request('/api/login',{method:'POST',body:{username:$('#loginUser').value,password:$('#loginPassword').value,otp:$('#loginOtp').value}});state.user=res.user;state.view=new URLSearchParams(location.search).get('view')==='board'?'board':'dashboard';await loadData();showShell();await restorePush().catch(()=>{});render();$('#loginPassword').value='';$('#loginOtp').value='';$('#loginOtp').value='';}catch(err){$('#loginError').textContent=err.message;$('#loginError').hidden=false;}
    }else if(f.id==='storeForm'){
      const id=f.dataset.id;const body=Object.fromEntries(new FormData(f));
      if(id){for(const key of ['base_fee','per_km','rider_base','rider_per_km'])body[key]=Number(body[key]);body.restricted=!!f.elements.restricted.checked;body.active=!!f.elements.active.checked;}
      await request(id?`/api/stores/${id}`:'/api/stores',{method:id?'PATCH':'POST',body});closeModal();await loadData();render();toast('Estabelecimento salvo.');
    }else if(f.id==='storeAccessForm'){
      const id=f.dataset.id;const ids=[...f.querySelectorAll('input[name=rider_ids]:checked')].map(x=>Number(x.value));
      await request(`/api/stores/${id}/access`,{method:'PUT',body:{rider_ids:ids,restricted:f.elements.restricted.checked}});closeModal();await loadData();render();toast('Permissões atualizadas.');
    }else if(f.id==='photoProofForm'){
      const image=await readProofImage(f.elements.photo.files[0]);await request(`/api/orders/${f.dataset.id}/proof/photo`,{method:'POST',body:{image}});await refreshProof(Number(f.dataset.id));toast('Foto salva com segurança.');
    }else if(f.id==='codeProofForm'){
      await request(`/api/orders/${f.dataset.id}/proof/verify`,{method:'POST',body:{code:f.elements.code.value}});f.elements.code.value='';await refreshProof(Number(f.dataset.id));toast('Código validado!');
    }else if(f.id==='ifoodStoreForm'){
      await request('/api/ifood/stores',{method:'POST',body:Object.fromEntries(new FormData(f))});closeModal();await loadData();render();toast('Loja registrada no painel.');
    }else if(f.id==='ifoodAssignForm'){
      const id=f.dataset.id;const dest=state.ifood?.configured?`/api/orders/${id}/ifood/assign`:`/api/orders/${id}/ifood/demo-assign`;
      const reply=await request(dest,{method:'POST',body:Object.fromEntries(new FormData(f))});closeModal();await loadData();render();toast(reply.message||'Entregador atribuído.');
    }else if(f.id==='ifoodSettlementForm'){
      const id=f.dataset.id;await request(`/api/orders/${id}/ifood/settlement`,{method:'PATCH',body:{fee:Number(f.elements.fee.value),payout:Number(f.elements.payout.value)}});closeModal();await loadData();render();toast('Valores atualizados.');
    }else if(f.id==='orderForm')await saveOrder(f);
    else if(f.id==='riderForm')await saveRider(f);
    else if(f.id==='passwordForm')await savePassword(f);
    else if(f.id==='reportForm'){
      state.reportFrom=$('#reportFrom').value;state.reportTo=$('#reportTo').value;
      if(state.reportFrom&&state.reportTo&&state.reportFrom>state.reportTo)throw new Error('A data inicial deve ser anterior à data final.');
      await loadReport();render();
    }
  } catch(err){toast(err.message,'error');}finally{if(btn?.isConnected)btn.disabled=false;}
});
$('#mobileMenu').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#scrim').classList.add('show');});
$('#scrim').addEventListener('click',closeNav);
$('#logoutButton').addEventListener('click',logout);
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.type==='open_board'&&state.user)changeView('board');});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
$('#copyrightYear').textContent=new Date().getFullYear();
(async()=>{
  try {const info=await request('/api/me');state.user=info.user;state.view=new URLSearchParams(location.search).get('view')==='board'?'board':'dashboard';await loadData();showShell();await restorePush().catch(()=>{});render();}
  catch{showLogin();}
})();
