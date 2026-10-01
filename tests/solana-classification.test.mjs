import test from "node:test";
import assert from "node:assert/strict";
import {
  configureWallets,
  parseSolanaTransaction,
  autoAccount,
  pendingReview,
  spamRecords,
  summarize,
} from "../dist/ledger.mjs";
import { OKX_SOLANA_ROUTER } from "../dist/solana-classification.mjs";
import { validateState } from "../dist/validation.mjs";
import { configureAssetAllowlist } from "../dist/allowlist.mjs";
const own = "So11111111111111111111111111111111111111112",
  payer = "A".repeat(44),
  vault = "B".repeat(44),
  mint = "C".repeat(44),
  mint2 = "D".repeat(44),
  source = "E".repeat(44),
  destination = "F".repeat(44),
  commission = "G".repeat(44),
  platform = "H".repeat(44),
  signature = "J".repeat(88);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(hex) {
  let n = BigInt("0x" + hex),
    s = "";
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}
function fixture(self = false) {
  const user = self ? own : payer;
  return {
    blockTime: 1,
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: mint2,
          owner: user,
          uiTokenAmount: { decimals: 6, amount: "1000" },
        },
        {
          accountIndex: 2,
          mint,
          owner: user,
          uiTokenAmount: { decimals: 6, amount: "1000" },
        },
        {
          accountIndex: 3,
          mint,
          owner: own,
          uiTokenAmount: { decimals: 6, amount: "1000" },
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              program: "spl-token",
              programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              stackHeight: 2,
              parsed: {
                type: "transferChecked",
                info: {
                  source: self ? vault : destination,
                  destination: self ? destination : commission,
                  authority: self ? vault : payer,
                  mint,
                  tokenAmount: { amount: "1263318", decimals: 6 },
                },
              },
            },
          ],
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: user, signer: true },
          { pubkey: source },
          { pubkey: destination },
          { pubkey: commission },
        ],
        instructions: [
          {
            programId: OKX_SOLANA_ROUTER,
            accounts: [
              user,
              source,
              destination,
              mint2,
              mint,
              commission,
              platform,
            ],
            data: base58("f0e02621b01ff1af" + "00".repeat(40)),
          },
        ],
      },
    },
  };
}
const parse = (tx) => parseSolanaTransaction(tx, signature);
test("direct SwapV3 commission uses signed user and designated commission account without a Helius label", () => {
  configureWallets("", own);
  const rows = parse(fixture());
  assert.equal(rows[0].solanaCommission, true);
  const groups = summarize(autoAccount(rows));
  assert.equal(groups[0].trader, payer);
  assert.equal(groups[0].due, "1263318");
});
test("own SwapV3 is excluded, but signing an unrelated transaction is not sufficient", () => {
  configureWallets("", own);
  const tx = fixture(true),
    rows = parse(tx);
  assert.equal(rows[0].solanaSelfSwap, true);
  assert.equal(pendingReview(rows).length, 0);
  assert.equal(autoAccount(rows)[0].kind, "ignore");
  assert.equal(rows[0].kind, "pending");
  tx.meta.postTokenBalances[1].owner = payer;
  assert.equal(
    parse(tx).some((r) => r.solanaSelfSwap),
    false,
  );
});
test("impostor programs, other recipients, nested pool transfers, or missing signer cannot prove a commission", () => {
  configureWallets("", own);
  for (const modify of [
    (t) => (t.transaction.message.instructions[0].programId = payer),
    (t) => (t.transaction.message.instructions[0].accounts[5] = platform),
    (t) => (t.meta.innerInstructions[0].instructions[0].stackHeight = 3),
    (t) => (t.transaction.message.accountKeys[0].signer = false),
    (t) =>
      (t.transaction.message.instructions[0].data = base58(
        "00".repeat(8) + "01",
      )),
  ]) {
    const tx = fixture();
    modify(tx);
    assert.equal(
      parse(tx).some((r) => r.solanaCommission),
      false,
    );
  }
});
test("one lamport incoming SOL is dust even with native assets allowed; larger and outgoing amounts are not dust", () => {
  configureWallets("", own);
  configureAssetAllowlist([]);
  try {
    const r = {
      id: "dust",
      chain: "solana",
      hash: signature,
      asset: "native",
      symbol: "SOL",
      decimals: 9,
      raw: "1",
      from: payer,
      to: own,
      direction: "in",
      kind: "pending",
    };
    assert.equal(spamRecords([r]).length, 1);
    assert.equal(pendingReview([r]).length, 0);
    assert.equal(spamRecords([{ ...r, raw: "2" }]).length, 0);
    assert.equal(
      spamRecords([{ ...r, direction: "out", from: own, to: payer }]).length,
      0,
    );
    assert.equal(r.kind, "pending");
  } finally {
    configureAssetAllowlist(null);
  }
});

test("SwapV3 payer must be observed source token owner; a delegate signature or missing owner stays pending", () => {
  configureWallets("", own);
  for (const modify of [
    (t) => (t.meta.postTokenBalances[0].owner = vault),
    (t) => t.meta.postTokenBalances.shift(),
  ]) {
    const tx = fixture();
    modify(tx);
    const rows = parse(tx);
    assert.equal(
      rows.some((r) => r.solanaCommission),
      false,
    );
    assert.equal(summarize(autoAccount(rows)).length, 0);
    assert.equal(pendingReview(rows).length, 1);
  }
  // The official source-owner constraint allows the output to another receiver.
  const tx = fixture();
  tx.meta.postTokenBalances[1].owner = vault;
  const rows = parse(tx);
  assert.equal(rows[0].ownerVerified, true);
  assert.equal(summarize(autoAccount(rows))[0].trader, payer);
});
test("generated Solana commission proof fields survive strict local persistence", () => {
  configureWallets("", own);
  const rows = parse(fixture());
  const loaded = validateState(
    {
      version: 1,
      records: rows,
      coverage: {},
      selected: ["solana"],
      updated: "2026-10-01T00:00:00.000Z",
    },
    { wallets: { evm: "", sol: own }, trustEvidence: true },
  );
  assert.equal(loaded.records[0].ownerVerified, true);
  assert.equal(loaded.records[0].attributionMethod, "okx-swap-v3-source-owner");
  assert.deepEqual(
    summarize(autoAccount(loaded.records)),
    summarize(autoAccount(rows)),
  );
  const legacy = { ...rows[0] };
  delete legacy.ownerVerified;
  delete legacy.attributionMethod;
  assert.equal(summarize(autoAccount([legacy])).length, 0);
});
