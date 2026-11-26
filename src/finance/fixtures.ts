import type {
  ChargebackWebhookRecord,
  OrderLineRecord,
  ScenarioFixture,
  SellerId,
  SellerProfile,
  SettlementRecord,
} from "./types.js";

const SELLERS: Record<SellerId, SellerProfile> = {
  "SELLER-A": {
    id: "SELLER-A",
    name: "Nairobi Streetwear Co.",
    settlementAccount: "ACCT-KE-A100",
  },
  "SELLER-B": {
    id: "SELLER-B",
    name: "Rift Valley Footwear",
    settlementAccount: "ACCT-KE-B200",
  },
};

const ORDER_LINES: readonly OrderLineRecord[] = [
  {
    lineId: "LINE-402-A",
    checkoutId: "CHK-402",
    sellerId: "SELLER-A",
    sku: "JKT-NVY-L",
    itemTitle: "Navy Quilted Winter Jacket (Size L)",
    amountKsh: 10_000,
  },
  {
    lineId: "LINE-402-B",
    checkoutId: "CHK-402",
    sellerId: "SELLER-B",
    sku: "BTS-TAN-42",
    itemTitle: "Tan Leather Chelsea Boots (Size 42)",
    amountKsh: 10_000,
  },
];

const PRIOR_BATCH_GROSS: Record<SellerId, number> = {
  "SELLER-A": 50_000,
  "SELLER-B": 30_000,
};

const POLICY_SUMMARY = [
  "Marketplace Black Friday Refund & Payout Policy (POL-BF-2026):",
  "1. Seller debit liability follows the physically returned item verified by warehouse inspection.",
  "2. Never release a seller deduction when physical return receipt is missing or SKU/seller is unverified (fail closed).",
  "3. Block any cross-system refund or seller-payout proposal when an active PSP/bank dispute is verified against the original payment (even when a card processor blocks same-charge refunds, OMS/support/payout workflows can still issue unsafe cross-system credits).",
  "4. If an incoming dispute only partially matches the payment, hold for operator verification instead of auto-approving or auto-freezing as a confirmed match.",
  "5. Any proposal based on a superseded evidence epoch MUST be invalidated and revalidated against the latest verified record.",
].join("\n");

function baseSettlements(includePostedRefund: boolean): readonly SettlementRecord[] {
  const rows: SettlementRecord[] = [
    {
      settlementId: "STL-PAY-402",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      kind: "CAPTURE",
      amountKsh: 20_000,
      cardLast4: "4421",
      postedAt: "2026-11-26T09:15:00+03:00",
    },
  ];
  if (includePostedRefund) {
    rows.push({
      settlementId: "STL-REF-402",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      kind: "REFUND",
      amountKsh: 10_000,
      cardLast4: "4421",
      postedAt: "2026-11-26T14:05:00+03:00",
    });
  }
  return rows;
}

