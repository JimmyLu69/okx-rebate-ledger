export const COMMON_CHAINS = [
  "4663",
  "solana",
  "56",
  "196",
  "1",
  "8453",
  "137",
  "10",
  "42161",
  "5042",
  "57073",
  "59144",
];
export const EXTRA_CHAINS = [
  {
    id: "solana",
    name: "Solana",
    symbol: "SOL",
    decimals: 9,
    explorer: "https://solscan.io",
  },
  {
    id: "56",
    name: "BNB Chain",
    symbol: "BNB",
    decimals: 18,
    explorer: "https://bscscan.com",
    provider: "nodereal",
  },
  {
    id: "196",
    name: "X Layer",
    symbol: "OKB",
    decimals: 18,
    explorer: "https://www.oklink.com/xlayer",
    provider: "xlayer",
  },
  {
    id: "59144",
    name: "Linea",
    symbol: "ETH",
    decimals: 18,
    explorer: "https://lineascan.build",
    provider: "etherscan",
  },
];
export const providerFor = (chain) =>
  chain.id === "solana" ? "helius" : chain.provider || "blockscout";
export const credentialFields = {
  blockscoutKey: "blockscout",
  heliusKey: "helius",
  noderealKey: "nodereal",
  etherscanKey: "etherscan",
};
export const emptyKeys = () => ({
  blockscout: "",
  helius: "",
  nodereal: "",
  etherscan: "",
  xlayer: null,
});
