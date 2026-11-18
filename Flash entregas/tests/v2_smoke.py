from pathlib import Path
import os,tempfile,subprocess,urllib.request,urllib.error,json,time,socket,base64,io,struct,zlib
root=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));PORT=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory() as d:
    env={**os.environ,'PORT':str(PORT),'DB_PATH':str(Path(d)/'v2.sqlite')}
    process=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def ask(path,method='GET',data=None,cookie=None):
        headers={}
        if data is not None:headers['Content-Type']='application/json';headers['X-Requested-With']='XMLHttpRequest'
        if cookie:headers['Cookie']=cookie
        request=urllib.request.Request(f'http://127.0.0.1:{PORT}'+path,data=None if data is None else json.dumps(data).encode(),headers=headers,method=method)
        try:r=urllib.request.urlopen(request,timeout=6)
        except urllib.error.HTTPError as e:r=e
        body=r.read()
        try:payload=json.loads(body)
        except:payload=body
        return r.status,dict(r.headers),payload
    try:
        for _ in range(90):
            try:ask('/');break
            except:time.sleep(.08)
        def login(username,password):
            code,head,body=ask('/api/login','POST',{'username':username,'password':password})
            assert code==200,(code,body)
            return head['Set-Cookie'].split(';')[0]
        admin=login('admin','Admin@123456')
        lucas=login('lucas','Entregador@123')
        mariana=login('mariana','Entregador@123')
        assert ask('/api/stores',cookie=admin)[0]==200
        code,_,body=ask('/api/stores','POST',{'name':'Loja Oficial V2','pickup':'Rua Primeiro, 123'},admin)
        assert code==201,body
        store=body['id']
        code,_,body=ask(f'/api/stores/{store}','PATCH',{'name':'Loja Oficial V2','pickup':'Rua Primeiro, 123','base_fee':12,'per_km':2,'rider_base':7,'rider_per_km':1,'restricted':True},admin)
        assert code==200,(code,body)
        assert ask(f'/api/stores/{store}/access','PUT',{'rider_ids':[2],'restricted':True},admin)[0]==200
        code,_,body=ask('/api/orders','POST',{'store_id':store,'apply_distance_rate':True,'distance_km':3.5,'merchant':'Loja Oficial V2','customer_name':'Cliente Privado','pickup':'Rua Primeiro, 123','dropoff':'Rua Segundo, 55','neighborhood':'Centro','fee':0,'payout':0},admin)
        assert code==201,(code,body)
        order=body['id']
        assert all(x['id']!=order for x in ask('/api/board',cookie=mariana)[2]['orders'])
        offered=next(x for x in ask('/api/board',cookie=lucas)[2]['orders'] if x['id']==order)
        assert 'customer_name' not in offered and offered['payout']==10.5,offered
        assert ask(f'/api/orders/{order}/accept','POST',{},mariana)[0]==409
        assert ask(f'/api/orders/{order}/accept','POST',{},lucas)[0]==200
        assert ask(f'/api/orders/{order}/accept','POST',{},lucas)[0]==409
        assert order not in [x['id'] for x in ask('/api/board',cookie=lucas)[2]['orders']]
        assert order not in [x['id'] for x in ask('/api/orders',cookie=mariana)[2]['orders']]
        assert ask(f'/api/orders/{order}/journey','PATCH',{'stage':'at_origin'},lucas)[0]==409
        for stage in ('going_origin','at_origin','picked_up','on_route','at_destination'):
            code,_,body=ask(f'/api/orders/{order}/journey','PATCH',{'stage':stage},lucas)
            assert code==200,(stage,code,body)
        assert ask(f'/api/orders/{order}/journey','PATCH',{'stage':'delivered'},lucas)[0]==409
        assert ask(f'/api/orders/{order}/proof/code','POST',{},lucas)[0]==403
        code,_,payload=ask(f'/api/orders/{order}/proof/code','POST',{},admin)
        assert code==200 and len(payload['code'])==8
        proof_code=payload['code']
        assert ask(f'/api/orders/{order}/proof/verify','POST',{'code':'00000000'},lucas)[0]==403
        assert ask(f'/api/orders/{order}/proof/verify','POST',{'code':proof_code},lucas)[0]==200
        assert ask(f'/api/orders/{order}/journey','PATCH',{'stage':'delivered'},lucas)[0]==200
        assert ask('/api/rider/history',cookie=lucas)[2]['total_earned']>=10.5
        # Only admin can list a rider's live position; each rider updates its own.
        assert ask('/api/gps','POST',{'lat':-6.06,'lng':-49.90,'accuracy_m':8},lucas)[0]==200
        assert ask('/api/gps',cookie=lucas)[0]==403
        assert ask('/api/gps',cookie=admin)[2]['positions'][0]['rider_id']==2
        assert ask('/api/gps','DELETE',{},lucas)[0]==200
        assert ask('/api/gps',cookie=admin)[2]['positions']==[]
        assert ask('/api/operations/audit',cookie=lucas)[0]==403
        audit=ask('/api/operations/audit',cookie=admin)[2]['events']
        assert any(e['action']=='order_accepted' for e in audit)
        # Save a private proof image for a second delivery.
        code,_,body=ask('/api/orders','POST',{'store_id':store,'customer_name':'Segundo Cliente','merchant':'Loja Oficial V2','pickup':'Rua Primeiro, 123','dropoff':'Rua Terceiro','fee':15,'payout':10},admin)
        order2=body['id']
        assert ask(f'/api/orders/{order2}/accept','POST',{},lucas)[0]==200
        # Gera uma imagem PNG válida apenas com a biblioteca padrão.
        width,height=80,80
        pixels=b''.join(bytes([0])+b''.join(bytes(((x*13+y*3)%256,(x*7+y*11)%256,(x*3+y*17)%256)) for x in range(width)) for y in range(height))
        def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
        encoded='data:image/png;base64,'+base64.b64encode(png).decode()
        assert ask(f'/api/orders/{order2}/proof/photo','POST',{'image':encoded},mariana)[0]==404
        assert ask(f'/api/orders/{order2}/proof/photo','POST',{'image':encoded},lucas)[0]==201
        assert ask(f'/api/orders/{order2}/proof',cookie=lucas)[2]['has_photo']==True
        assert ask(f'/api/orders/{order2}/proof/image',cookie=mariana)[0]==404
        assert ask(f'/api/orders/{order2}/proof/image',cookie=lucas)[0]==200
        print('PASS: V2 migration, stores, km pricing, access control, atomic claim, journey, code/photo proofs, GPS, audit, rider history')
    finally:
        process.terminate()
        try:stdout,stderr=process.communicate(timeout=4)
        except:process.kill();stdout,stderr=process.communicate()
        print(stderr[:900])
