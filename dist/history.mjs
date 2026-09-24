// Finished scans retain their checkpoints. Only completed streams open a new window.
export function incrementalStreams(streams={},records=[]){
 return Object.fromEntries(Object.entries(streams).map(([name,p])=>{
  if(!p?.complete)return [name,{...p}];
  if(name==='solana'){const head=p.headSignature||records.filter(r=>r.chain==='solana'&&r.time).sort((a,b)=>b.time.localeCompare(a.time))[0]?.hash||null;return [name,{complete:false,until:head,headSignature:head}];}
  if(['transactions','internal-transactions','token-transfers'].includes(name))return [name,{complete:false,stopBlock:Number.isSafeInteger(p.highBlock)?Math.max(0,p.highBlock-64):null,highBlock:p.highBlock??null,anchors:Number.isSafeInteger(p.highBlock)?[]:records.filter(r=>r.stream===name).sort((a,b)=>(b.time||'').localeCompare(a.time||'')).slice(0,50).map(r=>r.hash)}];
  if(Number.isSafeInteger(p.endBlock))return [name,{complete:false,minBlock:p.endBlock+1,count:p.count,fullRange:p.fullRange}];
  return [name,{}];
 }));
}
export function historyBackup(state,wallets){return {format:'rebate-history',backupVersion:2,createdAt:new Date().toISOString(),wallets,state:structuredClone(state)}}
export function restoreHistory(data,wallets,validateRecord){
 const modern=data?.format==='rebate-history'&&data.backupVersion===2;
 const input=modern?data.state:data;
 const records=Array.isArray(input)?input:input?.records;
 if(!Array.isArray(records)||records.length>100000)throw Error('历史文件缺少 records 或超过十万笔');
 const pair=data.wallets;
 if(modern&&(!pair||pair.evm?.toLowerCase()!==wallets.evm?.toLowerCase()||pair.sol!==wallets.sol))throw Error('历史备份的钱包与当前设置不同，请先导入对应设置');
 for(const r of records){validateRecord(r);const own=r.chain==='solana'?wallets.sol:wallets.evm;const eq=a=>r.chain==='solana'?a===own:a?.toLowerCase()===own?.toLowerCase();if(!own||(!eq(r.from)&&!eq(r.to)&&!(modern&&r.stream==='discovery'&&r.raw==='0')))throw Error('历史包含其他钱包记录');}
 // Only our versioned, wallet-bound backup may restore query cursors.
 if(modern){
  if(input.version!==1||!input.coverage||typeof input.coverage!=='object'||Array.isArray(input.coverage))throw Error('历史进度格式错误');
  for(const c of Object.values(input.coverage)){
   if(!c||!Array.isArray(c.inspected)||!c.inspected.every(h=>typeof h==='string')||!c.streams||typeof c.streams!=='object')throw Error('历史进度缺少核验信息');
   for(const p of Object.values(c.streams))for(const k of ['endBlock','minBlock','next','highBlock','stopBlock'])if(p[k]!=null&&(!Number.isSafeInteger(p[k])||p[k]<(k==='next'?-100000000:0)))throw Error('历史区块进度无效');
  }
  return structuredClone(input);
 }
 return {version:1,records,coverage:{},selected:[],updated:null};
}
