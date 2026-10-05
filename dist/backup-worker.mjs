import {encryptBackupBytes,decryptBackup,isEncryptedBackup} from './backup-crypto.mjs';
import {validateHistoryBackup,validateSettingsBackup,validateAllowlistBackup,validateState} from './validation.mjs';
import {serializeBackup,readBackupStream,MAX_BACKUP_BYTES} from './backup-codec.mjs';
const MAX=140*1024*1024;
let controller;
const progress=value=>self.postMessage({type:'progress',...value});
self.onmessage=async({data})=>{
  if(data.type==='cancel'){controller?.abort(new DOMException('备份已取消','AbortError'));return}
  if(controller){self.postMessage({ok:false,error:'请等待当前备份操作完成',code:'BACKUP_BUSY'});return}
  controller=new AbortController();const signal=controller.signal;
  try {
    if(data.type==='decode') {
      const file=data.file;if(file.size>MAX)throw Error('文件超过 140 MB');
      const magic=new Uint8Array(await file.slice(0,2).arrayBuffer());
      const stream=magic[0]===31&&magic[1]===139?file.stream().pipeThrough(new DecompressionStream('gzip')):file.stream();
      const decoded=await readBackupStream(stream,{signal,onProgress:progress});progress({phase:'parse',bytes:decoded.bytes});
      let value=JSON.parse(await decoded.blob.text());
      if(isEncryptedBackup(value)){
        if(!data.password){const error=Error('此备份已加密，请输入口令后重试');error.code='PASSWORD_REQUIRED';throw error}
        progress({phase:'decrypt'});value=await decryptBackup(value,data.password);
      }else if(decoded.bytes>MAX_BACKUP_BYTES)throw Error('未加密备份明文超过 100 MB');
      signal.throwIfAborted();
      const detected=value?.format==='rebate-settings'?'settings':value?.format==='rebate-allowlist'?'allowlist':'history';
      if(data.kind&&data.kind!=='auto'&&data.kind!==detected)throw Error('文件类型与所选导入类型不一致');
      progress({phase:'validate'});
      if(detected==='settings')value=validateSettingsBackup(value);
      else if(detected==='allowlist')value=validateAllowlistBackup(value);
      else if(value?.format==='rebate-history')value=validateHistoryBackup(value,{trustEvidence:false});
      else value={state:validateState({version:1,records:Array.isArray(value)?value:value?.records,coverage:{},selected:[],updated:null},{wallets:data.wallets,trustEvidence:false})};
      self.postMessage({ok:true,value,kind:detected,wallets:value.wallets||data.wallets});
    } else if(data.type==='encode'||data.type==='encodeStored') {
      let value=data.value;
      if(data.type==='encodeStored'){
        progress({phase:'readSaved'});
        const {readProfile}=await import('./profile-storage.mjs');
        const state=await readProfile(data.wallets);
        if(!state)throw Error('本机尚无已保存的历史，请改用当前内存导出');
        value={format:'rebate-history',backupVersion:2,createdAt:new Date().toISOString(),wallets:data.wallets,state};
      }
      signal.throwIfAborted();
      let blob=await serializeBackup(value,{signal,onProgress:progress});
      if(data.password){progress({phase:'encrypt',bytes:blob.size});const encrypted=await encryptBackupBytes(new Uint8Array(await blob.arrayBuffer()),data.password);signal.throwIfAborted();blob=await serializeBackup(encrypted,{signal,onProgress:progress,maxBytes:MAX});}
      if(data.compress){progress({phase:'compress',bytes:blob.size});blob=(await readBackupStream(blob.stream().pipeThrough(new CompressionStream('gzip')),{signal,onProgress:progress,maxBytes:MAX})).blob;}
      signal.throwIfAborted();self.postMessage({ok:true,blob});
    }else throw Error('不支持的备份操作');
  }catch(error){self.postMessage({ok:false,error:error.message||'备份处理失败',code:typeof error.code==='string'?error.code:(error.name==='AbortError'?'CANCELLED':undefined)})}
  finally{controller=null}
};
