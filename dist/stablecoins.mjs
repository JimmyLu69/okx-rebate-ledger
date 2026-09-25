// Maintained chain + contract identities; user labels never determine pricing.
const fixedUsdAssets=new Set([
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "5042:0x3600000000000000000000000000000000000000",
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "57073:0x2d270e6886d130d724215a266106e6832161eaed",
  "59144:0x176211869ca2b568f2a7d4ee941e073a821ee1ff",
  "10:0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  "137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "196:0xb6ceceab302e2e4948951ee7843fc24e92933061",
  "1:0xdac17f958d2ee523a2206206994597c13d831ec7",
  "56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  "56:0x55d398326f99059ff775485246999027b3197955",
  "solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "solana:USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  "8453:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
  "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"
]);
export function fixedUsdPrice(chain,asset,now=Date.now()){
 const key=chain+':'+(chain==='solana'?asset:asset?.toLowerCase());
 return fixedUsdAssets.has(key)?{usd:'1',at:now,source:'固定记账价 · 1 USD',fixed:true}:null;
}
