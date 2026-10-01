// Untrusted backups are data, never proof of chain state. Unknown fields are
// discarded; wrong types and cross-wallet records reject the whole import.
const MAX_RECORDS=100000;
const CHAIN=/^(?:solana|[1-9]\d{0,11})$/;
const EVM_ADDRESS=/^0x[\da-fA-F]{40}$/;
const SOL_ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FORBIDDEN=new Set(['__proto__','prototype','constructor']);
function fail(label){throw Error(label+'格式不正确，请使用本看板导出的文件')}
function object(v,label){if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail(label);return v}
function string(v,label,max=400,empty=true){if(typeof v!=='string'||v.length>max||(!empty&&!v.length)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))fail(label);return v}
function integer(v,label,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)fail(label);return v}
function boolean(v,label){if(typeof v!=='boolean')fail(label);return v}
function chain(v){if(typeof v!=='string'||!CHAIN.test(v))fail('网络');return v}
function address(v,c,label='地址',empty=true){if(empty&&v==='')return v;if(typeof v!=='string'||!(c==='solana'?SOL_ADDRESS:EVM_ADDRESS).test(v))fail(label);return c==='solana'?v:v.toLowerCase()}
function hash(v,c){if(typeof v!=='string'||!(c==='solana'?/^[1-9A-HJ-NP-Za-km-z]{64,100}$/:/^0x[\da-fA-F]{64}$/).test(v))fail('交易哈希');return c==='solana'?v:v.toLowerCase()}
function date(v,label='日期',empty=true){if(empty&&(v==null||v===''))return v??null;string(v,label,40,false);if(!/^\d{4}-\d\d-\d\dT/.test(v)||!Number.isFinite(Date.parse(v)))fail(label);return v}
function list(v,label,max,convert){if(!Array.isArray(v)||v.length>max)fail(label);return v.map(convert)}
function dictionary(v,label,max,convert){object(v,label);if(Object.keys(v).length>max)fail(label);const out={};for(const[k,x]of Object.entries(v)){if(FORBIDDEN.has(k))fail(label);out[k]=convert(x,k)}return out}
function enumValue(v,values,label){if(!values.includes(v))fail(label);return v}
const KINDS=['commission','refund','pending','ignore'];
const RECORD_TEXT=['symbol','evidence','inspectionError','exclusionReason','reviewReason','spamReason','source','stream','protocol','attributionMethod','payerRole','classificationReason'];
const RECORD_BOOL=['verified','feeEvent','receiptMatched','attributionVerified','automatic','reviewed','spamDismissed','sourceSpam','solanaCommission','solanaSelfSwap','directTokenTransfer','directNativeTransfer','directPayment','walletAuthorized','paymentAuthorized','autoExcluded','needsReview','spam','importedUnverified','retired','superseded','ownerVerified','protocolVerified','userInitiated','directTransfer'];
export function validateRecord(input){
 const r=object(input,'记录'),c=chain(r.chain),h=hash(r.hash,c);
 const out={id:string(r.id,'记录 ID',400,false),chain:c,asset:r.asset==='native'?'native':address(r.asset,c,'合约',false),symbol:string(r.symbol,'币种',200),decimals:integer(r.decimals,'代币精度',0,36),raw:string(r.raw,'最小单位金额',100,false),hash:h,from:address(r.from??'',c),to:address(r.to??'',c),trader:address(r.trader??'',c),direction:enumValue(r.direction,['in','out'],'方向'),kind:enumValue(r.kind,KINDS,'类型'),time:date(r.time??'')||''};
 const prefix=c+':'+h+':';
 if(!/^\d+$/.test(out.raw)||!(c==='solana'?out.id.startsWith(prefix):out.id.toLowerCase().startsWith(prefix)))fail('记录金额或 ID');
 out.id=prefix+out.id.slice(prefix.length);
 if(out.kind==='commission'&&out.direction!=='in'||out.kind==='refund'&&out.direction!=='out'||['commission','refund'].includes(out.kind)&&!out.trader)fail('记录归属');
 for(const k of RECORD_TEXT)if(r[k]!==undefined)out[k]=string(r[k],k,k==='symbol'?200:2000);
 for(const k of RECORD_BOOL)if(r[k]!==undefined)out[k]=boolean(r[k],k);
 for(const k of ['txSender','suggestedTrader','authority','owner','commissionRecipient','transferAuthority','payer'])if(r[k]!==undefined)out[k]=address(r[k],c,k);
 for(const k of ['logIndex','blockNumber','slot','decoderRevision','verificationRevision','inspectionRevision'])if(r[k]!==undefined)out[k]=integer(r[k],k);
 if(r.blockHash!==undefined)out.blockHash=hash(r.blockHash,c);
 if(r.orderUid!==undefined){if(typeof r.orderUid!=='string'||!/^([\da-f]{112}|0x[\da-f]{112})$/i.test(r.orderUid))fail('订单 UID');out.orderUid=r.orderUid}
 if(r.whitelistKind!==undefined)out.whitelistKind=enumValue(r.whitelistKind,KINDS,'白名单前分类');
 for(const k of ['supersededBy','matchedReceiptIds'])if(r[k]!==undefined)out[k]=list(r[k],'关联记录',1000,x=>string(x,'记录 ID',400,false));
 if(r.reviewedAt!==undefined)out.reviewedAt=date(r.reviewedAt);
 if(r.roles!==undefined){object(r.roles,'账户角色');out.roles={};for(const k of ['router','transactionSender','owner','recipient','authority','feePayer','commissionRecipient'])if(r.roles[k]!==undefined)out.roles[k]=address(r.roles[k],c,'账户角色')}
 return out;
}
export function validateWallets(input){const v=object(input,'钱包');return {evm:address(v.evm??'','1'),sol:address(v.sol??'','solana')}}
export function validateRecheckReport(input){
 const r=object(input,'重核结果'),out={started:date(r.started,'开始时间',false),before:integer(r.before,'核对前笔数',0,MAX_RECORDS),total:integer(r.total,'总笔数',0,MAX_RECORDS)};
 if(r.finished!==undefined)out.finished=date(r.finished,'结束时间',false);
 out.entries=list(r.entries,'重核结果',MAX_RECORDS,e=>{
  object(e,'重核项');const c=chain(e.chain),h=hash(e.hash,c),x={key:c+':'+h,chain:c,hash:h,before:integer(e.before,'核对前笔数',0,MAX_RECORDS),after:integer(e.after,'核对后笔数',0,MAX_RECORDS),status:enumValue(e.status,['queued','missing','resolved','partial','unresolved','failed','cancelled'],'重核状态'),error:string(e.error??'','重核原因',2000)};
  if(e.source!==undefined)x.source=string(e.source,'核验来源',80);if(e.cached!==undefined)x.cached=boolean(e.cached,'缓存标记');return x;
 });return out;
}
function validateStream(input,c,name){
 const v=object(input,'扫描进度'),out={};
 for(const k of ['complete','fullRange'])if(v[k]!==undefined)out[k]=boolean(v[k],k);
 for(const k of ['endBlock','minBlock','next','highBlock','stopBlock','count','page','windowSize','startBlock'])if(v[k]!=null)out[k]=integer(v[k],k,k==='next'?-100000000:0);else if(v[k]===null)out[k]=null;
 if(v.stream!==undefined){string(v.stream,'分页类型',80);if(v.stream!==name)fail('分页类型');out.stream=v.stream}
 if(v.cursor!==undefined){
  if(v.cursor===null)out.cursor=null;
  else if(typeof v.cursor==='string')out.cursor=c==='solana'?hash(v.cursor,c):string(v.cursor,'分页游标',2000);
  else out.cursor=dictionary(v.cursor,'分页游标',40,(value,key)=>{if(!/^[a-z_]+$/.test(key))fail('分页游标');if(typeof value==='number')return integer(value,'分页游标',-100000000);if(typeof value==='boolean'||value===null)return value;return string(value,'分页游标',2000)});
 }
 for(const k of ['until','headSignature'])if(v[k]!=null)out[k]=hash(v[k],'solana');else if(v[k]===null)out[k]=null;
 if(v.anchors!==undefined)out.anchors=list(v.anchors,'历史锚点',1000,h=>hash(h,c));
 return out;
}
export function validateCoverage(input){
 return dictionary(input,'网络进度',500,(v,c)=>{
  chain(c);object(v,'网络进度');const out={streams:dictionary(v.streams??{},'扫描类型',30,(s,name)=>{if(!/^[a-zA-Z0-9_-]{1,80}$/.test(name)&&!['转入','转出'].includes(name))fail('扫描类型');return validateStream(s,c,name)}),inspected:list(v.inspected??[],'已核验交易',MAX_RECORDS,h=>hash(h,c))};
  if(v.status!==undefined)out.status=enumValue(v.status,['complete','error','running','stale','unverified','idle','paused'],'网络状态');
  if(v.error!==undefined)out.error=string(v.error,'网络错误',2000);
  if(v.updated!==undefined)out.updated=date(v.updated);
  if(v.inspectionErrors!==undefined)out.inspectionErrors=dictionary(v.inspectionErrors,'核验错误',MAX_RECORDS,(e,h)=>{hash(h,c);return string(e,'核验错误',2000)});
  if(v.recheck!==undefined)out.recheck={}; // Legacy machine cache is deliberately not trusted/restored.
  return out;
 });
}
export function validateDecisions(input,records=[]){
 const byID=new Map(records.map(r=>[r.id,r]));
 return dictionary(input,'人工核对',MAX_RECORDS,(d,id)=>{
  object(d,'人工核对');string(id,'记录 ID',400,false);const c=byID.get(id)?.chain||id.split(':')[0];chain(c);
  const out={kind:enumValue(d.kind,KINDS,'人工用途'),trader:address(d.trader??'',c),reason:string(d.reason??'','核对理由',2000),updatedAt:date(d.updatedAt,'核对时间',false)};
  if(['commission','refund'].includes(out.kind)&&!out.trader)fail('人工归属地址');
  const row=byID.get(id);if(row&&(out.kind==='commission'&&row.direction!=='in'||out.kind==='refund'&&row.direction!=='out'))fail('人工用途方向');
  if(d.keep!==undefined)out.keep=boolean(d.keep,'保留标记');return out;
 });
}
export function validateState(input,{trustEvidence=true,wallets}={}){
 const s=object(input,'历史');if(s.version!==1)fail('历史版本');
 const records=list(s.records,'历史记录',MAX_RECORDS,validateRecord),ids=new Set();
 for(const r of records){if(ids.has(r.id))fail('重复记录 ID');ids.add(r.id)}
 if(wallets){const pair=validateWallets(wallets);for(const r of records){const own=r.chain==='solana'?pair.sol:pair.evm;if(!own||![r.from,r.to].includes(own)&&!(r.stream==='discovery'&&r.raw==='0'))fail('历史所属钱包')}}
 const out={version:1,records,coverage:validateCoverage(s.coverage??{}),selected:list(s.selected??[],'已选网络',500,chain),updated:date(s.updated)};
 if(s.decoderVersion!==undefined)out.decoderVersion=integer(s.decoderVersion,'解析版本',0,1000000);
 if(s.decisions!==undefined)out.decisions=validateDecisions(s.decisions,records);
 for(const r of records)if(trustEvidence&&r.reviewed&&!out.decisions?.[r.id]){out.decisions??={};out.decisions[r.id]={kind:r.kind,trader:r.trader,reason:r.evidence||'从旧版备份恢复的人工核对',updatedAt:out.updated||r.time||new Date().toISOString(),...(r.spamDismissed?{keep:true}:{})}}
 if(s.lastRecheck!=null)out.lastRecheck=validateRecheckReport(s.lastRecheck);
 // Backups cannot establish provenance: keep raw protocol fields for inspection,
 // but the accounting engine must withhold machine conclusions until rechecked.
 if(!trustEvidence){for(const r of records){r.importedUnverified=true;r.kind='pending';delete r.reviewed;delete r.automatic}for(const c of Object.values(out.coverage)){c.inspected=[];c.status='stale';c.error='从备份恢复；分页进度保留，已有交易需重新核验'}}
 return out;
}
export function validateHistoryBackup(input,{wallets,trustEvidence=false}={}){
 const d=object(input,'历史备份');if(d.format!=='rebate-history'||d.backupVersion!==2)fail('历史备份版本');
 const pair=validateWallets(d.wallets);if(wallets){const current=validateWallets(wallets);if(pair.evm!==current.evm||pair.sol!==current.sol)throw Error('历史备份的钱包与当前设置不同，请先导入对应设置')}
 return {format:'rebate-history',backupVersion:2,createdAt:date(d.createdAt,'备份日期',false),wallets:pair,state:validateState(d.state,{wallets:pair,trustEvidence})};
}
export function validateAllowlist(input){return list(input,'合约白名单',20000,v=>{object(v,'合约白名单');const c=chain(v.chain);return {chain:c,asset:v.asset==='native'?'native':address(v.asset,c,'合约',false)}})}
export function validateAllowlistBackup(input){object(input,'白名单备份');if(input.format!=='rebate-allowlist'||input.version!==1)fail('白名单备份');return {format:'rebate-allowlist',version:1,assets:validateAllowlist(input.assets)}}
export function validateSettingsBackup(input){
 const s=object(input,'设置');if(s.format!=='rebate-settings'||s.version!==1)fail('设置备份');
 const p=object(s.preferences??{},'结清设置'),threshold=p.threshold??'0.1';if(typeof threshold!=='string'||threshold.length>40||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(threshold)||Number(threshold)>1000000)fail('结清金额');
 const out={format:'rebate-settings',version:1,wallets:validateWallets(s.wallets),preferences:{enabled:p.enabled===undefined?true:boolean(p.enabled,'结清开关'),threshold},selected:list(s.selected??[],'已选网络',500,chain),credentialMode:s.credentialMode===undefined?'local':enumValue(s.credentialMode,['local','session'],'凭证保存方式')};
 if(s.assetAllowlist!==undefined)out.assetAllowlist=validateAllowlist(s.assetAllowlist);
 if(s.scanOptions!==undefined)out.scanOptions=dictionary(s.scanOptions,'扫描设置',500,(v,c)=>{chain(c);object(v,'扫描设置');return v.startBlock===undefined?{}:{startBlock:integer(v.startBlock,'开始区块')}});
 if(s.credentials!==undefined){const c=object(s.credentials,'API 凭证');out.credentials={};for(const k of ['blockscout','helius','nodereal','etherscan']){out.credentials[k]=string(c[k]??'','API 凭证',512);if(/[\r\n]/.test(out.credentials[k]))fail('API 凭证')}out.credentials.xlayer=null;if(c.xlayer!=null){object(c.xlayer,'OKX 凭证');const x={};for(const k of ['key','secret','passphrase']){x[k]=string(c.xlayer[k],'OKX 凭证',512,false);if(/[\r\n]/.test(x[k]))fail('OKX 凭证')}out.credentials.xlayer=x}}
 return out;
}
