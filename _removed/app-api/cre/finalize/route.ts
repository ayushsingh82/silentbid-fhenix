import { NextResponse } from "next/server"
import { encodePacked, keccak256, type Hex } from "viem"
import { getBidsForAuction, type StoredBid } from "@/lib/bid-store"

// ---------------------------------------------------------------------------
// POST /api/cre/finalize
// ---------------------------------------------------------------------------

interface FinalizeRequestBody {
  auctionId: string
}

interface WinningBid {
  sender: `0x${string}`
  commitment: `0x${string}`
  maxPrice: string
  /** The amount of tokens the bidder receives at the clearing price */
  allocatedAmount: string
  /** The cost in wei the bidder pays (clearingPrice * allocatedAmount / Q96) */
  cost: string
}

const Q96 = 2n ** 96n

/**
 * Simple uniform-price price-discovery algorithm:
 *   1. Sort bids by maxPrice descending (highest bidder first).
 *   2. Walk through bids accumulating `amount` until we run out of supply or bids.
 *   3. The clearing price is the maxPrice of the last bid that still fits.
 *   4. Every bid with maxPrice >= clearingPrice wins; all pay clearingPrice.
 *
 * This mirrors the onchain CCA auction logic conceptually.
 */
function runPriceDiscovery(bids: StoredBid[]) {
  if (bids.length === 0) {
    return {
      clearingPrice: "0",
      totalRaised: "0",
      winningBids: [] as WinningBid[],
    }
  }

  // Sort descending by maxPrice
  const sorted = [...bids].sort((a, b) => {
    const diff = BigInt(b.maxPrice) - BigInt(a.maxPrice)
    if (diff > 0n) return 1
    if (diff < 0n) return -1
    return 0
  })

  // The clearing price in a uniform-price auction is the lowest winning bid's maxPrice.
  // For simplicity in this gateway, we treat every bid as a winner (no supply cap)
  // and set clearingPrice to the lowest maxPrice among all bids.
  // In production, the CRE workflow would use the actual token supply to cap.
  const clearingPriceBn = BigInt(sorted[sorted.length - 1].maxPrice)

  let totalRaised = 0n
  const winningBids: WinningBid[] = []

  for (const bid of sorted) {
    const maxPriceBn = BigInt(bid.maxPrice)
    if (maxPriceBn < clearingPriceBn) continue // below clearing price

    const amountBn = BigInt(bid.amount)
    // Cost = clearingPrice * amount / Q96 (since prices are Q96-encoded)
    const cost = (clearingPriceBn * amountBn) / Q96
    totalRaised += cost

    winningBids.push({
      sender: bid.sender,
      commitment: bid.commitment,
      maxPrice: bid.maxPrice,
      allocatedAmount: bid.amount,
      cost: cost.toString(),
    })
  }

  return {
    clearingPrice: clearingPriceBn.toString(),
    totalRaised: totalRaised.toString(),
    winningBids,
  }
}

/**
 * Build a minimal calldata payload that the CRE workflow would use to call
 * SilentBidCCA.forwardBidsToCCA on-chain.
 * This is illustrative — the real calldata encoding would use viem's encodeFunctionData.
 */
function buildForwardBidsCalldata(
  auctionId: string,
  winningBids: WinningBid[],
  clearingPrice: string,
): `0x${string}` {
  // Create a deterministic hash that represents the batch — in production this
  // would be the full ABI-encoded calldata for forwardBidsToCCA.
  // Strip 0x prefix from each commitment before joining, then add single 0x prefix
  const rawHex = winningBids.map((b) => b.commitment.slice(2)).join("")
  const commitmentsHex: Hex = rawHex.length > 0
    ? (`0x${rawHex}` as Hex)
    : "0x"
  return keccak256(
    encodePacked(
      ["address", "uint256", "bytes"],
      [auctionId as Hex, BigInt(clearingPrice), commitmentsHex],
    ),
  ) as `0x${string}`
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FinalizeRequestBody

    if (!body.auctionId) {
      return NextResponse.json(
        { error: "Missing required field: auctionId" },
        { status: 400 },
      )
    }

    const bids = getBidsForAuction(body.auctionId)
    if (bids.length === 0) {
      return NextResponse.json(
        { error: `No bids found for auction ${body.auctionId}` },
        { status: 404 },
      )
    }

    const { clearingPrice, totalRaised, winningBids } = runPriceDiscovery(bids)

    const calldataForForwardBids = buildForwardBidsCalldata(
      body.auctionId,
      winningBids,
      clearingPrice,
    )

    // In production: trigger CRE finalize workflow which would call
    // SilentBidCCA.forwardBidsToCCA on-chain with the computed allocations

    return NextResponse.json({
      auctionId: body.auctionId,
      clearingPrice,
      totalRaised,
      winningBids,
      calldataForForwardBids,
      bidCount: bids.length,
      finalizedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[POST /api/cre/finalize]", err)
    return NextResponse.json(
      { error: `Internal server error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
