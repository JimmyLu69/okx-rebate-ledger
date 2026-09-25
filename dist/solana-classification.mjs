// OKX published SwapV3 account layout: payer, source ATA, destination ATA,
// source mint, destination mint, commission account, platform fee account.
// https://github.com/okxlabs/Web3-DEX-Router-Solana-V1/blob/main/programs/dex-solana/src/instructions/swap_v3.rs
export const OKX_SOLANA_ROUTER='6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function discriminator(encoded){
 if(typeof encoded!=='string'||encoded.length>20000)return '';
 let n=0n;for(const c of encoded){const digit=alphabet.indexOf(c);if(digit<0)return '';n=n*58n+BigInt(digit)}
 let hex=n.toString(16);if(hex.length%2)hex='0'+hex;
 hex='00'.repeat(encoded.match(/^1*/)[0].length)+hex;return hex.slice(0,16);
}
export function classifySolanaRows(tx,rows,wallet){
 if(tx.meta?.err)return rows;
 const message=tx.transaction.message,accountKeys=message.accountKeys;
 const signers=new Set(accountKeys.filter(k=>k.signer===true).map(k=>k.pubkey));
 const owners=new Map([...tx.meta.preTokenBalances||[],...tx.meta.postTokenBalances||[]].map(b=>[typeof accountKeys[b.accountIndex]==='string'?accountKeys[b.accountIndex]:accountKeys[b.accountIndex]?.pubkey,b.owner]));
 return rows.map(r=>{
  const path=r.id.split(':ix:')[1]?.split('.').map(Number);if(!path||path.length!==2)return r;
  const top=message.instructions[path[0]],ix=tx.meta.innerInstructions?.find(g=>g.index===path[0])?.instructions[path[1]];
  if(top?.programId!==OKX_SOLANA_ROUTER||discriminator(top.data)!=='f0e02621b01ff1af'||!Array.isArray(top.accounts)||top.accounts.length<7)return r;
  const [payer,source,destination,sourceMint,destinationMint,commission]=top.accounts;
  if(!signers.has(payer))return r;
  // Wallet signing alone is insufficient: verify both swap token accounts belong to it.
  if(payer===wallet&&owners.get(source)===wallet&&owners.get(destination)===wallet){
   return {...r,solanaSelfSwap:true,txSender:payer,evidence:'本钱包签名的 OKX SwapV3 换币，源 / 目标代币账户均属于本钱包；非返佣或返还'};
  }
  const info=ix?.parsed?.info;
  if(payer===wallet||ix?.stackHeight!==2||!info||r.direction!=='in'||r.to!==wallet)return r;
  const mintMatches=r.asset==='native'?[sourceMint,destinationMint].includes('So11111111111111111111111111111111111111112'):[sourceMint,destinationMint].includes(r.asset);
  const recipientMatches=info.destination===commission&&(r.asset==='native'?commission===wallet:owners.get(commission)===wallet);
  const senderMatches=r.asset==='native'?info.source===payer:info.authority===payer&&[source,destination].includes(info.source);
  if(mintMatches&&recipientMatches&&senderMatches)return {...r,solanaCommission:true,attributionVerified:true,trader:payer,txSender:payer,evidence:'OKX SwapV3 返佣账户实际到账；归属经签名验证的交易用户'};
  return r;
 });
}
