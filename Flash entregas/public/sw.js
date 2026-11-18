'use strict';
// Sem cache de conteúdo autenticado: apenas avisos push e abertura da Central.
self.addEventListener('push',event=>{
  let payload={};
  try {payload=event.data?.json()||{};}catch{}
  const isNew=payload.type==='new_delivery';
  const orderId=Number(payload.orderId)||0;
  const title=isNew?'Flash Entregas • Nova entrega':'Flash Entregas — notificações ativadas';
  const body=isNew?'Toque para visualizar e aceitar no Flash Entregas.':'Seu dispositivo pode receber avisos de novas entregas.';
  event.waitUntil(self.registration.showNotification(title,{
    body,icon:'/brand/logo-symbol-192.png',badge:'/brand/logo-symbol-192.png',
    tag:isNew?'rota-pedido-'+orderId:'rota-push-teste',
    renotify:true,requireInteraction:isNew,
    data:{url:'/?view=board'},
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const clientsList=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clientsList){
      if(new URL(client.url).origin===self.location.origin){
        await client.focus();client.postMessage({type:'open_board'});return;
      }
    }
    await clients.openWindow('/?view=board');
  })());
});
