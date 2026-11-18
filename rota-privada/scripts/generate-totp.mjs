import crypto from 'node:crypto';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bytes=crypto.randomBytes(20);let bits=0,value=0,secret='';
for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){secret+=alphabet[(value>>>(bits-=5))&31];}}
if(bits>0)secret+=alphabet[(value<<(5-bits))&31];
const username=process.env.ADMIN_USER||'administrador';
const uri=`otpauth://totp/${encodeURIComponent('Rota Privada:'+username)}?secret=${secret}&issuer=${encodeURIComponent('Rota Privada')}&algorithm=SHA1&digits=6&period=30`;
console.log('CHAVE BASE32 (guardar em cofre de senhas): '+secret);
console.log('URI PARA CONFIGURAR O AUTENTICADOR (também é confidencial): '+uri);
