/**
 * Immutable source records and domain types for RefundGuard.
 * All monetary figures are stored as integer Kenyan Shillings (KSh)
 * and computed strictly by deterministic code, never by LLMs.
 */

export type SellerId = "SELLER-A" | "SELLER-B";

export interface SellerProfile {
  readonly id: SellerId;
  readonly name: string;
  readonly settlementAccount: string;
}

export interface OrderLineRecord {
  readonly lineId: string;
  readonly checkoutId: string;
  readonly sellerId: SellerId;
  readonly sku: string;
  readonly itemTitle: string;
  readonly amountKsh: number; // integer KSh
}

export interface SettlementRecord {
  readonly settlementId: string;
  readonly batchId: string;
  readonly checkoutId: string;
  readonly kind: "CAPTURE" | "REFUND";
  readonly amountKsh: number; // positive integer KSh
  readonly cardLast4: string;
  readonly postedAt: string;
}

export interface PayoutDraftLine {
  readonly sellerId: SellerId;
  readonly grossSalesKsh: number;
  readonly refundDeductionKsh: number;
  readonly netPayoutKsh: number;
}

export interface PayoutDraftRecord {
  readonly draftId: string;
  readonly batchId: string;
  readonly checkoutId: string;
  readonly debitedSellerId: SellerId;
  readonly refundAmountKsh: number;
  readonly totalBatchSettlementKsh: number;
  readonly sellerLines: readonly PayoutDraftLine[];
}

export interface CustomerTicketRecord {
  readonly ticketId: string;
  readonly checkoutId: string;
  readonly submittedAt: string;
  readonly requestedRefundKsh: number;
  readonly message: string;
}

export interface WarehouseNoteRecord {
  readonly noteId: string;
  readonly receivedAt: string;
  readonly hub: string;
  readonly text: string;
  readonly supersedesNoteId?: string;
}

export interface ChargebackWebhookRecord {
  readonly disputeId: string;
  readonly receivedAt: string;
  readonly pspReferenceSuffix: string;
  readonly cardLast4: string;
  readonly amountKsh: number;
  readonly reasonCode: string;
  readonly narrative: string;
}

export interface MidFlightInjection {
  readonly delayMs: number;
  readonly kind: "WAREHOUSE_CORRECTION" | "CHARGEBACK_WEBHOOK";
  readonly warehouseNote?: WarehouseNoteRecord;
  readonly chargeback?: ChargebackWebhookRecord;
}

export interface ScenarioFixture {
  readonly id: string;
  readonly title: string;
  readonly shortLabel: string;
  readonly summary: string;
  readonly policySummary: string;
  readonly batchId: string;
  readonly checkoutId: string;
  readonly sellers: Record<SellerId, SellerProfile>;
  readonly priorBatchGrossBySellerKsh: Record<SellerId, number>;
  readonly orderLines: readonly OrderLineRecord[];
  readonly settlements: readonly SettlementRecord[];
  readonly draft: PayoutDraftRecord;
  readonly ticket: CustomerTicketRecord;
  readonly initialWarehouseNote: WarehouseNoteRecord;
  readonly initialChargeback?: ChargebackWebhookRecord;
  readonly midFlightInjection?: MidFlightInjection;
}

export type SentinelEvidenceStatus =
  | "VERIFIED_RETURN"
  | "MISSING_OR_AMBIGUOUS"
  | "DISPUTE_COLLISION";

export interface SentinelFinding {
  readonly epoch: number;
  readonly status: SentinelEvidenceStatus;
  readonly verifiedSellerId: SellerId | null;
  readonly verifiedLineId: string | null;
  readonly disputeId: string | null;
  readonly evidenceNoteId: string;
  readonly confidence: "HIGH" | "LOW";
  readonly summary: string;
  readonly citedSourceIds: readonly string[];
  readonly recordedAtMs: number;
}

export interface ProposedRefundAction {
  readonly epoch: number;
  readonly checkoutId: string;
  readonly debitSellerId: SellerId;
  readonly refundAmountKsh: number;
  readonly rationale: string;
  readonly citedSourceIds: readonly string[];
}

export type InterceptionReason =
  | "WRONG_SELLER_ALLOCATION"
  | "MISSING_EVIDENCE"
  | "SUPERSEDED_EVIDENCE"
  | "DOUBLE_PAYOUT_BLOCKED";

export interface InterceptionRecord {
  readonly timestampMs: number;
  readonly attemptNumber: number;
  readonly blockedSellerId: SellerId;
  readonly proposalEpoch: number;
  readonly currentEpoch: number;
  readonly reason: InterceptionReason;
  readonly detail: string;
  readonly actionTaken: "REWRITE_AND_REPLAN" | "HALT_FOR_HUMAN_REVIEW";
  readonly citedSourceIds: readonly string[];
}

export type FinalVerdict =
  | "READY_FOR_HUMAN_APPROVAL"
  | "CORRECTED_READY_FOR_APPROVAL"
  | "HOLD_MISSING_EVIDENCE"
  | "FROZEN_DISPUTE_COLLISION";

export interface GroundedAllocationLine {
  readonly sellerId: SellerId;
  readonly sellerName: string;
  readonly grossSalesKsh: number;
  readonly draftDeductionKsh: number;
  readonly draftNetPayoutKsh: number;
  readonly supportedDeductionKsh: number;
  readonly supportedNetPayoutKsh: number;
  readonly deltaKsh: number; // supported - draft
  readonly citations: readonly string[];
}

export interface GroundedLedgerResult {
  readonly batchId: string;
  readonly checkoutId: string;
  readonly batchGrossKsh: number;
  readonly confirmedRefundKsh: number;
  readonly netBatchTotalKsh: number;
  readonly draftTotalKsh: number;
  readonly supportedTotalKsh: number;
  readonly totalStillMatchesExactly: boolean;
  readonly misallocationCaughtKsh: number;
  readonly doublePayoutPreventedKsh: number;
  readonly heldAmountKsh: number;
  readonly lines: readonly GroundedAllocationLine[];
  readonly allCitations: readonly string[];
}

export interface TimelineEntry {
  readonly seq: number;
  readonly elapsedMs: number;
  readonly type: string;
  readonly actor: string;
  readonly epoch: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface CaseRunReport {
  readonly scenarioId: string;
  readonly scenarioTitle: string;
  readonly mode: "live" | "mock";
  readonly architecture: "refund-guard-concurrent" | "single-agent-baseline";
  readonly verdict: FinalVerdict;
  readonly finalEpoch: number;
  readonly durationMs: number;
  readonly concurrentOverlapVerified: boolean;
  readonly overlapDetail: string;
  readonly sentinelFinding: SentinelFinding | null;
  readonly acceptedProposal: ProposedRefundAction | null;
  readonly interceptions: readonly InterceptionRecord[];
  readonly ledger: GroundedLedgerResult;
  readonly timeline: readonly TimelineEntry[];
}
