import "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "./fixtures.mjs";
import {
  EVM,
  SOL,
  decodeFeeLogs,
  reconcileFeeReceipts,
  autoAccount,
  summarize,
  replaceTransactionRecords,
  decisionsFromLegacy,
  paymentEvidence,
  parseSolanaTransaction,
} from "../dist/ledger.mjs";
import { configureAssetAllowlist } from "../dist/allowlist.mjs";
const router = seed.from,
  trader = seed.trader,
  chain = { id: seed.chain, symbol: "ETH", decimals: 18 };
const tx = {
  hash: seed.hash,
  status: "ok",
  from: { hash: trader, is_contract: false },
  to: { hash: router },
  value: "0",
};
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const feeLog = {
  address: router,
  logIndex: 20,
  topics: [
    "0xcd5eae9d9d0b96532bd1b7dbf6628ce436b2af735829087a03c548439f8bf850",
  ],
  data:
    "0x" +
    "e".repeat(40).padStart(64, "0") +
    word(100) +
    EVM.slice(2).padStart(64, "0") +
    word(0),
};
const receipt = {
  ...seed,
  id: "receipt",
  raw: "100",
  kind: "pending",
  feeEvent: false,
};
const decoded = (transaction = tx, routers = [router]) =>
  decodeFeeLogs([feeLog], chain, transaction, {}, routers);
const account = (rows, fees) => {
  const result = reconcileFeeReceipts(rows, fees);
  return autoAccount([...result.replace, ...result.fees]);
};

test("full fee decoding → receipt reconciliation → accounting cannot bypass provenance", () => {
  assert.equal(summarize(account([receipt], decoded())).at(0).due, "100");
  for (const fees of [
    decoded(tx, []),
    decoded({ ...tx, from: { hash: router, is_contract: true } }),
    decoded({ ...tx, to: { hash: trader } }),
  ]) {
    assert.equal(summarize(account([receipt], fees)).length, 0);
    assert.equal(
      account([receipt], fees).find((r) => r.id === receipt.id).kind,
      "pending",
    );
  }
  // The old fee flag + matching amount + a superseded row is not an identity proof.
  const old = {
    ...seed,
    kind: "commission",
    feeEvent: true,
    receiptMatched: true,
  };
  assert.equal(
    summarize(
      autoAccount([
        old,
        { ...receipt, kind: "ignore", supersededBy: [old.id] },
      ]),
    ).length,
    0,
  );
  assert.equal(autoAccount([old])[0].needsProof, true);
});

test("unrelated or extra transfers do not hide a real fee, and cannot back an unfunded fee", () => {
  const other = "0x" + "9".repeat(40);
  for (const extra of [
    { ...receipt, id: "extra", raw: "3" },
    { ...receipt, id: "extra", raw: "3", from: other },
  ]) {
    const result = account([receipt, extra], decoded());
    assert.equal(summarize(result).at(0).due, "100");
    assert.equal(result.find((r) => r.id === "extra").kind, "pending");
  }
  assert.equal(
    summarize(account([{ ...receipt, from: other }], decoded())).length,
    0,
  );
  assert.equal(
    summarize(
      account(
        [
          { ...receipt, raw: "97" },
          { ...receipt, id: "unrelated", raw: "3", from: other },
        ],
        decoded(),
      ),
    ).length,
    0,
  );
  assert.equal(
    summarize(account([{ ...receipt, raw: "99" }], decoded())).length,
    0,
  );
});

test("Solana fee payer labels and payment sources cannot create a commission", () => {
  const who = "A".repeat(44);
  const label = {
    ...receipt,
    chain: "solana",
    decimals: 9,
    symbol: "SOL",
    from: who,
    to: SOL,
    trader: who,
    source: "OKX_DEX_ROUTER",
    suggestedTrader: who,
    raw: "100",
  };
  assert.equal(summarize(autoAccount([label])).length, 0);
  assert.equal(
    summarize(autoAccount([{ ...label, kind: "commission", automatic: true }]))
      .length,
    0,
  );
});

test("completed inspection removes disappeared derived events; manual choices stay separate", () => {
  const old = [
    { ...receipt, kind: "ignore", supersededBy: [seed.id] },
    { ...seed, feeEvent: true },
    { ...seed, id: "other-tx", hash: "0x" + "b".repeat(64) },
  ];
  const replaced = replaceTransactionRecords(old, [receipt], {
    chain: seed.chain,
    hash: seed.hash,
  });
  assert.equal(
    replaced.some((r) => r.id === seed.id),
    false,
  );
  assert.equal(
    replaced.some((r) => r.id === "other-tx"),
    true,
  );
  assert.equal(summarize(autoAccount(replaced)).length, 0);
  assert.deepEqual(
    replaceTransactionRecords(replaced, [], {
      chain: seed.chain,
      hash: seed.hash,
    }).map((r) => r.id),
    ["other-tx"],
  );
  assert.throws(
    () =>
      replaceTransactionRecords(old, [{ ...receipt, hash: "different" }], {
        chain: seed.chain,
        hash: seed.hash,
      }),
    /范围/,
  );
  const decisions = decisionsFromLegacy([
    { ...receipt, reviewed: true, kind: "commission", evidence: "人工确认" },
  ]);
  const reviewed = autoAccount([receipt], decisions)[0];
  assert.equal(reviewed.kind, "commission");
  assert.equal(reviewed.reviewed, true);
  assert.equal(receipt.reviewed, undefined);
  assert.equal(
    autoAccount([receipt], {
      [receipt.id]: { kind: "ignore", reason: "本人付款" },
    })[0].kind,
    "ignore",
  );
  assert.equal(
    autoAccount([receipt], {
      [receipt.id]: { kind: "pending", reason: "待再核验" },
    })[0].kind,
    "pending",
  );
});

