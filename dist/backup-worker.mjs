import {encryptBackup,decryptBackup,isEncryptedBackup} from './backup-crypto.mjs';
import {validateHistoryBackup,validateSettingsBackup,validateAllowlistBackup,validateState} from './validation.mjs';
const MAX=140*1024*1024;
async function readBounded(stream) {
  const reader=stream.getReader(),chunks=[];let bytes=0;
  for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX){await reader.cancel();throw Error('解压后文件超过 140 MB')}chunks.push(value)}
  return {text:await new Blob(chunks).text(),bytes};
}
self.onmessage=async({data})=>{
  try {
    if(data.type==='decode') {
      const file=data.file;if(file.size>MAX)throw Error('文件超过 140 MB');
      const magic=new Uint8Array(await file.slice(0,2).arrayBuffer());
      const stream=magic[0]===31&&magic[1]===139?file.stream().pipeThrough(new DecompressionStream('gzip')):file.stream();
      const decoded=await readBounded(stream);let value=JSON.parse(decoded.text);
      if(isEncryptedBackup(value))value=await decryptBackup(value,data.password||'');
      else if(decoded.bytes>100*1024*1024)throw Error('未加密备份明文超过 100 MB');
      if(data.kind==='settings')value=validateSettingsBackup(value);
      else if(data.kind==='allowlist')value=validateAllowlistBackup(value);
      else if(value.format==='rebate-history')value=validateHistoryBackup(value,{wallets:data.wallets,trustEvidence:false});
      else value={state:validateState({version:1,records:Array.isArray(value)?value:value.records,coverage:{},selected:[],updated:null},{wallets:data.wallets,trustEvidence:false})};
      self.postMessage({ok:true,value});
    } else if(data.type==='encode') {
      let value=data.value;
      if(new Blob([JSON.stringify(value)]).size>100*1024*1024)throw Error('备份明文超过 100 MB，请缩小历史范围');
      if(data.password)value=await encryptBackup(value,data.password);
      let blob=new Blob([JSON.stringify(value)],{type:'application/json'});
      if(data.compress)blob=await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      self.postMessage({ok:true,blob});
    }
  }catch(error){self.postMessage({ok:false,error:error.message||'备份处理失败'})}
};
