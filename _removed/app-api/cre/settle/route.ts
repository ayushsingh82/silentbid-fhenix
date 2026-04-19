import { NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// POST /api/cre/settle
// ---------------------------------------------------------------------------

interface Allocation {
  sender: `0x${string}`
  /** Amount of tokens allocated to this bidder */
  allocatedAmount: string
  /** Cost paid at clearing price */
  cost: string
  /** Original bid amount in wei */
  originalAmount: string
  /** Whether this bidder won */
  isWinner: boolean
}

interface SettleRequestBody {
  auctionId: string
  allocations: Allocation[]
}

interface SettlementAction {
  type: "payout" | "refund"
  recipient: `0x${string}`
  /** For payouts: token amount; for refunds: wei amount */
  amount: string
  reason: string
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SettleRequestBody

    if (!body.auctionId) {
      return NextResponse.json(
        { error: "Missing required field: auctionId" },
        { status: 400 },
      )
    }

    if (!body.allocations || !Array.isArray(body.allocations) || body.allocations.length === 0) {
      return NextResponse.json(
        { error: "Missing or empty allocations array" },
        { status: 400 },
      )
    }

    // Validate each allocation
    for (const alloc of body.allocations) {
      if (!alloc.sender || !alloc.originalAmount) {
        return NextResponse.json(
          { error: "Each allocation must include sender and originalAmount" },
          { status: 400 },
        )
      }
    }

    const settlementPlan: SettlementAction[] = []
    let totalPayout = 0n
    let totalRefund = 0n

    for (const alloc of body.allocations) {
      if (alloc.isWinner) {
        const cost = BigInt(alloc.cost || "0")
        const originalAmount = BigInt(alloc.originalAmount)
        const allocatedAmount = BigInt(alloc.allocatedAmount || "0")

        // Winner gets their allocated tokens (payout action)
        settlementPlan.push({
          type: "payout",
          recipient: alloc.sender,
          amount: allocatedAmount.toString(),
          reason: `Winner — receives ${allocatedAmount.toString()} tokens at cost ${cost.toString()} wei`,
        })
        totalPayout += allocatedAmount

        // If the winner's original escrow exceeds cost, refund the difference
        const refundDue = originalAmount - cost
        if (refundDue > 0n) {
          settlementPlan.push({
            type: "refund",
            recipient: alloc.sender,
            amount: refundDue.toString(),
            reason: `Excess escrow refund: original ${originalAmount.toString()} - cost ${cost.toString()} = ${refundDue.toString()} wei`,
          })
          totalRefund += refundDue
        }
      } else {
        // Loser: full refund of escrowed amount
        const originalAmount = BigInt(alloc.originalAmount)
        settlementPlan.push({
          type: "refund",
          recipient: alloc.sender,
          amount: originalAmount.toString(),
          reason: `Non-winning bid — full refund of ${originalAmount.toString()} wei`,
        })
        totalRefund += originalAmount
      }
    }

    // In production: trigger CRE settle workflow which would execute
    // the settlement plan via compliant private transfers and onchain calls

    return NextResponse.json({
      auctionId: body.auctionId,
      settlementPlan,
      totalPayout: totalPayout.toString(),
      totalRefund: totalRefund.toString(),
      actionCount: settlementPlan.length,
      settledAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[POST /api/cre/settle]", err)
    return NextResponse.json(
      { error: `Internal server error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
