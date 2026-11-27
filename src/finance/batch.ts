import { getScenarioById } from "./fixtures.js";
import type { ScenarioFixture } from "./types.js";

const BATCH_POLICY = [
  "Marketplace Black Friday Batch Payout Policy (POL-BF-2026):",
  "1. Seller refund deduction follows the physically returned SKU verified at the returns hub.",
  "2. Never release an unverified seller deduction when physical receipt is missing.",
  "3. Block unsafe cross-system refund/payout proposals when an active PSP dispute is verified against the original capture.",
  "4. Any proposal invalidated by a late evidence update must be revalidated on the current epoch.",
].join("\n");

/**
 * Realistic 4-checkout, 8-seller Black Friday Settlement Batch (`BATCH-BF-2026-01`).
 * Each checkout has distinct orders, sellers, SKUs, cards, and warehouse intake notes:
 * - CHK-402: Mid-flight QC warehouse correction (zero-sum wrong-seller trap)
 * - CHK-518: Clean verified electronics return (auto-cleared)
 * - CHK-629: Missing physical return parcel for homeware (fail-closed hold)
 * - CHK-741: Active linked bank dispute on specialty coffee/leather checkout (frozen)
 */
export const BLACK_FRIDAY_BATCH_CHECKOUTS: readonly ScenarioFixture[] = [
  getScenarioById("case-4-late-correction-midflight"),
  {
    id: "batch-chk-518-clean-audio",
    title: "CHK-518: Electronics Return (Clean Pass)",
    shortLabel: "CHK-518 Clean",
    summary:
      "Customer returned Kilimani Audio headphones (SKU AUD-PRO-01). Warehouse confirmed receipt and draft already debits Kilimani Audio.",
    policySummary: BATCH_POLICY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-518",
    sellers: {
      "SELLER-A": {
        id: "SELLER-A",
        name: "Kilimani Audio Ltd",
        settlementAccount: "ACCT-KE-A518",
      },
      "SELLER-B": {
        id: "SELLER-B",
        name: "Mombasa Tech Gear",
        settlementAccount: "ACCT-KE-B518",
      },
    },
    priorBatchGrossBySellerKsh: {
      "SELLER-A": 45_000,
      "SELLER-B": 35_000,
    },
    orderLines: [
      {
        lineId: "LINE-518-A",
        checkoutId: "CHK-518",
        sellerId: "SELLER-A",
        sku: "AUD-PRO-01",
        itemTitle: "Studio Noise-Canceling Headphones",
        amountKsh: 15_000,
      },
      {
        lineId: "LINE-518-B",
        checkoutId: "CHK-518",
        sellerId: "SELLER-B",
        sku: "DOCK-USB-7P",
        itemTitle: "7-Port Aluminum USB-C Dock",
        amountKsh: 15_000,
      },
    ],
    settlements: [
      {
        settlementId: "STL-PAY-518",
        batchId: "BATCH-BF-2026-01",
        checkoutId: "CHK-518",
        kind: "CAPTURE",
        amountKsh: 30_000,
        cardLast4: "6104",
        postedAt: "2026-11-26T10:10:00+03:00",
      },
      {
        settlementId: "STL-REF-518",
        batchId: "BATCH-BF-2026-01",
        checkoutId: "CHK-518",
        kind: "REFUND",
        amountKsh: 15_000,
        cardLast4: "6104",
        postedAt: "2026-11-26T15:02:00+03:00",
      },
    ],
    draft: {
      draftId: "DRF-518",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-518",
      debitedSellerId: "SELLER-A",
      refundAmountKsh: 15_000,
      totalBatchSettlementKsh: 95_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 60_000,
          refundDeductionKsh: 15_000,
          netPayoutKsh: 45_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 50_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 50_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-518",
      checkoutId: "CHK-518",
      submittedAt: "2026-11-26T14:40:00+03:00",
      requestedRefundKsh: 15_000,
      message:
        "Returned the Studio Noise-Canceling Headphones from CHK-518; left earcup static. Please confirm KSh 15,000 refund.",
    },
    initialWarehouseNote: {
      noteId: "WH-518",
      receivedAt: "2026-11-26T15:00:00+03:00",
      hub: "Nairobi Industrial Returns Hub",
      text: "Checked in CHK-518: 1x Studio Noise-Canceling Headphones (SKU AUD-PRO-01, Kilimani Audio Ltd). Serial verified; USB-C dock kept by buyer.",
    },
  },
  {
    id: "batch-chk-629-missing-homeware",
    title: "CHK-629: Homeware Return (Missing Receipt)",
    shortLabel: "CHK-629 Missing",
    summary:
      "Refund draft debits Kisumu Ceramics KSh 8,000, but warehouse scan shows no physical parcel received yet. Held fail-closed.",
    policySummary: BATCH_POLICY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-629",
    sellers: {
      "SELLER-A": {
        id: "SELLER-A",
        name: "Eldoret Homeware",
        settlementAccount: "ACCT-KE-A629",
      },
      "SELLER-B": {
        id: "SELLER-B",
        name: "Kisumu Ceramics Studio",
        settlementAccount: "ACCT-KE-B629",
      },
    },
    priorBatchGrossBySellerKsh: {
      "SELLER-A": 22_000,
      "SELLER-B": 18_000,
    },
    orderLines: [
      {
        lineId: "LINE-629-A",
        checkoutId: "CHK-629",
        sellerId: "SELLER-A",
        sku: "PAN-IRON-12",
        itemTitle: "12-Inch Cast Iron Skillet",
        amountKsh: 8_000,
      },
      {
        lineId: "LINE-629-B",
        checkoutId: "CHK-629",
        sellerId: "SELLER-B",
        sku: "CER-DIN-06",
        itemTitle: "Handcrafted Clay Dinner Set",
        amountKsh: 8_000,
      },
    ],
    settlements: [
      {
        settlementId: "STL-PAY-629",
        batchId: "BATCH-BF-2026-01",
        checkoutId: "CHK-629",
        kind: "CAPTURE",
        amountKsh: 16_000,
        cardLast4: "2910",
        postedAt: "2026-11-26T11:05:00+03:00",
      },
      {
        settlementId: "STL-REF-629",
        batchId: "BATCH-BF-2026-01",
        checkoutId: "CHK-629",
        kind: "REFUND",
        amountKsh: 8_000,
        cardLast4: "2910",
        postedAt: "2026-11-26T15:12:00+03:00",
      },
    ],
    draft: {
      draftId: "DRF-629",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-629",
      debitedSellerId: "SELLER-B",
      refundAmountKsh: 8_000,
      totalBatchSettlementKsh: 48_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 30_000,
          refundDeductionKsh: 0,
          netPayoutKsh: 30_000,
        },
        {
          sellerId: "SELLER-B",
          grossSalesKsh: 26_000,
          refundDeductionKsh: 8_000,
          netPayoutKsh: 18_000,
        },
      ],
    },
    ticket: {
      ticketId: "TKT-629",
      checkoutId: "CHK-629",
      submittedAt: "2026-11-26T15:05:00+03:00",
      requestedRefundKsh: 8_000,
      message:
        "I scheduled a pickup for one KSh 8,000 kitchen item from CHK-629. Please confirm the payout deduction.",
    },
    initialWarehouseNote: {
      noteId: "WH-629",
      receivedAt: "2026-11-26T15:18:00+03:00",
      hub: "Kisumu Returns Hub",
      text: "No parcel scanned for CHK-629 yet; waybill shows label created only and item SKU is unverified.",
    },
  },
  {
    id: "batch-chk-741-dispute-coffee",
    title: "CHK-741: Specialty Goods (Active Dispute)",
    shortLabel: "CHK-741 Dispute",
    summary:
      "Customer requests immediate KSh 12,000 refund on Espresso Kit while an active PSP dispute linked to STL-PAY-741 / card 7784 arrives mid-flight.",
    policySummary: BATCH_POLICY,
    batchId: "BATCH-BF-2026-01",
    checkoutId: "CHK-741",
    sellers: {
      "SELLER-A": {
        id: "SELLER-A",
        name: "Naivasha Coffee Roasters",
        settlementAccount: "ACCT-KE-A741",
      },
      "SELLER-B": {
        id: "SELLER-B",
        name: "Nakuru Leathercraft",
        settlementAccount: "ACCT-KE-B741",
      },
    },
    priorBatchGrossBySellerKsh: {
      "SELLER-A": 38_000,
      "SELLER-B": 28_000,
    },
    orderLines: [
      {
        lineId: "LINE-741-A",
        checkoutId: "CHK-741",
        sellerId: "SELLER-A",
        sku: "ESP-KIT-09",
        itemTitle: "Manual Espresso Starter Kit",
        amountKsh: 12_000,
      },
      {
        lineId: "LINE-741-B",
        checkoutId: "CHK-741",
        sellerId: "SELLER-B",
        sku: "BAG-MSG-BRN",
        itemTitle: "Full-Grain Messenger Bag",
        amountKsh: 12_000,
      },
    ],
    settlements: [
      {
        settlementId: "STL-PAY-741",
        batchId: "BATCH-BF-2026-01",
        checkoutId: "CHK-741",
        kind: "CAPTURE",
        amountKsh: 24_000,
        cardLast4: "7784",
        postedAt: "2026-11-26T11:30:00+03:00",
      },
    ],
    draft: {
      draftId: "DRF-741",
      batchId: "BATCH-BF-2026-01",
      checkoutId: "CHK-741",
      debitedSellerId: "SELLER-A",
      refundAmountKsh: 12_000,
      totalBatchSettlementKsh: 90_000,
      sellerLines: [
        {
          sellerId: "SELLER-A",
          grossSalesKsh: 50_000,
          refundDeductionKsh: 0,
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
      ticketId: "TKT-741",
      checkoutId: "CHK-741",
      submittedAt: "2026-11-26T15:20:00+03:00",
      requestedRefundKsh: 12_000,
      message:
        "My Manual Espresso Starter Kit from CHK-741 had a cracked tamper and I sent it back. Please release my KSh 12,000 refund now.",
    },
    initialWarehouseNote: {
      noteId: "WH-741",
      receivedAt: "2026-11-26T15:15:00+03:00",
      hub: "Nairobi Industrial Returns Hub",
      text: "Intake logged for CHK-741: 1x Manual Espresso Starter Kit (SKU ESP-KIT-09, Naivasha Coffee Roasters). Messenger bag not returned.",
    },
    midFlightInjection: {
      delayMs: 110,
      kind: "CHARGEBACK_WEBHOOK",
      chargeback: {
        disputeId: "DSP-741",
        status: "OPEN",
        receivedAt: "2026-11-26T15:20:03+03:00",
        pspReferenceSuffix: "741",
        paymentSettlementId: "STL-PAY-741",
        cardLast4: "7784",
        amountKsh: 12_000,
        reasonCode: "VISA_13.1_MERCHANDISE_NOT_RECEIVED",
        narrative:
          "Active issuing-bank dispute opened on card ending 7784 for KSh 12,000 (checkout ref ending 741, settlement STL-PAY-741).",
      },
    },
  },
];
