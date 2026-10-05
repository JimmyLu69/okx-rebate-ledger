export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const encoder = new TextEncoder();
function abort(signal) { if(signal?.aborted)throw signal.reason||new DOMException('备份已取消','AbortError'); }
// Serialize records once in bounded chunks. Avoid simultaneous whole-ledger JSON,
// UTF-16 strings and byte buffers for the normal unencrypted export path.
export async function serializeBackup(value,{signal,onProgress=()=>{},maxBytes=MAX_BACKUP_BYTES}={}) {
  const chunks=[];let pieces=[],characters=0,bytes=0,nodes=0;
  const ancestors=new Set();
  function* json(input) {
    if(input===null||typeof input!=='object'){yield JSON.stringify(input)??'null';return}
    if(ancestors.has(input))throw Error('备份包含循环引用');ancestors.add(input);
    if(Array.isArray(input)) {
      yield '[';
      for(let i=0;i<input.length;i++){if(i)yield ',';yield*json(input[i]);}
      yield ']';
    } else {
      yield '{';let first=true;
      for(const key of Object.keys(input))if(input[key]!==undefined&&typeof input[key]!=='function'){
        if(!first)yield ',';first=false;yield JSON.stringify(key)+':';yield*json(input[key]);
      }
      yield '}';
    }
    ancestors.delete(input);
  }
  async function flush(){
    if(!pieces.length)return;abort(signal);const chunk=encoder.encode(pieces.join(''));bytes+=chunk.byteLength;
    if(bytes>maxBytes)throw Error('备份明文超过 100 MB，请缩小历史范围');
    chunks.push(chunk);pieces=[];characters=0;onProgress({phase:'serialize',bytes});
    await new Promise(resolve=>setTimeout(resolve,0));abort(signal);
  }
  for(const part of json(value)){
    pieces.push(part);characters+=part.length;
    if(characters>=65536||++nodes>=10000){nodes=0;await flush();}
  }
  await flush();return new Blob(chunks,{type:'application/json'});
}
export async function readBackupStream(stream,{signal,onProgress=()=>{},maxBytes=140*1024*1024}={}) {
  const reader=stream.getReader(),chunks=[];let bytes=0;
  const cancel=()=>reader.cancel(signal.reason).catch(()=>{});signal?.addEventListener('abort',cancel,{once:true});
  try{for(;;){abort(signal);const{value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>maxBytes)throw Error('解压后文件超过 140 MB');chunks.push(value);onProgress({phase:'read',bytes});}
    abort(signal);return{blob:new Blob(chunks,{type:'application/json'}),bytes};
  }catch(error){await reader.cancel().catch(()=>{});throw error}
  finally{signal?.removeEventListener('abort',cancel);reader.releaseLock()}
}
