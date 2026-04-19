import { NextResponse } from "next/server"
import {
  keccak256,
  encodePacked,
  verifyTypedData,
  isAddress,
  type Hex,
} from "viem"
import { storeBid, type StoredBid } from "@/lib/bid-store"
import { SILENTBID_DOMAIN, SILENTBID_BID_TYPES } from "@/lib/cre-bid"

// ---------------------------------------------------------------------------
// POST /api/cre/bid
// ---------------------------------------------------------------------------

interface BidRequestBody {
  signature: string
  sender: string
  auctionId: string
  maxPrice: string
  amount: string
  flags?: string
  timestamp: string
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as BidRequestBody

    // ---- Validate required fields ----
    const { signature, sender, auctionId, maxPrice, amount, timestamp } = body
    const flags = body.flags ?? "0"

    if (!signature || !sender || !auctionId || !maxPrice || !amount || !timestamp) {
      return NextResponse.json(
        { error: "Missing required fields: signature, sender, auctionId, maxPrice, amount, timestamp" },
        { status: 400 },
      )
    }

    if (!isAddress(sender)) {
      return NextResponse.json({ error: "Invalid sender address" }, { status: 400 })
    }
    if (!isAddress(auctionId)) {
      return NextResponse.json({ error: "Invalid auctionId address" }, { status: 400 })
    }

    // Parse numeric values
    let maxPriceBn: bigint
    let amountBn: bigint
    let timestampBn: bigint
    try {
      maxPriceBn = BigInt(maxPrice)
      amountBn = BigInt(amount)
      timestampBn = BigInt(timestamp)
    } catch {
      return NextResponse.json(
        { error: "maxPrice, amount, and timestamp must be valid integer strings" },
        { status: 400 },
      )
    }

    if (maxPriceBn <= 0n) {
      return NextResponse.json({ error: "maxPrice must be positive" }, { status: 400 })
    }
    if (amountBn <= 0n) {
      return NextResponse.json({ error: "amount must be positive" }, { status: 400 })
    }

    // ---- Verify EIP-712 signature ----
    // Use the same domain and types as the frontend (cre-bid.ts)
    const domain = SILENTBID_DOMAIN
    let flagsBn: bigint
    try {
      flagsBn = BigInt(flags)
    } catch {
      flagsBn = BigInt(0)
    }

    const message = {
      sender: sender as Hex,
      auctionId: auctionId as Hex,
      maxPrice: maxPriceBn,
      amount: amountBn,
      flags: flagsBn,
      timestamp: timestampBn,
    }

    const isPlaceholder = !signature || signature === "0x" || signature.length < 130
    if (!isPlaceholder) {
      try {
        const recovered = await verifyTypedData({
          address: sender as Hex,
          domain,
          types: SILENTBID_BID_TYPES,
          primaryType: "Bid",
          message,
          signature: signature as Hex,
        })
        if (!recovered) {
          return NextResponse.json(
            { error: "EIP-712 signature verification failed" },
            { status: 401 },
          )
        }
      } catch (err) {
        return NextResponse.json(
          { error: `Signature verification error: ${err instanceof Error ? err.message : String(err)}` },
          { status: 401 },
        )
      }
    }
    // If signature is a placeholder we still compute commitment (simulation mode)

    // ---- Compute bid commitment ----
    // Must match: keccak256(abi.encodePacked(auctionId, sender, maxPrice, amount, timestamp))
    const commitment = keccak256(
      encodePacked(
        ["address", "address", "uint256", "uint256", "uint256"],
        [auctionId as Hex, sender as Hex, maxPriceBn, amountBn, timestampBn],
      ),
    )

    // ---- Store the bid ----
    const stored: StoredBid = {
      commitment: commitment as `0x${string}`,
      sender: sender as `0x${string}`,
      auctionId: auctionId as `0x${string}`,
      maxPrice,
      amount,
      flags,
      timestamp,
      signature: signature as `0x${string}`,
      receivedAt: new Date().toISOString(),
    }

    const isNew = storeBid(stored)
    if (!isNew) {
      return NextResponse.json(
        { error: "Duplicate bid commitment — bid already submitted", commitment },
        { status: 409 },
      )
    }

    // In production: forward to CRE workflow endpoint via Confidential HTTP
    // e.g. await confidentialHttpClient.post(CRE_BID_ENDPOINT, stored)

    return NextResponse.json(
      {
        commitment,
        auctionId,
        status: "accepted",
        sender,
        receivedAt: stored.receivedAt,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error("[POST /api/cre/bid]", err)
    return NextResponse.json(
      { error: `Internal server error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
