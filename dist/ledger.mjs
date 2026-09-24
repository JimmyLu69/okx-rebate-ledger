import {assetAllowed,allowlistEnabled} from './allowlist.mjs';
export let EVM='';
export let SOL='';
export const LEGACY_FEE_TOPICS=['0x0d3b1268ca3dbb6d3d8a0ea35f44f8f9d58cf578d732680b71b6904fb2733e0d','0xf171268de859ec269c52bbfac94dcb7715e784de194342abb284bf34fd30b32d'];
export const FEE_TOPICS=['0xcd5eae9d9d0b96532bd1b7dbf6628ce436b2af735829087a03c548439f8bf850','0x3cfb523a4c38d88561dd3bf04805a31715c8b5fc468a03b8d684356f360dea99',...LEGACY_FEE_TOPICS];
export function canonical(chain,address){return chain==='solana'?address:address?.toLowerCase()||''}
export function validAddress(chain,a){return chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a):/^0x[0-9a-fA-F]{40}$/.test(a)}
export function format(raw,decimals){let n=BigInt(raw),sign=n<0n?'-':'';if(n<0n)n=-n;let s=n.toString().padStart(decimals+1,'0');return sign+(decimals?s.slice(0,-decimals)+'.'+s.slice(-decimals).replace(/0+$/,''):s).replace(/\.$/,'')}
export function parseAmount(s,d){if(!/^\d+(\.\d+)?$/.test(s))throw Error('金额必须是非负十进制字符串');const[a,b='']=s.split('.');if(b.length>d)throw Error('金额精度超过代币精度');return BigInt(a+b.padEnd(d,'0')).toString()}
export function safeJSON(text){return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(full,n)=>n&&/^-?\d{16,}$/.test(n)?`"${n}"`:full))}
export function mergeRecords(old,items){const m=new Map(old.map(r=>[r.id,r]));for(let r of items){const prev=m.get(r.id);if(prev?.spamDismissed)r={...r,spamDismissed:true};m.set(r.id,prev?.reviewed?{...r,kind:prev.kind,trader:prev.trader,reviewed:true,evidence:prev.evidence}:r)}return [...m.values()]}
export function summarize(records){const m=new Map();for(const r of records){if(r.supersededBy||!['commission','refund'].includes(r.kind)||!r.trader)continue;const trader=canonical(r.chain,r.trader),asset=canonical(r.chain,r.asset),key=[r.chain,asset,trader].join(':');if(!m.has(key))m.set(key,{key,chain:r.chain,asset,symbol:r.symbol,decimals:r.decimals,trader,due:0n,paid:0n,ids:[]});const g=m.get(key);if(g.decimals!==r.decimals)throw Error('同一代币存在精度冲突，请核对数据源');g[r.kind==='commission'?'due':'paid']+=BigInt(r.raw);g.ids.push(r.id)}return [...m.values()].map(g=>{let net=g.due-g.paid;return {...g,due:g.due.toString(),paid:g.paid.toString(),remaining:(net>0n?net:0n).toString(),excess:(net<0n?-net:0n).toString(),status:net>0n?(g.paid===0n?'unpaid':'partial'):net<0n?'over':'settled'}})}
function decodeLegacyFeeLogs(logs,chain,tx,tokenMeta={},trustedRouters=[]){if(tx.status!=='ok'&&tx.status!=='success'&&tx.status!=='0x1')return [];return logs.flatMap((l,i)=>{const topic=l.topics?.[0]?.toLowerCase(),data=l.data?.toLowerCase().replace(/^0x/,'');if(!FEE_TOPICS.includes(topic)||!data||data.length!==(LEGACY_FEE_TOPICS.includes(topic)?192:256)||l.removed)return [];const w=data.match(/.{64}/g),recipient='0x'+w[2].slice(-40);if(recipient!==EVM)return [];const token='0x'+w[0].slice(-40),asset=token==='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'?'native':token,raw=BigInt('0x'+w[1]).toString();if(raw==='0')return [];const meta=asset==='native'?{symbol:chain.symbol,decimals:chain.decimals}:tokenMeta[asset];if(!meta||meta.decimals==null)throw Error('返佣代币缺少精度，需补查代币元数据');const router=canonical(chain.id,l.address?.hash||l.address),trader=canonical(chain.id,tx.from?.hash||tx.from),to=canonical(chain.id,tx.to?.hash||tx.to);const trusted=trustedRouters.includes(router)&&router===to&&tx.from?.is_contract===false&&trader!==EVM;const index=Number(l.index??l.logIndex??i);return [{id:`${chain.id}:${tx.hash}:fee:${index}`,chain:chain.id,asset,symbol:meta.symbol||asset,decimals:Number(meta.decimals),raw,hash:tx.hash,from:router,to:EVM,trader,direction:'in',kind:trusted?'commission':'pending',time:tx.timestamp||'',verified:trusted,evidence:trusted?'OKX 官方路由 + 成功交易返佣事件；归属交易发起人':'检测到返佣事件，但路由或交易人需人工核对',feeEvent:true}]})}
// Settlement ABI: CommissionFeePaid(bytes,address,address,uint256,uint256,uint256)
// and Trade(address,address,address,uint256,uint256,bytes). UID = digest + owner + validTo.
// Verified source: https://base.blockscout.com/address/0x25ed72c3f671b626810a6db597dcfd50f215a423?tab=contract
export const SETTLEMENT_FEE_TOPIC='0x02b4603e6be0c4002f11c4445116c51a20adeecb33e1434306ec55378f75a099';
export const SETTLEMENT_TRADE_TOPIC='0xd65443291bb59863c3ddfe64892356e9f0c3888a4c99efd97df5c028cb5db267';
const settlementAddress='0x25ed72c3f671b626810a6db597dcfd50f215a423';
function settlementUID(data,offsetWord,headWords){
 if(!/^0x[0-9a-f]+$/i.test(data||''))return '';
 const words=data.slice(2).toLowerCase().match(/.{64}/g);
 if(data.length!==2+(headWords+3)*64||BigInt('0x'+words[offsetWord])!==BigInt(headWords*32)||BigInt('0x'+words[headWords])!==56n)return '';
 const tail=words.slice(headWords+1).join('');if(!/^0{16}$/.test(tail.slice(112)))return '';
 return tail.slice(0,112);
}
export function settlementFeeAsset(log){
 if(log.topics?.[0]?.toLowerCase()!==SETTLEMENT_FEE_TOPIC||log.topics.length!==3||log.removed)return '';
 if(!log.topics.slice(1).every(t=>/^0x0{24}[0-9a-f]{40}$/i.test(t)))return '';
 return log.topics[2].slice(-40).toLowerCase()===EVM.slice(2)?'0x'+log.topics[1].slice(-40).toLowerCase():'';
}
export function decodeFeeLogs(logs,chain,tx,tokenMeta={},trustedRouters=[]){
 const legacy=decodeLegacyFeeLogs(logs,chain,tx,tokenMeta,trustedRouters);
 if(!['ok','success','0x1'].includes(tx.status)||!['56','8453'].includes(chain.id))return legacy;
 const atRouter=l=>canonical(chain.id,l.address?.hash||l.address)===settlementAddress&&!l.removed;
 const trades=new Map();
 for(const l of logs){
  if(!atRouter(l)||l.topics?.[0]?.toLowerCase()!==SETTLEMENT_TRADE_TOPIC||l.topics.length!==4)continue;
  const uid=settlementUID(l.data,2,3),owner='0x'+l.topics[1].slice(-40).toLowerCase();
  if(uid&&owner==='0x'+uid.slice(64,104)&&owner!==EVM&&owner!==settlementAddress&&owner!=='0x'+'0'.repeat(40))trades.set(uid,{owner,tokens:l.topics.slice(2).map(t=>'0x'+t.slice(-40).toLowerCase())});
 }
 const fees=logs.flatMap((l,i)=>{
  const token=settlementFeeAsset(l);if(!token||!atRouter(l))return [];
  const uid=settlementUID(l.data,0,4);if(!uid)return [];
  const raw=BigInt('0x'+l.data.slice(130,194)).toString();if(raw==='0')return [];
  const asset=token==='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'?'native':token;
  const meta=asset==='native'?{symbol:chain.symbol,decimals:chain.decimals}:tokenMeta[asset];
  if(meta?.decimals==null)throw Error('返佣代币缺少精度，需补查代币元数据');
  const trade=trades.get(uid),matched=!!trade&&trade.tokens.includes(token);
  return [{id:`${chain.id}:${tx.hash}:fee:${Number(l.index??l.logIndex??i)}`,chain:chain.id,asset,symbol:meta.symbol||asset,decimals:Number(meta.decimals),raw,hash:tx.hash,from:settlementAddress,to:EVM,trader:matched?trade.owner:'',txSender:canonical(chain.id,tx.from?.hash||tx.from),direction:'in',kind:'pending',time:tx.timestamp||'',feeEvent:true,protocol:'settlement',orderUid:uid,attributionVerified:matched,verified:matched,evidence:matched?'Settlement 返佣事件与同订单 Trade.owner 一致；等待实际到账核验':'Settlement 返佣事件缺少同订单交易凭证，不能归属合约或代执行者'}];
 });return [...legacy,...fees];
}
export function blockscoutRows(items,stream,chain){return items.flatMap((x,i)=>{if(x.status&& !['ok','success'].includes(x.status)||x.success===false||x.error)return [];if(stream==='token-transfers'&&x.token?.type!=='ERC-20')return [];const from=canonical(chain.id,x.from?.hash),to=canonical(chain.id,x.to?.hash);if(from===to||from!==EVM&&to!==EVM)return [];const raw=String(stream==='token-transfers'?x.total?.value??'0':x.value??'0');if(!/^\d+$/.test(raw)||BigInt(raw)===0n)return [];if(stream!=='transactions'&&x.log_index==null&&x.index==null)throw Error('转账缺少稳定索引，无法安全去重');const hash=x.transaction_hash||x.hash,decimals=stream==='token-transfers'?x.token?.decimals:chain.decimals;if(decimals==null)throw Error('代币缺少精度，不能安全计账');return [{id:`${chain.id}:${hash}:${stream}:${stream==='transactions'?0:x.log_index??x.index??i}`,chain:chain.id,asset:stream==='token-transfers'?canonical(chain.id,x.token.address_hash):'native',symbol:stream==='token-transfers'?x.token.symbol||x.token.address_hash:chain.symbol,decimals:Number(decimals),raw,hash,from,to,trader:from===EVM?to:'',direction:from===EVM?'out':'in',kind:'pending',time:x.timestamp||'',stream,sourceSpam:x.token?.reputation==='scam'||x.token?.is_scam===true,evidence:from===EVM?'链上转出；请确认是否属于手动返还':'链上转入；等待返佣事件与归属核对'}]})}
export function parseSolanaTransaction(tx,signature){if(!tx||!tx.meta)throw Error('Solana 交易详情不可用，历史扫描不完整');if(tx.meta.err)return [];const keys=tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);const owner=new Map(),mint=new Map(),decimals=new Map();for(const b of [...tx.meta.preTokenBalances||[],...tx.meta.postTokenBalances||[]]){owner.set(keys[b.accountIndex],b.owner);mint.set(keys[b.accountIndex],b.mint);decimals.set(b.mint,b.uiTokenAmount.decimals)}const instructions=[];for(const[i,x]of tx.transaction.message.instructions.entries()){instructions.push([`${i}`,x]);for(const[j,y]of(tx.meta.innerInstructions?.find(v=>v.index===i)?.instructions||[]).entries())instructions.push([`${i}.${j}`,y])}return instructions.flatMap(([path,x])=>{const p=x.parsed;if(!p||!['transfer','transferChecked','transferCheckedWithFee'].includes(p.type))return [];const info=p.info;let from=info.source,to=info.destination,asset,symbol,d,raw;if(x.program==='system'){asset='native';symbol='SOL';d=9;raw=String(info.lamports)}else if(['spl-token','spl-token-2022'].includes(x.program)){asset=info.mint||mint.get(info.source)||mint.get(info.destination);if(!asset)return [];from=owner.get(info.source)||info.authority;to=owner.get(info.destination);d=info.tokenAmount?.decimals??decimals.get(asset);raw=String(info.tokenAmount?.amount??info.amount);symbol=asset==='So11111111111111111111111111111111111111112'?'WSOL':asset==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'?'USDC':asset==='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'?'USDT':asset.slice(0,6)+'…';if(p.type==='transferCheckedWithFee')raw=(BigInt(raw)-BigInt(info.feeAmount?.amount??info.feeAmount??0)).toString()}else return [];if(from===to||from!==SOL&&to!==SOL)return [];if(d==null||!/^\d+$/.test(raw))throw Error('Solana 转账精度或金额缺失');if(BigInt(raw)===0n)return [];return [{id:`solana:${signature}:ix:${path}`,chain:'solana',asset,symbol,decimals:Number(d),raw,hash:signature,from:from||'',to:to||'',trader:from===SOL?to:from,direction:from===SOL?'out':'in',kind:'pending',time:tx.blockTime?new Date(Number(tx.blockTime)*1000).toISOString():'',evidence:from===SOL?'Solana 成功转出；请确认返还用途':'Solana 精确转入；转账来源不一定是被邀请人，请核对归属'}]})}

// Address is the outer grouping. Assets never offset a different chain/contract.
export function byAddress(groups){
 const m=new Map();for(const g of groups){const k=(g.chain==='solana'?'sol:':'evm:')+g.trader;if(!m.has(k))m.set(k,{address:g.trader,assets:[],recordCount:0});const a=m.get(k);a.assets.push(g);a.recordCount+=g.ids.length;}
 return [...m.values()].map(a=>({...a,owedAssets:a.assets.filter(g=>['unpaid','partial'].includes(g.status)).length})).sort((a,b)=>b.owedAssets-a.owedAssets||a.address.localeCompare(b.address));
}

// Automatic accounting requested by the owner. Preserve raw history and any
// previous explicit decisions; never treat an arbitrary deposit as a referral.
// Reports identify assets by chain and full contract / mint, never ticker text.
export const REPORTED_SPAM_ASSETS=new Set([
 '56:0x8f0aa047622b72e71615bab186c2d97985c886bd',
 '42161:0xa693e56e496a13658ab9e3efafa7e13e846a8780',
 '10:0xcd4ea8bd757f8e431923ae64b7ce98bcb7d08392',
 'solana:AWs2J3buZeyvvSE5pyoFVJQUNKa36g8sbouskt6W9fre'
]);
export function autoAccount(records){
 const rows=records.map(r=>{const copy={...r};delete copy.spam;delete copy.spamReason;if(copy.whitelistKind){copy.kind=copy.whitelistKind;delete copy.whitelistKind}if(copy.automatic&&!copy.reviewed){copy.kind='pending';delete copy.automatic}if(copy.autoExcluded&&!copy.reviewed&&!copy.supersededBy){copy.kind='pending';delete copy.autoExcluded}if(!assetAllowed(copy.chain,copy.asset)){copy.whitelistKind=copy.kind;copy.kind='pending';copy.spam=true;copy.spamReason='合约 / Mint 不在当前网络白名单';copy.needsReview=true}return copy});const receiptIds=new Set(records.flatMap(r=>r.supersededBy||[]));
 for(const r of rows){
  if(r.spam||r.supersededBy||r.reviewed||r.kind!=='pending')continue;
  const own=r.chain==='solana'?SOL:EVM;
  if(!allowlistEnabled()&&!r.spamDismissed&&REPORTED_SPAM_ASSETS.has(r.chain+':'+canonical(r.chain,r.asset)))continue;
  if(r.direction==='in'&&r.feeEvent&&(r.receiptMatched||receiptIds.has(r.id))&&r.trader&&r.trader!==own&&(r.protocol!=='settlement'||r.attributionVerified)){r.kind='commission';r.evidence=r.protocol==='settlement'?'自动归属：返佣事件、订单 Trade.owner 与实际到账一致，归属订单持有人':'自动归属：成功交易的返佣事件与实际到账金额一致，归属交易发起地址';r.automatic=true}
  else if(r.chain==='solana'&&r.direction==='in'&&r.source==='OKX_DEX_ROUTER'&&validAddress('solana',r.suggestedTrader||'')&&r.suggestedTrader!==SOL&&r.from===r.suggestedTrader){r.kind='commission';r.trader=r.suggestedTrader;r.evidence='自动归属：OKX 路由交易中，被邀请地址支付给本钱包的实际转账';r.automatic=true}
 }
 const commissions=rows.filter(r=>!r.supersededBy&&r.kind==='commission');
 const assetKey=r=>r.chain+':'+canonical(r.chain,r.asset);
 const relationships=new Set(commissions.map(r=>assetKey(r)+':'+canonical(r.chain,r.trader)));
 const knownAssets=new Set(commissions.map(assetKey));
 const invitees=[...new Set(commissions.filter(r=>r.chain!=='solana').map(r=>canonical(r.chain,r.trader)))];
 for(const r of rows){
  if(r.spam||r.supersededBy||r.reviewed||r.kind!=='pending')continue;
  const own=r.chain==='solana'?SOL:EVM, recipient=canonical(r.chain,r.to);
  const lookalike=r.chain!=='solana'&&invitees.some(a=>a!==recipient&&a.slice(0,6)===recipient.slice(0,6)&&a.slice(-4)===recipient.slice(-4));
  if(!allowlistEnabled()&&!r.spamDismissed&&r.asset!=='native'&&(REPORTED_SPAM_ASSETS.has(assetKey(r))||r.sourceSpam||(!knownAssets.has(assetKey(r))&&r.direction==='out'&&lookalike))){
   r.spam=true;r.spamReason=REPORTED_SPAM_ASSETS.has(assetKey(r))?'案例报告标记为疑似钓鱼资产（按网络与完整合约 / Mint 匹配）':r.sourceSpam?'数据源标记为可疑代币 / 垃圾记录':'合约未匹配返佣资产，且收款地址仿似已知被邀请地址';r.needsReview=true;continue;
  }
  if(r.direction==='out'&&canonical(r.chain,r.from)===own&&relationships.has(assetKey(r)+':'+recipient)&&(r.chain==='solana'||canonical(r.chain,r.txSender)===own)){
   r.kind='refund';r.trader=recipient;r.automatic=true;r.evidence='自动抵扣：本钱包向已识别被邀请地址的同币种转出（Gas 不计入）';
  }else{r.kind='pending';r.needsReview=true;r.reviewReason=r.inspectionError?'凭证核验失败：'+r.inspectionError:r.direction==='out'?(r.chain!=='solana'&&canonical(r.chain,r.txSender)!==own?'尚未证实由本钱包发起；日志发送地址不代表付款授权':'地址、网络或合约尚未匹配返佣'):'未识别到可归属的返佣凭证';}
 }
 return rows;
}

export function configureWallets(evm,sol){if(evm&&!validAddress('1',evm)||sol&&!validAddress('solana',sol))throw Error('钱包地址格式错误');EVM=(evm||'').toLowerCase();SOL=sol||''}

export function pendingReview(records){return autoAccount(records).filter(r=>r.kind==='pending'&&!r.spam&&!r.supersededBy&&BigInt(r.raw)>0n)}

export function spamRecords(records){return autoAccount(records).filter(r=>r.spam&&!r.supersededBy&&BigInt(r.raw)>0n)}
