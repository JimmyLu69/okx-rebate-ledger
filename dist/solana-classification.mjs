// OKX published SwapV3 account layout: payer, source ATA, destination ATA,
// source mint, destination mint, commission account, platform fee account.
// https://github.com/okxlabs/Web3-DEX-Router-Solana-V1/blob/main/programs/dex-solana/src/instructions/swap_v3.rs
export const OKX_SOLANA_ROUTER = "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function discriminator(encoded) {
  if (typeof encoded !== "string" || encoded.length > 20000) return "";
  let n = 0n;
  for (const c of encoded) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) return "";
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  hex = "00".repeat(encoded.match(/^1*/)[0].length) + hex;
  return hex.slice(0, 16);
}
export function classifySolanaRows(tx, rows, wallet) {
  if (tx.meta?.err) return rows;
  const message = tx.transaction.message,
    accountKeys = message.accountKeys;
  const signers = new Set(
    accountKeys
      .filter((k, i) =>
        typeof k === "string"
          ? i < (message.header?.numRequiredSignatures || 0)
          : k.signer === true,
      )
      .map((k) => (typeof k === "string" ? k : k.pubkey)),
  );
  const owners = new Map(
    [
      ...(tx.meta.preTokenBalances || []),
      ...(tx.meta.postTokenBalances || []),
    ].map((b) => [
      typeof accountKeys[b.accountIndex] === "string"
        ? accountKeys[b.accountIndex]
        : accountKeys[b.accountIndex]?.pubkey,
      b.owner,
    ]),
  );
  return rows.map((r) => {
    const path = r.id.split(":ix:")[1]?.split(".").map(Number);
    if (!path) return r;
    if (path.length === 1) {
      const instruction = message.instructions[path[0]],
        info = instruction?.parsed?.info;
      const direct =
        !!info &&
        ["transfer", "transferChecked", "transferCheckedWithFee"].includes(
          instruction.parsed.type,
        ) &&
        r.direction === "out" &&
        r.from === wallet;
      const authorized =
        direct &&
        signers.has(wallet) &&
        (r.asset === "native"
          ? instruction.programId === SYSTEM_PROGRAM && info.source === wallet
          : TOKEN_PROGRAMS.has(instruction.programId) &&
            info.authority === wallet &&
            owners.get(info.source) === wallet);
      return {
        ...r,
        paymentAuthorized: !!authorized,
        directTransfer: !!authorized,
        txSender: authorized ? wallet : "",
        roles: {
          owner: r.from,
          recipient: r.to,
          authority: info?.authority || info?.source || "",
          feePayer:
            typeof accountKeys[0] === "string"
              ? accountKeys[0]
              : accountKeys[0]?.pubkey,
        },
      };
    }
    if (path.length !== 2) return r;
    const top = message.instructions[path[0]],
      ix = tx.meta.innerInstructions?.find((g) => g.index === path[0])
        ?.instructions[path[1]];
    if (
      top?.programId !== OKX_SOLANA_ROUTER ||
      discriminator(top.data) !== "f0e02621b01ff1af" ||
      !Array.isArray(top.accounts) ||
      top.accounts.length < 7
    )
      return r;
    const [
      payer,
      source,
      destination,
      sourceMint,
      destinationMint,
      commission,
    ] = top.accounts;
    if (!signers.has(payer)) return r;
    // The published swap_v3 instruction constrains source_token_account with
    // token::authority = payer. Check the observed token owner independently:
    // a fee payer or delegate signature alone cannot establish the trader.
    // Destination ownership is not constrained by that instruction (a swap can
    // nominate another receiver), so the input owner is the protocol identity.
    if (owners.get(source) !== payer) return r;
    // Wallet signing alone is insufficient: verify both swap token accounts belong to it.
    if (
      payer === wallet &&
      owners.get(source) === wallet &&
      owners.get(destination) === wallet
    ) {
      return {
        ...r,
        solanaSelfSwap: true,
        txSender: payer,
        evidence:
          "本钱包签名的 OKX SwapV3 换币，源 / 目标代币账户均属于本钱包；非返佣或返还",
      };
    }
    const info = ix?.parsed?.info;
    if (
      payer === wallet ||
      ix?.stackHeight !== 2 ||
      !info ||
      r.direction !== "in" ||
      r.to !== wallet
    )
      return r;
    const mintMatches =
      r.asset === "native"
        ? [sourceMint, destinationMint].includes(
            "So11111111111111111111111111111111111111112",
          )
        : [sourceMint, destinationMint].includes(r.asset);
    const recipientMatches =
      info.destination === commission &&
      (r.asset === "native"
        ? commission === wallet
        : owners.get(commission) === wallet);
    const senderMatches =
      r.asset === "native"
        ? info.source === payer
        : info.authority === payer &&
          [source, destination].includes(info.source);
    if (mintMatches && recipientMatches && senderMatches)
      return {
        ...r,
        solanaCommission: true,
        attributionVerified: true,
        ownerVerified: true,
        attributionMethod: "okx-swap-v3-source-owner",
        trader: payer,
        txSender: payer,
        roles: {
          router: OKX_SOLANA_ROUTER,
          owner: payer,
          authority: info.authority || info.source,
          feePayer:
            typeof accountKeys[0] === "string"
              ? accountKeys[0]
              : accountKeys[0]?.pubkey,
        },
        evidence:
          "OKX SwapV3 指定返佣账户实际到账；归属已验证的输入资产持有人与签名用户",
      };
    return r;
  });
}
