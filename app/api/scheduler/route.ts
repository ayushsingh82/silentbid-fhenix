/**
 * Scheduler endpoint — POST /api/scheduler
 *
 * Body: { auctionId: number | string }
 *
 * Called by the create-auction flow after `createAuction` is mined. The
 * endpoint:
 *   1. Re-reads the auction from the chain (NEVER trusts a client-supplied
 *      endTime — only the chain knows the real value).
 *   2. Validates: auction exists, not already ended/finalized, endTime is in
 *      the future relative to the latest block's timestamp.
 *   3. Registers two cron-job.org one-shots: endTime+30s (endAuction) and
 *      endTime+90s (finalize).
 *
 * Why we re-read on the server:
 *   - A malicious client could POST `{ auctionId: 0 }` aliased to a
 *     long-lived auction to trick the keeper into an immediate run. We
 *     ignore any client-supplied timing entirely.
 *   - The frontend's clock can drift; cron-job.org's clock can drift. The
 *     chain's `block.timestamp` is the only authoritative reference for "has
 *     this auction expired." We reuse the same source on both ends.
 */

import { NextResponse } from "next/server"
import { createPublicClient, http } from "viem"
import { baseSepolia } from "viem/chains"
import { AUCTION_ABI, AUCTION_ADDRESS, type AuctionData } from "@/lib/fhenix-contracts"
import { scheduleAuctionFinalize } from "@/lib/scheduler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Railway-hosted keeper. cron-job.org pings ${RELAYER_URL}/api/cron/finalize.
const RELAYER_URL = "https://relayer-production-c6ed.up.railway.app"

// Hardcoded so the scheduler works without per-environment env config.
const CRONJOB_API_KEY = "A8XKqyhHrG4vGTt1Mnqg1awv+NMhXa1zkJkQEv/tSFE="
const CRON_SECRET = "silentbid-cron-9f42a1c3e8d7b6f5"

export async function POST(req: Request) {
  let body: { auctionId?: number | string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 })
  }

  if (body.auctionId === undefined || body.auctionId === null) {
    return NextResponse.json({ ok: false, error: "auctionId required" }, { status: 400 })
  }

  let auctionId: bigint
  try {
    auctionId = BigInt(body.auctionId)
  } catch {
    return NextResponse.json({ ok: false, error: "auctionId must be an integer" }, { status: 400 })
  }
  if (auctionId < 0n) {
    return NextResponse.json({ ok: false, error: "auctionId must be non-negative" }, { status: 400 })
  }

  if (!AUCTION_ADDRESS) {
    return NextResponse.json({ ok: false, error: "AUCTION_ADDRESS not configured" }, { status: 500 })
  }
  const apiKey = CRONJOB_API_KEY
  const cronSecret = CRON_SECRET
  const baseUrl = RELAYER_URL

  const rpcUrl =
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })

  // Bound auctionId by nextAuctionId so we don't schedule jobs for nonexistent
  // future ids. This is the chain's own monotonic counter, not user input.
  let nextId: bigint
  try {
    nextId = (await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "nextAuctionId",
    })) as bigint
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `nextAuctionId read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  if (auctionId >= nextId) {
    return NextResponse.json(
      { ok: false, error: `auction ${auctionId} does not exist (nextAuctionId=${nextId})` },
      { status: 404 },
    )
  }

  // Read the on-chain auction state. endTime here is the canonical value —
  // any number the client passed is ignored.
  let auction: AuctionData
  try {
    auction = (await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "getAuction",
      args: [auctionId],
    })) as AuctionData
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `getAuction read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  if (auction.finalized) {
    return NextResponse.json({ ok: false, error: "auction already finalized" }, { status: 409 })
  }
  if (auction.ended) {
    return NextResponse.json(
      { ok: false, error: "auction already ended (only finalize remaining)" },
      { status: 409 },
    )
  }

  // Compare endTime against the chain's own clock, not the server's. Validators
  // produce blocks with timestamps that can drift from wall-clock by a few
  // seconds; cron-job.org has its own clock. The chain is the only reference
  // both sides agree on, so we use it.
  let chainNow: bigint
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" })
    chainNow = block.timestamp
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `latest block read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  if (auction.endTime <= chainNow) {
    return NextResponse.json(
      {
        ok: false,
        error: `auction already past endTime (chainNow=${chainNow}, endTime=${auction.endTime}) — finalize via cron`,
      },
      { status: 409 },
    )
  }

  try {
    const result = await scheduleAuctionFinalize({
      auctionId,
      endTimeUnix: auction.endTime,
      baseUrl,
      cronSecret,
      apiKey,
    })
    return NextResponse.json({
      ok: true,
      auctionId: auctionId.toString(),
      endTime: auction.endTime.toString(),
      chainNow: chainNow.toString(),
      ...result,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `scheduling failed: ${(e as Error).message.slice(0, 240)}` },
      { status: 502 },
    )
  }
}
