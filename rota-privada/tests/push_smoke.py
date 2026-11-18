from pathlib import Path
import os,tempfile,subprocess,urllib.request,urllib.error,json,time,socket,base64
root=Path(__file__).resolve().parents[1]
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
with tempfile.TemporaryDirectory() as d:
    generated=subprocess.check_output(['node','scripts/generate-vapid.mjs'],cwd=root,text=True)
    keys={x.split('=',1)[0]:x.split('=',1)[1] for x in generated.splitlines() if x.startswith('VAPID_')}
    capture=Path(d)/'capture.jsonl'
    env={**os.environ,'PORT':str(port),'DB_PATH':str(Path(d)/'test.sqlite'),'NODE_PATH':str(root/'tests'/'mock_modules'),
         'RP_PUSH_TEST_CAPTURE':str(capture),'VAPID_PUBLIC_KEY':keys['VAPID_PUBLIC_KEY'],
         'VAPID_PRIVATE_KEY':keys['VAPID_PRIVATE_KEY'],'VAPID_SUBJECT':'mailto:push-test@example.com'}
    process=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def ask(path,method='GET',data=None,cookie=None):
        hdr={}
        if cookie:hdr['Cookie']=cookie
        if data is not None:hdr['Content-Type']='application/json';hdr['X-Requested-With']='XMLHttpRequest'
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,method=method,headers=hdr,data=None if data is None else json.dumps(data).encode())
        try:r=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:r=e
        text=r.read()
        try:body=json.loads(text)
        except:body=text
        return r.status,dict(r.headers),body
    def login(username,password):
        status,h,b=ask('/api/login','POST',{'username':username,'password':password})
        assert status==200,(status,b)
        return h['Set-Cookie'].split(';')[0]
    def captured():
        return [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
    def await_count(n):
        for _ in range(60):
            if len(captured())>=n:return captured()
            time.sleep(.08)
        raise AssertionError(f'Esperava {n} disparos; recebi {captured()}')
    try:
        for i in range(70):
            if process.poll() is not None:raise RuntimeError('Servidor encerrou: '+process.stderr.read())
            try:ask('/');break
            except:time.sleep(.08)
        assert ask('/api/push/config')[0]==401
        admin=login('admin','Admin@123456')
        lucas=login('lucas','Entregador@123')
        mariana=login('mariana','Entregador@123')
        assert ask('/api/push/config',cookie=admin)[0]==403
        status,_,config=ask('/api/push/config',cookie=lucas)
        assert status==200 and config['enabled'] and config['publicKey']==keys['VAPID_PUBLIC_KEY']
        key=lambda b:base64.urlsafe_b64encode(bytes([b])*65).decode().rstrip('=')
        auth=base64.urlsafe_b64encode(bytes(range(16))).decode().rstrip('=')
        def sub(i):return {'endpoint':f'https://fcm.googleapis.com/fcm/send/test_{i}', 'keys':{'p256dh':key(i),'auth':auth}}
        assert ask('/api/push/subscribe','POST',{'subscription':sub(1)},admin)[0]==403
        assert ask('/api/push/subscribe','POST',{'subscription':{'endpoint':'https://127.0.0.1/private', 'keys':sub(1)['keys']}},lucas)[0]==400
        assert ask('/api/push/subscribe','POST',{'subscription':sub(1)},lucas)[0]==200
        assert ask('/api/push/subscribe','POST',{'subscription':sub(1)},mariana)[0]==409
        assert ask('/api/push/subscribe','POST',{'subscription':sub(2)},mariana)[0]==200
        s,h,b=ask('/api/stores','POST',{'name':'Loja Teste Push','pickup':'Rua Um'},admin)
        assert s==201,(s,b)
        store=b['id']
        s,h,b=ask(f'/api/stores/{store}','PATCH',{'name':'Loja Teste Push','pickup':'Rua Um','base_fee':10,'per_km':1,'rider_base':7,'rider_per_km':1,'restricted':True},admin)
        assert s==200,(s,b)
        assert ask(f'/api/stores/{store}/access','PUT',{'rider_ids':[2],'restricted':True},admin)[0]==200
        s,h,b=ask('/api/orders','POST',{'merchant':'Loja Teste Push','customer_name':'Cliente Não Mostrar','store_id':store,'pickup':'Rua Um','dropoff':'Rua Sigilosa','fee':15,'payout':10},admin)
        assert s==201,(s,b)
        msgs=await_count(1)
        assert len(msgs)==1 and msgs[0]['endpoint']==sub(1)['endpoint']
        payload=msgs[0]['payload']
        assert payload['type']=='new_delivery' and payload['orderId']==b['id']
        assert 'Cliente' not in str(payload) and 'Sigilosa' not in str(payload)
        assert ask(f'/api/stores/{store}/access','PUT',{'rider_ids':[2,3],'restricted':True},admin)[0]==200
        s,h,b=ask('/api/orders','POST',{'merchant':'Loja Teste Push','customer_name':'Cliente B','store_id':store,'pickup':'Rua Um','dropoff':'Rua Dois','fee':12,'payout':8},admin)
        assert s==201,(s,b)
        msgs=await_count(3)
        assert set(m['endpoint'] for m in msgs[1:3])=={sub(1)['endpoint'],sub(2)['endpoint']}
        # Um motoboy não pode remover a inscrição de outro.
        assert ask('/api/push/subscribe','DELETE',{'endpoint':sub(2)['endpoint']},lucas)[0]==200
        assert ask('/api/push/config',cookie=mariana)[2]['devices']==1
        assert ask('/api/push/test','POST',{},lucas)[0]==202
        assert ask('/api/push/test','POST',{},lucas)[0]==429
        assert ask('/api/push/subscribe','DELETE',{'endpoint':sub(1)['endpoint']},lucas)[0]==200
        assert ask('/api/push/config',cookie=lucas)[2]['devices']==0
        assert ask('/sw.js')[0]==200 and ask('/manifest.webmanifest')[0]==200
        print('PASS: VAPID config, opt-in por dispositivo, bloqueio SSRF/RBAC, permissão por loja, fan-out, privacidade e teste push')
    finally:
        process.terminate()
        try:out,err=process.communicate(timeout=5)
        except:process.kill();out,err=process.communicate()
        if err.strip():print(err.strip()[:600])
