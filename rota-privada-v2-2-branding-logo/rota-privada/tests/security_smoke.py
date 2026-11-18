from pathlib import Path
import os,tempfile,subprocess,urllib.request,urllib.error,json,time,socket,sys,hmac,hashlib,struct
root=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));PORT=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory() as d:
    key='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    def otp():
        import base64
        secret=base64.b32decode(key);counter=int(time.time()//30)
        digest=hmac.new(secret,struct.pack('>Q',counter),hashlib.sha1).digest()
        offset=digest[-1]&15
        return f'{(struct.unpack(">I",digest[offset:offset+4])[0]&0x7fffffff)%1000000:06d}'
    env=dict(os.environ,PORT=str(PORT),NODE_ENV='production',ADMIN_TOTP_SECRET=key,PUBLIC_ORIGIN='https://entregas.example.com',ADMIN_USER='operador',ADMIN_PASSWORD='UmaSenhaMuito@Segura2026',DB_PATH=str(Path(d)/'security.sqlite'))
    p=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def ask(route,method='GET',data=None,cookie=None,csrf=False,origin=None):
        headers={}
        if data is not None: headers['Content-Type']='application/json'
        if csrf: headers['X-Requested-With']='XMLHttpRequest'
        if cookie: headers['Cookie']=cookie
        if origin:headers['Origin']=origin
        req=urllib.request.Request('http://127.0.0.1:'+str(PORT)+route,data=None if data is None else json.dumps(data).encode(),headers=headers,method=method)
        try:r=urllib.request.urlopen(req,timeout=3)
        except urllib.error.HTTPError as e:r=e
        body=r.read().decode(errors='replace')
        return r.status, dict(r.headers),body
    try:
        for i in range(80):
            if p.poll() is not None:raise RuntimeError('server died: '+p.stderr.read())
            try: status,head,body=ask('/');break
            except Exception: time.sleep(.08)
        assert status==200,(status,body)
        assert "frame-ancestors 'none'" in head['Content-Security-Policy']
        assert 'Strict-Transport-Security' in head
        assert ask('/api/orders')[0]==401
        # CSRF blocked including login without custom header
        assert ask('/api/login','POST',{'username':'operador','password':'UmaSenhaMuito@Segura2026'})[0]==403
        assert ask('/api/login','POST',{'username':'operador','password':'UmaSenhaMuito@Segura2026','otp':otp()},csrf=True,origin='https://attacker.com')[0]==403
        assert ask('/api/login','POST',{'username':'operador','password':'UmaSenhaMuito@Segura2026','otp':'000000'},csrf=True)[0]==401
        status,head,body=ask('/api/login','POST',{'username':'operador','password':'UmaSenhaMuito@Segura2026','otp':otp()},csrf=True)
        assert status==200,(status,body)
        cookie=head.get('Set-Cookie','').split(';')[0]
        assert ask('/api/login','POST',{'username':'operador','password':'UmaSenhaMuito@Segura2026','otp':otp()},csrf=True)[0]==401, 'TOTP replay should fail'
        assert 'SameSite=Strict' in head['Set-Cookie'] and 'Secure' in head['Set-Cookie']
        assert ask('/api/ifood/status',cookie=cookie)[0]==200
        assert ask('/api/riders','POST',{'name':'Test Motoboy','username':'testemotoboy','password':'short'},cookie=cookie,csrf=True)[0]==400
        assert ask('/api/riders','POST',{'name':'Test Motoboy','username':'testemotoboy','password':'SenhaRiderForte2026'},cookie=cookie,csrf=True)[0]==201
        status,head,body=ask('/api/login','POST',{'username':'testemotoboy','password':'SenhaRiderForte2026'},csrf=True)
        assert status==200,(status,body)
        rcookie=head['Set-Cookie'].split(';')[0]
        assert ask('/api/riders',cookie=rcookie)[0]==403
        assert ask('/api/orders','POST',{'merchant':'Loja','customer_name':'Alguem','pickup':'A','dropoff':'B','fee':15,'payout':10,'rider_id':2},cookie=cookie,csrf=True)[0]==201
        status,head,body=ask('/api/orders',cookie=rcookie)
        assert status==200,(status,body)
        obj=json.loads(body)['orders'][0]
        assert obj.get('payout')==10 and 'fee' not in obj and 'fee_cents' not in obj,obj
        assert ask('/api/orders','POST',{'merchant':'Fake'},cookie=rcookie,csrf=True)[0]==403
        assert ask('/webhooks/ifood','POST',{})[0]==503
        print('PASS: admin MFA anti-replay, cookies, CSRF, RBAC, iFood webhook, headers, password length, rider revenue isolation')
    finally:
        p.terminate()
        try:out,err=p.communicate(timeout=3)
        except: p.kill();out,err=p.communicate()
        print('server:',out.strip(),err.strip()[:900])
