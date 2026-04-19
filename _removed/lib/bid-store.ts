/**
 * In-memory bid storage for the CRE API gateway.
 *
 * In production this would be replaced by CRE's secure offchain storage
 * or a database. The Map lives in the Node.js process and resets on restart.
 */

export interface StoredBid {
  /** keccak256 commitment hash */
  commitment: `0x${string}`
  sender: `0x${string}`
  auctionId: `0x${string}`
  /** Q96-encoded max price the bidder is willing to pay */
  maxPrice: string
  /** Bid amount in wei */
  amount: string
  /** Optional flags (uint256 packed) */
  flags: string
  /** Unix timestamp (seconds) when the bid was signed */
  timestamp: string
  /** EIP-712 signature */
  signature: `0x${string}`
  /** Server-side receipt time (ISO string) */
  receivedAt: string
}

/**
 * Map<auctionId, Map<commitment, StoredBid>>
 *
 * Two-level map so we can efficiently look up all bids for a single auction
 * while also de-duplicating by commitment.
 */
const store = new Map<string, Map<string, StoredBid>>()

/** Store a bid. Returns false if a bid with the same commitment already exists. */
export function storeBid(bid: StoredBid): boolean {
  let auctionBids = store.get(bid.auctionId)
  if (!auctionBids) {
    auctionBids = new Map<string, StoredBid>()
    store.set(bid.auctionId, auctionBids)
  }
  if (auctionBids.has(bid.commitment)) {
    return false // duplicate
  }
  auctionBids.set(bid.commitment, bid)
  return true
}

/** Get all stored bids for a given auction, ordered by insertion. */
export function getBidsForAuction(auctionId: string): StoredBid[] {
  const auctionBids = store.get(auctionId)
  if (!auctionBids) return []
  return Array.from(auctionBids.values())
}

/** Get every stored bid across all auctions. */
export function getAllBids(): StoredBid[] {
  const all: StoredBid[] = []
  for (const auctionBids of store.values()) {
    for (const bid of auctionBids.values()) {
      all.push(bid)
    }
  }
  return all
}

/** Clear all bids for an auction (useful after finalization). */
export function clearAuction(auctionId: string): void {
  store.delete(auctionId)
}
