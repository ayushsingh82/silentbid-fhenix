/**
 * Auto-finalize keeper for the FHENIX (CoFHE) port.
 *
 * Why this exists: the FHENIX auction contract has no on-chain decryption
 * callback. `FHE.allowPublic(...)` only marks a handle as decryptable; an
 * off-chain caller still has to fetch cleartext + signed proof from the
 * CoFHE threshold network and submit them to `finalizeAuction(winner,
 * amount, winnerSig, amountSig)`. This endpoint plays that caller,
 * automatically. The chain remains the state machine — no DB.
 *
 * Two callers, one route:
 *   1. cron-job.org one-shots for a specific auction:
 *        GET /api/cron/finalize?auctionId=N
 *      Two pings per auction — one at endTime+30s (does endAuction) and one
 *      at endTime+90s (does finalize). Each invocation processes a SINGLE
 *      transition based on chain state, finishing in ~15-20s. Splitting like
 *      this keeps every call well under Vercel Hobby's 60s function cap.
 *
 *   2. Sweep path (no query param):
 *        GET /api/cron/finalize
 *      Iterates all auctions, processes ONE transition per call. Useful as
 *      a safety net (run from GH Actions, an external cron, etc).
 *
 * State machine per auction (idempotent — chain is source of truth):
 *   live (chainNow < endTime, !ended)             → skip
 *   expired (chainNow >= endTime, !ended)         → call endAuction
 *   ended && !finalized                           → decryptForTx + finalize
 *   finalized                                     → skip
 *
 * Time check uses `block.timestamp` from the latest block, NOT `Date.now()`.
 * Validators publish blocks with timestamps that drift from wall-clock.
 * cron-job.org's clock drifts independently. The chain is the only reference
 * both sides agree on, and it's also what the contract uses to gate
 * `endAuction` (`require(block.timestamp >= endTime)`). Trust the same clock
 * the contract trusts.
 */

import { NextResponse } from "next/server"
import {
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  type AuctionData,
} from "@/lib/fhenix-contracts"

export const runtime = "nodejs"
export const maxDuration = 60
export const dynamic = "force-dynamic"

// Constant-time bearer-token check.
function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const got = req.headers.get("authorization") ?? ""
  const want = `Bearer ${expected}`
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

type ActionResult = {
  auctionId: string
  action:
    | "endAuction"
    | "finalizeAuction"
    | "skip-live"
    | "skip-finalized"
    | "skip-pending-oracle"
    | "noop"
  tx?: `0x${string}`
  error?: string
}

// The SDK pins viem 2.38.x while the project is on 2.48.x — typing the
// client via `Awaited<ReturnType<typeof loadCofheClient>>` would leak the
// SDK's PublicClient/WalletClient types and clash with the project's,
// triggering "two different types with this name" errors. Box the result
// behind a minimal structural interface that only mentions what we use.
type DecryptForTxResult = { decryptedValue: bigint; signature: `0x${string}` }
type CofheNodeClient = {
  decryptForTx: (handle: `0x${string}`) => {
    withoutPermit: () => { execute: () => Promise<DecryptForTxResult> }
  }
}

// Lazy-load the CoFHE node SDK once per cold start. The SDK pulls in WASM
// for TFHE which we don't want loading for non-cron routes.
//
// Parameters are untyped (`unknown`) to keep the SDK's nested viem types
// out of this file's surface — see CofheNodeClient comment above.
async function loadCofheClient(opts: {
  publicClient: unknown
  walletClient: unknown
}): Promise<CofheNodeClient> {
  const [{ createCofheClient, createCofheConfig }, chainsMod] = await Promise.all([
    import("@cofhe/sdk/node"),
    import("@cofhe/sdk/chains"),
  ])
  const config = createCofheConfig({
    environment: "node",
    supportedChains: [chainsMod.baseSepolia],
  })
  const client = createCofheClient(config)
  await client.connect(opts.publicClient as never, opts.walletClient as never)
  return client as unknown as CofheNodeClient
}

/**
 * Process AT MOST ONE state transition for a single auction. The chain is
 * the state machine — the route just dispatches the next step based on what
 * it sees on chain. Splitting like this keeps every invocation well under
 * Vercel Hobby's 60s function cap.
 *
 * cron-job.org schedules two one-shots per auction (endTime+30s and
 * endTime+90s) so the two transitions happen in two separate invocations.
 */
