from pathlib import Path
import os,tempfile,subprocess,urllib.request,urllib.error,json,time,socket,base64
root=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory() as d:
    env={**os.environ,'PORT':str(port),'DB_PATH':str(Path(d)/'flash.sqlite')}
    process=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def ask(path,method='GET',body=None,cookie=None):
        headers={}
        if body is not None:headers.update({'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'})
        if cookie:headers['Cookie']=cookie
        req=urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        try:r=urllib.request.urlopen(req,timeout=6)
        except urllib.error.HTTPError as e:r=e
        payload=r.read()
        try:payload=json.loads(payload)
        except:pass
        return r.status,dict(r.headers),payload
    try:
        for i in range(80):
            try:ask('/');break
            except Exception:time.sleep(.09)
        assert ask('/manifest.webmanifest')[2]['name']=='Flash Entregas'
        assert b'Flash Entregas' in ask('/')[2]
        assert 'cdn.jsdelivr.net' in ask('/')[1]['Content-Security-Policy']
        assert 'tile.openstreetmap.org' in ask('/')[1]['Content-Security-Policy']
        def login(user,pw):
            code,headers,_=ask('/api/login','POST',{'username':user,'password':pw});assert code==200,code;return headers['Set-Cookie'].split(';')[0]
        admin=login('admin','Admin@123456')
        rider=login('lucas','Entregador@123')
        outsider=login('mariana','Entregador@123')
        code,_,created=ask('/api/orders','POST',{'merchant':'Flash Loja','customer_name':'Cliente','pickup':'Rua A','dropoff':'Rua B','fee':12,'payout':8},admin)
        assert code==201,created
        order=created['id']
        # assigned rider can attach proof post delivery
        assert ask(f'/api/orders/{order}/accept','POST',{},rider)[0]==200
        for step in ['going_origin','at_origin','picked_up','on_route','at_destination']:
            c,h,b=ask(f'/api/orders/{order}/journey','PATCH',{'stage':step},rider);assert c==200,(step,c,b)
        # Basic tiny valid JPEG, sent as a browser-converted photo
        from PIL import Image
        import io
        im=Image.new('RGB',(300,220),(255,212,0));buf=io.BytesIO();im.save(buf,format='JPEG',quality=80)
        encoded='data:image/jpeg;base64,'+base64.b64encode(buf.getvalue()).decode()
        assert ask(f'/api/orders/{order}/proof/photo','POST',{'image':encoded},rider)[0]==201
        assert ask(f'/api/orders/{order}/journey','PATCH',{'stage':'delivered'},rider)[0]==200
        # Rider is allowed to add/replace photo after completion (within 72 h)
        assert ask(f'/api/orders/{order}/proof/photo','POST',{'image':encoded},outsider)[0]==404
        c,_,payload=ask(f'/api/orders/{order}/proof/photo','POST',{'image':encoded},rider);assert c==201,(c,payload)
        c,_,p=ask(f'/api/orders/{order}/proof',cookie=rider);assert c==200 and p['has_photo']
        assert ask(f'/api/orders/{order}/proof/image',cookie=outsider)[0]==404
        assert ask(f'/api/orders/{order}/proof/image',cookie=admin)[0]==200
        # active rider GPS visible only to admin, updated in same row
        assert ask('/api/gps','POST',{'lat':-6.06,'lng':-49.9,'accuracy_m':20},rider)[0]==200
        assert ask('/api/gps','POST',{'lat':-6.061,'lng':-49.901,'accuracy_m':8},rider)[0]==200
        assert ask('/api/gps',cookie=outsider)[0]==403
        status,_,gps=ask('/api/gps',cookie=admin);assert status==200 and len(gps['positions'])==1 and gps['positions'][0]['lat']==-6.061
        assert ask('/api/gps','DELETE',{},rider)[0]==200
        assert ask('/api/gps',cookie=admin)[2]['positions']==[]
        # persistent proofs alongside sqlite location
        assert len(list(Path(d,'proofs').glob('*.jpg')))==1
        print('PASS: Flash Entregas branding, map CSP, post-delivery proof, private photo RBAC, GPS position refresh and cleanup')
    finally:
        process.terminate()
        try:o,e=process.communicate(timeout=5)
        except:process.kill();o,e=process.communicate()
        if process.returncode not in (None,0,-15):print('server stderr:',e[-700:])
