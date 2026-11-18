import crypto from 'node:crypto';
const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pub=publicKey.export({format:'jwk'});
const priv=privateKey.export({format:'jwk'});
const key=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')]);
console.log('VAPID_PUBLIC_KEY='+key.toString('base64url'));
console.log('VAPID_PRIVATE_KEY='+priv.d);
console.log('VAPID_SUBJECT=mailto:SEU_EMAIL_DE_CONTATO@DOMINIO.COM');
console.log('\nGuarde a chave privada apenas nas variáveis de ambiente da Hostinger. Não publique no GitHub.');