async function processAuction(
  id: bigint,
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: PrivateKeyAccount,
  getCofhe: () => Promise<CofheNodeClient>,
  chainNow: bigint,
): Promise<ActionResult[]> {
  const out: ActionResult[] = []

  const a = (await publicClient.readContract({
    address: AUCTION_ADDRESS,
    abi: AUCTION_ABI,
    functionName: "getAuction",
    args: [id],
  })) as AuctionData

  if (a.finalized) {
    out.push({ auctionId: id.toString(), action: "skip-finalized" })
    return out
  }

  // Transition 1: live → ended.
  if (!a.ended) {
    if (chainNow < a.endTime) {
      out.push({ auctionId: id.toString(), action: "skip-live" })
      return out
    }
    try {
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "endAuction",
        args: [id],
        account,
        chain: baseSepolia,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      out.push({ auctionId: id.toString(), action: "endAuction", tx: hash })
    } catch (e) {
      out.push({
        auctionId: id.toString(),
        action: "endAuction",
        error: (e as Error).message.slice(0, 240),
      })
    }
    return out
  }

  // Transition 2: ended → finalized.
  try {
    const client = await getCofhe()
    const bidderHandle = a.highestBidderHandle as `0x${string}`
    const amountHandle = a.highestBidHandle as `0x${string}`

    // Sequential, not parallel — each call hits the same threshold network
    // and they share rate-limit budget on the CoFHE relayer.
    const bidderResult = await client
      .decryptForTx(bidderHandle)
      .withoutPermit()
      .execute()
    const amountResult = await client
      .decryptForTx(amountHandle)
      .withoutPermit()
      .execute()

    const winnerRaw = bidderResult.decryptedValue as bigint
    const amountRaw = amountResult.decryptedValue as bigint
    const winner = (`0x${winnerRaw.toString(16).padStart(40, "0")}`) as Address

    const hash = await walletClient.writeContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "finalizeAuction",
      args: [
        id,
        winner,
        amountRaw,
        bidderResult.signature,
        amountResult.signature,
      ],
      account,
      chain: baseSepolia,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    out.push({ auctionId: id.toString(), action: "finalizeAuction", tx: hash })
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300)
    // Common transient: CoFHE oracle 404s because the threshold network is
    // still indexing the `allowPublic` event. Mark distinctly so a safety-
    // net sweep doesn't treat it as a hard failure.
    out.push({
      auctionId: id.toString(),
      action: msg.includes("404") || msg.toLowerCase().includes("not found")
        ? "skip-pending-oracle"
        : "finalizeAuction",
      error: msg,
    })
  }
  return out
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  const rpcUrl =
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"

  if (!pk || !pk.startsWith("0x")) {
    return NextResponse.json(
      { ok: false, error: "KEEPER_PRIVATE_KEY missing or malformed" },
      { status: 500 },
    )
  }
  if (!AUCTION_ADDRESS) {
    return NextResponse.json(
      { ok: false, error: "AUCTION_ADDRESS not configured" },
      { status: 500 },
    )
  }

  const account = privateKeyToAccount(pk)
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) })

  let cofheClient: CofheNodeClient | null = null
  async function getCofhe(): Promise<CofheNodeClient> {
    if (cofheClient) return cofheClient
    cofheClient = await loadCofheClient({ publicClient, walletClient })
    return cofheClient
  }

  // Anchor every time check on chainNow, not server clock.
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

  // Per-auction one-shot path: ?auctionId=N.
  const url = new URL(req.url)
  const auctionIdParam = url.searchParams.get("auctionId")
  if (auctionIdParam !== null) {
    let auctionId: bigint
    try {
      auctionId = BigInt(auctionIdParam)
    } catch {
      return NextResponse.json({ ok: false, error: "auctionId must be an integer" }, { status: 400 })
    }
    if (auctionId < 0n) {
      return NextResponse.json({ ok: false, error: "auctionId must be non-negative" }, { status: 400 })
    }
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
    const results = await processAuction(
      auctionId,
      publicClient as PublicClient,
      walletClient as WalletClient,
      account,
      getCofhe,
      chainNow,
    )
    return NextResponse.json({
      ok: true,
      mode: "one-shot",
      results,
      keeper: account.address,
      chainNow: chainNow.toString(),
    })
  }

  // Sweep path: iterate all auctions, one transition per auction per call.
  let auctionCount: bigint
  try {
    auctionCount = (await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "nextAuctionId",
    })) as bigint
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `auctionCount read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  const allResults: ActionResult[] = []
  for (let id = 0n; id < auctionCount; id++) {
    const r = await processAuction(
      id,
      publicClient as PublicClient,
      walletClient as WalletClient,
      account,
      getCofhe,
      chainNow,
    )
    allResults.push(...r)
    // First non-skip action returns — bound the budget so a slow CoFHE call
    // on auction K doesn't time-out the whole sweep.
    const acted = r.find((x) => x.action === "endAuction" || x.action === "finalizeAuction")
    if (acted) {
      return NextResponse.json({
        ok: true,
        mode: "sweep",
        results: allResults,
        keeper: account.address,
        count: auctionCount.toString(),
        chainNow: chainNow.toString(),
      })
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "sweep",
    results: allResults,
    keeper: account.address,
    count: auctionCount.toString(),
    chainNow: chainNow.toString(),
  })
}
