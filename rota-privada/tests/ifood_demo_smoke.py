from pathlib import Path
import os,tempfile,subprocess,socket,time,urllib.request,urllib.error,json
root=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
with tempfile.TemporaryDirectory() as td:
 env=dict(os.environ,PORT=str(port),DB_PATH=f'{td}/dev.sqlite');env.pop('NODE_ENV',None);env.pop('ADMIN_TOTP_SECRET',None)
 p=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 def req(route,method='GET',obj=None,cookie=''):
  headers={}
  if obj is not None:headers['Content-Type']='application/json'
  if method!='GET':headers['X-Requested-With']='XMLHttpRequest'
  if cookie:headers['Cookie']=cookie
  try:r=urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}{route}',data=json.dumps(obj).encode() if obj is not None else None,headers=headers,method=method),timeout=3)
  except urllib.error.HTTPError as x:r=x
  return r.status,dict(r.headers),json.loads(r.read())
 try:
  for _ in range(80):
   try: req('/api/me');break
   except: time.sleep(.1)
  code,h,b=req('/api/login','POST',{'username':'admin','password':'Admin@123456'});assert code==200,(code,b)
  cookie=h['Set-Cookie'].split(';')[0]
  code,h,b=req('/api/ifood/demo-order','POST',{'merchant':'Loja teste','dropoff':'Avenida das Entregas, 44'},cookie);assert code==201,(code,b)
  oid=b['id']
  code,h,b=req(f'/api/orders/{oid}/ifood/demo-assign','POST',{'rider_id':2},cookie);assert code==200,(code,b)
  for event,stage in [('GOING_TO_ORIGIN','going_origin'),('ARRIVED_AT_ORIGIN','at_origin'),('COLLECTED','picked_up'),('DISPATCHED','on_route'),('ARRIVED_AT_DESTINATION','at_destination'),('CONCLUDED','delivered')]:
   code,h,b=req(f'/api/orders/{oid}/ifood/demo-stage','POST',{'event':event},cookie);assert code==200,(event,code,b)
   code,h,b=req('/api/orders',cookie=cookie)
   obj=next(x for x in b['orders'] if x['id']==oid)
   assert obj['delivery_stage']==stage,(event,obj['delivery_stage'])
  print('PASS: iFood simulated order + assignment + full logistics status progression')
 finally:
  p.terminate();p.wait(timeout=3)
