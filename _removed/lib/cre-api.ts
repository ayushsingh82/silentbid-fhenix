/**
 * Client-side helpers for calling the CRE API gateway routes.
 *
 * These functions are designed to be used from React components or hooks
 * in the SilentBid frontend.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitBidParams {
  signature: `0x${string}`
  sender: `0x${string}`
  auctionId: `0x${string}`
  maxPrice: string
  amount: string
  flags?: string
  timestamp: string
}

export interface SubmitBidResponse {
  commitment: `0x${string}`
  auctionId: string
  status: "accepted"
  sender: string
  receivedAt: string
}

export interface FinalizeResponse {
  auctionId: string
  clearingPrice: string
  totalRaised: string
  winningBids: {
    sender: `0x${string}`
    commitment: `0x${string}`
    maxPrice: string
    allocatedAmount: string
    cost: string
  }[]
  calldataForForwardBids: `0x${string}`
  bidCount: number
  finalizedAt: string
}

export interface SettleAllocation {
  sender: `0x${string}`
  allocatedAmount: string
  cost: string
  originalAmount: string
  isWinner: boolean
}

export interface SettleParams {
  auctionId: string
  allocations: SettleAllocation[]
}

export interface SettleResponse {
  auctionId: string
  settlementPlan: {
    type: "payout" | "refund"
    recipient: `0x${string}`
    amount: string
    reason: string
  }[]
  totalPayout: string
  totalRefund: string
  actionCount: number
  settledAt: string
}

export interface CREApiError {
  error: string
  commitment?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CREApiClientError extends Error {
  status: number
  body: CREApiError

  constructor(status: number, body: CREApiError) {
    super(body.error)
    this.name = "CREApiClientError"
    this.status = status
    this.body = body
  }
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  const data = await res.json()

  if (!res.ok) {
    throw new CREApiClientError(res.status, data as CREApiError)
  }

  return data as T
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit an EIP-712 signed bid to the CRE gateway.
 * The API verifies the signature, computes the commitment, and stores the bid.
 */
export function submitBidToCRE(params: SubmitBidParams): Promise<SubmitBidResponse> {
  return postJSON<SubmitBidResponse>("/api/cre/bid", params)
}

/**
 * Trigger auction finalization — runs price discovery on stored bids
 * and returns the clearing price, winning bids, and calldata.
 */
export function finalizeAuction(auctionId: string): Promise<FinalizeResponse> {
  return postJSON<FinalizeResponse>("/api/cre/finalize", { auctionId })
}

/**
 * Generate a settlement plan for an auction given the final allocations.
 * Returns payout and refund actions.
 */
export function settleAuction(params: SettleParams): Promise<SettleResponse> {
  return postJSON<SettleResponse>("/api/cre/settle", params)
}