export const SCENARIOS: readonly ScenarioFixture[] = [
  {
    id: "case-1-clean-allocation",
    title: "1. Clean Allocation (Verified Pass)",
    shortLabel: "Clean Pass",
    summary:
      "Customer returned Seller A's jacket, warehouse verified it, and the draft already debits Seller A (A: KSh 50,000 / B: KSh 40,000). Both agents agree and clear for approval.",
    policySummary: POLICY_SUMMARY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-402",
    sellers: SELLERS,
    priorBatchGrossBySellerKsh: PRIOR_BATCH_GROSS,
    orderLines: ORDER_LINES,
    settlements: baseSettlements(true),
    draft: {
      draftId: "DRF-101",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      debitedSellerId: "SELLER-A",
      refundAmountKsh: 10_000,
      totalBatchSettlementKsh: 90_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 10_000,
          netPayoutKsh: 50_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 40_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 40_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-101",
      checkoutId: "CHK-402",
      submittedAt: "2026-11-26T13:40:00+03:00",
      requestedRefundKsh: 10_000,
      message:
        "Hi team, I returned the navy quilted winter jacket from checkout CHK-402 because the zipper was loose. Please confirm my KSh 10,000 refund.",
    },
    initialWarehouseNote: {
      noteId: "WH-101",
      receivedAt: "2026-11-26T14:12:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "Intake confirmed for CHK-402: received 1x Navy Quilted Winter Jacket (tag JKT-NVY-L), loose zipper verified. Logged to Nairobi Streetwear Co. return bin.",
    },
  },
  {
    id: "case-2-wrong-seller-zerosum",
    title: "2. Wrong Seller Allocation (Same KSh 90,000 Total)",
    shortLabel: "Zero-Sum Trap",
    summary:
      "The batch balances exactly at KSh 90,000, but the draft debits Seller B (A: 60k / B: 30k). Free-text warehouse intake proves Seller A's jacket came back, so the interceptor blocks and flips to A: 50k / B: 40k.",
    policySummary: POLICY_SUMMARY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-402",
    sellers: SELLERS,
    priorBatchGrossBySellerKsh: PRIOR_BATCH_GROSS,
    orderLines: ORDER_LINES,
    settlements: baseSettlements(true),
    draft: {
      draftId: "DRF-202",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      debitedSellerId: "SELLER-B",
      refundAmountKsh: 10_000,
      totalBatchSettlementKsh: 90_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 60_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 40_000,
          refundDeductionKsh: 10_000,
          netPayoutKsh: 30_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-202",
      checkoutId: "CHK-402",
      submittedAt: "2026-11-26T13:50:00+03:00",
      requestedRefundKsh: 10_000,
      message:
        "Hello, I sent back one of the two KSh 10,000 items from Black Friday checkout CHK-402. Please finalize the KSh 10,000 refund deduction.",
    },
    initialWarehouseNote: {
      noteId: "WH-202",
      receivedAt: "2026-11-26T14:18:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "Parcel arrived without RMA sticker for CHK-402. Opened box: inside is 1x Navy Quilted Winter Jacket size L (Nairobi Streetwear label JKT-NVY-L). No boots in parcel.",
    },
  },
  {
    id: "case-3-missing-evidence",
    title: "3. Missing Warehouse Evidence (Fail-Closed Hold)",
    shortLabel: "Missing Evidence",
    summary:
      "Processor refund posted and draft debits Seller B, but warehouse intake shows no physical parcel received yet. Interceptor fails closed and holds the unsettled checkout lines.",
    policySummary: POLICY_SUMMARY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-402",
    sellers: SELLERS,
    priorBatchGrossBySellerKsh: PRIOR_BATCH_GROSS,
    orderLines: ORDER_LINES,
    settlements: baseSettlements(true),
    draft: {
      draftId: "DRF-303",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      debitedSellerId: "SELLER-B",
      refundAmountKsh: 10_000,
      totalBatchSettlementKsh: 90_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 60_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 40_000,
          refundDeductionKsh: 10_000,
          netPayoutKsh: 30_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-303",
      checkoutId: "CHK-402",
      submittedAt: "2026-11-26T14:00:00+03:00",
      requestedRefundKsh: 10_000,
      message:
        "I dropped off my return from CHK-402 at the courier counter. Please approve the KSh 10,000 refund deduction now.",
    },
    initialWarehouseNote: {
      noteId: "WH-303",
      receivedAt: "2026-11-26T14:20:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "No parcel scanned at hub for CHK-402 yet. Courier waybill shows label created only; item contents and seller SKU unverified.",
    },
  },
  {
    id: "case-4-late-correction-midflight",
    title: "4. Late Warehouse Correction Mid-Flight (Epoch Invalidation)",
    shortLabel: "Mid-Flight Correction",
    summary:
      "Initial note tentatively names Seller B's footwear box, so Agent 1 starts approving Seller B. Mid-flight, QC opens the box, finds Seller A's jacket, bumps epoch 1->2, and the interceptor rejects the stale approval.",
    policySummary: POLICY_SUMMARY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-402",
    sellers: SELLERS,
    priorBatchGrossBySellerKsh: PRIOR_BATCH_GROSS,
    orderLines: ORDER_LINES,
    settlements: baseSettlements(true),
    draft: {
      draftId: "DRF-404",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      debitedSellerId: "SELLER-B",
      refundAmountKsh: 10_000,
      totalBatchSettlementKsh: 90_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 60_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 40_000,
          refundDeductionKsh: 10_000,
          netPayoutKsh: 30_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-404",
      checkoutId: "CHK-402",
      submittedAt: "2026-11-26T14:05:00+03:00",
      requestedRefundKsh: 10_000,
      message:
        "Returning one item from CHK-402 in the original delivery carton. Please release the KSh 10,000 payout adjustment.",
    },
    initialWarehouseNote: {
      noteId: "WH-404-V1",
      receivedAt: "2026-11-26T14:22:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "Preliminary dock scan CHK-402: Rift Valley Footwear shoebox received on belt (tentative Tan Chelsea Boots, Seller B). Pending bench open.",
    },
    midFlightInjection: {
      delayMs: 110,
      kind: "WAREHOUSE_CORRECTION",
      warehouseNote: {
        noteId: "WH-404-V2",
        receivedAt: "2026-11-26T14:23:05+03:00",
        hub: "Kisumu Returns Hub (QC Bench)",
        supersedesNoteId: "WH-404-V1",
        text: "CORRECTION superseding WH-404-V1: Opened the shoebox at QC bench. Inside is actually the Navy Quilted Winter Jacket (SKU JKT-NVY-L, Nairobi Streetwear / Seller A). Customer reused the boot box; boots were NOT returned.",
      },
    },
  },
  {
    id: "case-5-chargeback-collision",
    title: "5. Mid-Flight Chargeback Collision (Cross-System Refund Blocked)",
    shortLabel: "Dispute Collision",
    summary:
      "Customer demands an immediate Black Friday refund while an active PSP dispute verified against STL-PAY-402 / card 4421 arrives mid-flight. Sentinel correlates the dispute and the interceptor blocks the unsafe cross-system refund proposal.",
    policySummary: POLICY_SUMMARY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-402",
    sellers: SELLERS,
    priorBatchGrossBySellerKsh: PRIOR_BATCH_GROSS,
    orderLines: ORDER_LINES,
    settlements: baseSettlements(false),
    draft: {
      draftId: "DRF-505",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-402",
      debitedSellerId: "SELLER-A",
      refundAmountKsh: 10_000,
      totalBatchSettlementKsh: 100_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 60_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 40_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 40_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-505",
      checkoutId: "CHK-402",
      submittedAt: "2026-11-26T14:30:00+03:00",
      requestedRefundKsh: 10_000,
      message:
        "Black Friday urgent: my navy quilted jacket from CHK-402 arrived defective and I returned it. Please issue my KSh 10,000 refund immediately.",
    },
    initialWarehouseNote: {
      noteId: "WH-505",
      receivedAt: "2026-11-26T14:28:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "Intake verified for CHK-402: 1x Navy Quilted Winter Jacket (JKT-NVY-L, Seller A) logged at return desk.",
    },
    midFlightInjection: {
      delayMs: 110,
      kind: "CHARGEBACK_WEBHOOK",
      chargeback: {
        disputeId: "DSP-505",
        status: "OPEN",
        receivedAt: "2026-11-26T14:30:04+03:00",
        pspReferenceSuffix: "402",
        paymentSettlementId: "STL-PAY-402",
        cardLast4: "4421",
        amountKsh: 10_000,
        reasonCode: "VISA_13.1_MERCHANDISE_NOT_RECEIVED",
        narrative:
          "Active issuing-bank dispute opened on card ending 4421 for KSh 10,000 (merchant checkout ref ending 402, settlement STL-PAY-402): cardholder disputes navy jacket charge while requesting store refund.",
      },
    },
  },
];

export function getScenarioById(id: string): ScenarioFixture {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown scenario id: ${id}`);
  }
  return found;
}

export function createUnrelatedDisputeFixture(): ChargebackWebhookRecord {
  return {
    disputeId: "DSP-UNREL-999",
    status: "OPEN",
    receivedAt: "2026-11-26T14:31:00+03:00",
    pspReferenceSuffix: "999",
    paymentSettlementId: "STL-PAY-999",
    cardLast4: "8812",
    amountKsh: 4_500,
    reasonCode: "VISA_10.4_FRAUD",
    narrative:
      "Active bank dispute on unrelated checkout CHK-999, card ending 8812, amount KSh 4,500.",
  };
}

export function createAmbiguousDisputeFixture(): ChargebackWebhookRecord {
  return {
    disputeId: "DSP-AMBIG-4421",
    status: "OPEN",
    receivedAt: "2026-11-26T14:32:00+03:00",
    pspReferenceSuffix: "988",
    cardLast4: "4421",
    amountKsh: 10_000,
    reasonCode: "VISA_13.1_MERCHANDISE_NOT_RECEIVED",
    narrative:
      "Active bank dispute on card ending 4421 for KSh 10,000, but PSP reference suffix 988 does not match checkout CHK-402.",
  };
}
