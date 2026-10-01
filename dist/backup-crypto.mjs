// Optional portable encryption. This protects exported files at rest, not a
// running unlocked app from malicious scripts or an already compromised device.
const BACKUP_FORMAT='rebate-encrypted',ITERATIONS=600000,MAX_BYTES=100*1024*1024;
const metadata={format:BACKUP_FORMAT,version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,cipher:'AES-256-GCM'};
const utf8=new TextEncoder();
function secureCrypto(){if(!globalThis.crypto?.subtle)throw Error('加密备份需要 HTTPS 或本机安全环境');return globalThis.crypto}
function passwordBytes(password){if(typeof password!=='string'||password.length<8||password.length>1024)throw Error('备份口令需为 8–1024 个字符');return utf8.encode(password)}
function to64(bytes){let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw)}
function from64(text,max){if(typeof text!=='string'||text.length>Math.ceil(max/3)*4||text.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('加密备份格式错误');let raw;try{raw=atob(text)}catch{throw Error('加密备份格式错误')}return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function derive(password,salt,usage){const crypto=secureCrypto(),secret=passwordBytes(password);try{const base=await crypto.subtle.importKey('raw',secret,'PBKDF2',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,[usage])}finally{secret.fill(0)}}
export function isEncryptedBackup(data){return data?.format===BACKUP_FORMAT}
export async function encryptBackup(data,password){
 const crypto=secureCrypto(),plaintext=utf8.encode(JSON.stringify(data));if(plaintext.byteLength>MAX_BYTES)throw Error('备份超过 100MB，请缩小导出范围');
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await derive(password,salt,'encrypt');
 try{const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(metadata)),tagLength:128},key,plaintext));return {...metadata,salt:to64(salt),iv:to64(iv),data:to64(ciphertext)}}finally{plaintext.fill(0)}
}
export async function decryptBackup(envelope,password){
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).some(k=>![...Object.keys(metadata),'salt','iv','data'].includes(k))||Object.entries(metadata).some(([k,v])=>envelope[k]!==v))throw Error('不支持的加密备份格式');
 const salt=from64(envelope.salt,16),iv=from64(envelope.iv,12),data=from64(envelope.data,MAX_BYTES+16);if(salt.length!==16||iv.length!==12||data.length<16||data.length>MAX_BYTES+16)throw Error('加密备份格式错误');
 const key=await derive(password,salt,'decrypt');let plaintext;
 try{plaintext=new Uint8Array(await secureCrypto().subtle.decrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(metadata)),tagLength:128},key,data))}catch{throw Error('口令不正确或备份文件已被修改')}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext))}catch{throw Error('加密备份内容不是有效 JSON')}finally{plaintext.fill(0)}
}
