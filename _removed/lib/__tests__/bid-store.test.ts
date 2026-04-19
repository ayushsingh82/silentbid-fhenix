import { describe, it, expect, beforeEach } from "vitest"
import { storeBid, getBidsForAuction, getAllBids, clearAuction, type StoredBid } from "../bid-store"

function makeBid(overrides: Partial<StoredBid> = {}): StoredBid {
  return {
    commitment: "0xabc1230000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    sender: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    auctionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
    maxPrice: "79228162514264337593543950336",
    amount: "10000000000000000",
    flags: "0",
    timestamp: "1700000000",
    signature: "0x" + "ab".repeat(65) as `0x${string}`,
    receivedAt: new Date().toISOString(),
    ...overrides,
  }
}

// Note: bid-store uses a module-level Map, so tests share state.
// We use unique auctionIds per test to avoid collisions.

describe("storeBid", () => {
  it("stores a bid and returns true for new bid", () => {
    const bid = makeBid({ auctionId: "0x0000000000000000000000000000000000000001" as `0x${string}` })
    const result = storeBid(bid)
    expect(result).toBe(true)
  })

  it("returns false for duplicate commitment", () => {
    const auctionId = "0x0000000000000000000000000000000000000002" as `0x${string}`
    const bid = makeBid({ auctionId })
    storeBid(bid)
    const result = storeBid(bid) // same commitment
    expect(result).toBe(false)
  })

  it("allows different commitments for same auction", () => {
    const auctionId = "0x0000000000000000000000000000000000000003" as `0x${string}`
    const bid1 = makeBid({
      auctionId,
      commitment: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
    })
    const bid2 = makeBid({
      auctionId,
      commitment: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
    })
    expect(storeBid(bid1)).toBe(true)
    expect(storeBid(bid2)).toBe(true)
  })
})

describe("getBidsForAuction", () => {
  it("returns empty array for unknown auction", () => {
    const bids = getBidsForAuction("0x9999999999999999999999999999999999999999")
    expect(bids).toEqual([])
  })

  it("returns stored bids for known auction", () => {
    const auctionId = "0x0000000000000000000000000000000000000004" as `0x${string}`
    const bid = makeBid({
      auctionId,
      commitment: "0x4444444444444444444444444444444444444444444444444444444444444444" as `0x${string}`,
    })
    storeBid(bid)
    const bids = getBidsForAuction(auctionId)
    expect(bids.length).toBeGreaterThanOrEqual(1)
    expect(bids.some((b) => b.commitment === bid.commitment)).toBe(true)
  })
})

describe("getAllBids", () => {
  it("returns bids across multiple auctions", () => {
    const allBids = getAllBids()
    // We've stored bids in previous tests
    expect(allBids.length).toBeGreaterThanOrEqual(1)
  })
})

describe("clearAuction", () => {
  it("clears all bids for a specific auction", () => {
    const auctionId = "0x0000000000000000000000000000000000000005" as `0x${string}`
    const bid = makeBid({
      auctionId,
      commitment: "0x5555555555555555555555555555555555555555555555555555555555555555" as `0x${string}`,
    })
    storeBid(bid)
    expect(getBidsForAuction(auctionId).length).toBe(1)

    clearAuction(auctionId)
    expect(getBidsForAuction(auctionId)).toEqual([])
  })

  it("does not affect other auctions", () => {
    const auctionA = "0x0000000000000000000000000000000000000006" as `0x${string}`
    const auctionB = "0x0000000000000000000000000000000000000007" as `0x${string}`

    storeBid(makeBid({
      auctionId: auctionA,
      commitment: "0x6666666666666666666666666666666666666666666666666666666666666666" as `0x${string}`,
    }))
    storeBid(makeBid({
      auctionId: auctionB,
      commitment: "0x7777777777777777777777777777777777777777777777777777777777777777" as `0x${string}`,
    }))

    clearAuction(auctionA)
    expect(getBidsForAuction(auctionA)).toEqual([])
    expect(getBidsForAuction(auctionB).length).toBe(1)
  })
})