test("direct signed EVM payments may offset, contract calls and arbitrary Transfer logs cannot", () => {
  const payment = {
    ...receipt,
    direction: "out",
    from: EVM,
    to: trader,
    raw: "40",
  };
  const direct = {
    hash: seed.hash,
    from: { hash: EVM },
    to: { hash: trader },
    value: "40",
    input: "0x",
  };
  assert.deepEqual(paymentEvidence(direct, payment), {
    txSender: EVM,
    directTokenTransfer: false,
    directTransfer: true,
    paymentAuthorized: true,
  });
  const fee = account([receipt], decoded()).find((r) => r.feeEvent);
  const result = autoAccount([
    fee,
    { ...payment, id: "direct", ...paymentEvidence(direct, payment) },
    {
      ...payment,
      id: "contract",
      ...paymentEvidence(
        { ...direct, to: { hash: router }, input: "0x12345678" },
        payment,
      ),
    },
  ]);
  assert.equal(result.find((r) => r.id === "direct").kind, "refund");
  assert.equal(result.find((r) => r.id === "contract").kind, "pending");
  assert.equal(summarize(result)[0].paid, "40");
});

test("Solana outgoing source ownership is insufficient without direct wallet authority and signature", () => {
  const mint = "C".repeat(44),
    recipient = "D".repeat(44),
    source = "E".repeat(44),
    destination = "F".repeat(44),
    delegate = "G".repeat(44);
  const build = (authority = SOL, signed = true, inner = false) => {
    const instruction = {
      program: "spl-token",
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      parsed: {
        type: "transferChecked",
        info: {
          source,
          destination,
          authority,
          mint,
          tokenAmount: { amount: "40", decimals: 6 },
        },
      },
    };
    return {
      blockTime: 1,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: SOL, signer: signed },
            { pubkey: source },
            { pubkey: destination },
          ],
          instructions: inner ? [{ programId: delegate }] : [instruction],
        },
      },
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 1, mint, owner: SOL, uiTokenAmount: { decimals: 6 } },
          {
            accountIndex: 2,
            mint,
            owner: recipient,
            uiTokenAmount: { decimals: 6 },
          },
        ],
        postTokenBalances: [],
        innerInstructions: inner
          ? [{ index: 0, instructions: [instruction] }]
          : [],
      },
    };
  };
  const proof = {
    ...receipt,
    id: "solfee",
    chain: "solana",
    asset: mint,
    decimals: 6,
    from: recipient,
    to: SOL,
    trader: recipient,
    solanaCommission: true,
    attributionVerified: true,
    ownerVerified: true,
    attributionMethod: "okx-swap-v3-source-owner",
  };
  const direct = parseSolanaTransaction(build(), "direct");
  assert.equal(direct[0].paymentAuthorized, true);
  assert.equal(
    autoAccount([proof, ...direct]).find((r) => r.hash === "direct").kind,
    "refund",
  );
  for (const transaction of [
    build(delegate),
    build(SOL, false),
    build(SOL, true, true),
  ]) {
    const rows = parseSolanaTransaction(transaction, "unproven");
    assert.notEqual(rows[0].paymentAuthorized, true);
    assert.equal(
      autoAccount([proof, ...rows]).find((r) => r.hash === "unproven").kind,
      "pending",
    );
  }
});

test("imported flags cannot book funds; dust dismissal does not bypass asset policy", () => {
  const fee = account([receipt], decoded()).find((r) => r.feeEvent);
  assert.equal(
    summarize(autoAccount([{ ...fee, importedUnverified: true }])).length,
    0,
  );
  const dust = {
    ...receipt,
    id: "dust",
    chain: "solana",
    from: "A".repeat(44),
    to: SOL,
    raw: "1",
  };
  assert.equal(autoAccount([dust])[0].spam, true);
  assert.equal(
    autoAccount([dust], {
      dust: { kind: "pending", keep: true, reason: "保留待核对" },
    })[0].spam,
    undefined,
  );
  configureAssetAllowlist([]);
  try {
    const token = { ...receipt, asset: "0x" + "5".repeat(40) };
    assert.equal(
      autoAccount([token], {
        [token.id]: { kind: "commission", trader, keep: true },
      })[0].spam,
      true,
    );
  } finally {
    configureAssetAllowlist(null);
  }
});

test("reinspection releases stale machine supersession while preserving an explicit human decision", () => {
  const reviewed = {
    ...receipt,
    kind: "commission",
    reviewed: true,
    supersededBy: ["gone-fee"],
  };
  const result = reconcileFeeReceipts([reviewed], []);
  assert.equal(result.replace[0].supersededBy, undefined);
  assert.equal(summarize(autoAccount(result.replace))[0].due, "100");
  const valid = decoded();
  assert.equal(
    summarize(account([receipt], [...valid, ...valid]))[0].due,
    "100",
  );
});
