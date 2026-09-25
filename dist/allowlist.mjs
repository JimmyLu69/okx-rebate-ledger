export const revokedAsset=(chain,asset)=>chain==='8453'&&asset?.toLowerCase()==='0x006a8a2b11b44a402428492fd5b9b5a483090614';
let allowed=null;
export function normalizeAllowlist(rows){
 if(!Array.isArray(rows)||rows.length>10000)throw Error('白名单必须为数组，最多一万项');
 const result=new Map();for(const r of rows){const chain=String(r?.chain||''),asset=String(r?.asset||'').trim();
  if(!/^(?:solana|[1-9]\d{0,11})$/.test(chain)||!(chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[0-9a-fA-F]{40}$/).test(asset))throw Error('白名单的网络或合约地址格式错误');
  const normalized={chain,asset:chain==='solana'?asset:asset.toLowerCase()};result.set(chain+':'+normalized.asset,normalized);
 }return [...result.values()];
}
export function parseAllowlist(text){return normalizeAllowlist(text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(line=>{const [chain,asset,...extra]=line.split(/[\s,]+/);if(extra.length)throw Error('每行填写：链 ID 合约地址');return {chain,asset}}))}
export function formatAllowlist(rows){return rows.map(r=>r.chain+' '+r.asset).join('\n')}
export function configureAssetAllowlist(rows){allowed=rows===null?null:new Set(normalizeAllowlist(rows).map(r=>r.chain+':'+r.asset))}
export function allowlistEnabled(){return allowed!==null}
export function assetAllowed(chain,asset){return !revokedAsset(chain,asset)&&(asset==='native'||allowed===null||allowed.has(chain+':'+(chain==='solana'?asset:asset?.toLowerCase())))}

// Only newly introduced defaults are merged; explicit removals stay removed.
export function upgradeAllowlist(saved,defaults){
 const current=normalizeAllowlist(defaults);
 if(saved===null)return {assets:current,knownDefaults:current};
 const legacy=Array.isArray(saved);
 const assets=normalizeAllowlist(legacy?saved:saved.assets).filter(r=>!revokedAsset(r.chain,r.asset));
 const known=normalizeAllowlist(legacy?defaults.filter(r=>(r.introduced||1)<=1):saved.knownDefaults);
 const keys=new Set(known.map(r=>r.chain+':'+r.asset));
 return {assets:normalizeAllowlist([...assets,...current.filter(r=>!keys.has(r.chain+':'+r.asset))]),knownDefaults:current};
}
