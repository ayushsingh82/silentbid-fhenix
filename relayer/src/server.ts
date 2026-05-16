/**
 * HTTP keeper service for SilentBid-FHENIX.
 *
 * Endpoints:
 *   GET /api/cron/finalize?auctionId=N   one-shot, single transition
 *   GET /api/cron/finalize               sweep, single transition across all auctions
 *   GET /health                           liveness probe
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 *
 * Designed to slot in behind cron-job.org without changing the existing
 * scheduler URL path — point cron-job.org at https://<railway>/api/cron/finalize.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  buildContext,
  processAuction,
  readChainNow,
  readNextAuctionId,
  type ActionResult,
  type KeeperContext,
} from "./keeper.js"
import { AUCTION_ABI, type AuctionData } from "./abi.js"
import type { Address } from "viem"

const PORT = Number(process.env.PORT) || 3000

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[fatal] env ${name} missing`)
    process.exit(1)
  }
  return v
}

const KEEPER_PRIVATE_KEY = requireEnv("KEEPER_PRIVATE_KEY") as `0x${string}`
const CRON_SECRET = requireEnv("CRON_SECRET")
const AUCTION_ADDRESS = "0x2e396E1f8Bba845a6dAF481099452B360b8b26DE" as Address
const RPC_URL = "https://sepolia.base.org"

if (!KEEPER_PRIVATE_KEY.startsWith("0x")) {
  console.error("[fatal] KEEPER_PRIVATE_KEY must start with 0x")
  process.exit(1)
}

const ctx: KeeperContext = buildContext({
  privateKey: KEEPER_PRIVATE_KEY,
  rpcUrl: RPC_URL,
  auctionAddress: AUCTION_ADDRESS,
})

function isAuthorized(req: IncomingMessage): boolean {
  const got = req.headers["authorization"] ?? ""
  const want = `Bearer ${CRON_SECRET}`
  if (typeof got !== "string" || got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  )
}

async function handleFinalize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!isAuthorized(req)) {
    sendJSON(res, 401, { ok: false, error: "unauthorized" })
    return
  }

  let chainNow: bigint
  try {
    chainNow = await readChainNow(ctx)
  } catch (e) {
    sendJSON(res, 502, {
      ok: false,
      error: `latest block read failed: ${(e as Error).message.slice(0, 200)}`,
    })
    return
  }

  const auctionIdParam = url.searchParams.get("auctionId")
  if (auctionIdParam !== null) {
    let auctionId: bigint
    try {
      auctionId = BigInt(auctionIdParam)
    } catch {
      sendJSON(res, 400, { ok: false, error: "auctionId must be an integer" })
      return
    }
    if (auctionId < 0n) {
      sendJSON(res, 400, { ok: false, error: "auctionId must be non-negative" })
      return
    }
    let nextId: bigint
    try {
      nextId = await readNextAuctionId(ctx)
    } catch (e) {
      sendJSON(res, 502, {
        ok: false,
        error: `nextAuctionId read failed: ${(e as Error).message.slice(0, 200)}`,
      })
      return
    }
    if (auctionId >= nextId) {
      sendJSON(res, 404, {
        ok: false,
        error: `auction ${auctionId} does not exist (nextAuctionId=${nextId})`,
      })
      return
    }
    const results = await processAuction(auctionId, ctx, chainNow)
    sendJSON(res, 200, {
      ok: true,
      mode: "one-shot",
      results,
      keeper: ctx.account.address,
      chainNow: chainNow.toString(),
    })
    return
  }

  // Sweep: stop at the first non-skip action.
  let auctionCount: bigint
  try {
    auctionCount = await readNextAuctionId(ctx)
  } catch (e) {
    sendJSON(res, 502, {
      ok: false,
      error: `auctionCount read failed: ${(e as Error).message.slice(0, 200)}`,
    })
    return
  }
  const allResults: ActionResult[] = []
  for (let id = 0n; id < auctionCount; id++) {
    const r = await processAuction(id, ctx, chainNow)
    allResults.push(...r)
    const acted = r.find((x) => x.action === "endAuction" || x.action === "finalizeAuction")
    if (acted) break
  }
  sendJSON(res, 200, {
    ok: true,
    mode: "sweep",
    results: allResults,
    keeper: ctx.account.address,
    count: auctionCount.toString(),
    chainNow: chainNow.toString(),
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  try {
    if (url.pathname === "/health") {
      sendJSON(res, 200, { ok: true, keeper: ctx.account.address })
      return
    }
    if (url.pathname === "/api/cron/finalize" && req.method === "GET") {
      await handleFinalize(req, res, url)
      return
    }
    sendJSON(res, 404, { ok: false, error: "not found" })
  } catch (e) {
    console.error("[unhandled]", e)
    sendJSON(res, 500, { ok: false, error: (e as Error).message.slice(0, 240) })
  }
})

server.listen(PORT, () => {
  console.log(
    `[relayer] listening on :${PORT} keeper=${ctx.account.address} auction=${AUCTION_ADDRESS}`,
  )
})

/**
 * Background chain-poll loop. Every POLL_INTERVAL_MS we:
 *   1. read nextAuctionId
 *   2. for each id not yet finalized, read its state
 *   3. if chainNow >= endTime && !finalized, fire processAuction
 *
 * This removes the cron-job.org slack — auctions are picked up within
 * POLL_INTERVAL_MS of their endTime instead of waiting for cron-job.org to
 * fire (~30s slack). The HTTP /api/cron/finalize endpoint stays as a
 * manual/cron backstop and is idempotent against the poll loop.
 */
const POLL_INTERVAL_MS = 3_000
const settled = new Set<string>()  // auction ids confirmed finalized (or no-bids)
const inFlight = new Set<string>() // auction ids currently being processed

async function pollTick(): Promise<void> {
  let chainNow: bigint
  let nextId: bigint
  try {
    const [now, next] = await Promise.all([
      ctx.publicClient.getBlock({ blockTag: "latest" }).then((b) => b.timestamp),
      ctx.publicClient.readContract({
        address: ctx.auctionAddress,
        abi: AUCTION_ABI,
        functionName: "nextAuctionId",
      }) as Promise<bigint>,
    ])
    chainNow = now
    nextId = next
  } catch (e) {
    console.error("[poll] chain read failed:", (e as Error).message.slice(0, 200))
    return
  }

  for (let id = 0n; id < nextId; id++) {
    const key = id.toString()
    if (settled.has(key)) continue
    if (inFlight.has(key)) continue

    let a: AuctionData
    try {
      a = (await ctx.publicClient.readContract({
        address: ctx.auctionAddress,
        abi: AUCTION_ABI,
        functionName: "getAuction",
        args: [id],
      })) as AuctionData
    } catch (e) {
      console.error(`[poll] getAuction(${key}) failed:`, (e as Error).message.slice(0, 160))
      continue
    }

    if (a.finalized) {
      settled.add(key)
      continue
    }
    if (a.ended && a.numBids === 0n) {
      // No-bid auction stuck post-endAuction — nothing to decrypt. Don't
      // re-process every tick.
      settled.add(key)
      continue
    }
    if (chainNow < a.endTime) continue

    inFlight.add(key)
    processAuction(id, ctx, chainNow)
      .then((results) => {
        console.log(`[poll] #${key}:`, results.map((r) => r.action).join(", "))
        for (const r of results) {
          if (r.error) console.error(`[poll] #${key} ${r.action} error:`, r.error)
        }
        // Only mark settled on actual success — errors mean we should retry
        // on the next tick. finalizeAuction requires a tx hash to count;
        // skip-finalized means it was already settled; skip-no-bids is a
        // terminal zombie state.
        const success = results.some(
          (r) =>
            (r.action === "finalizeAuction" && r.tx) ||
            r.action === "skip-finalized" ||
            r.action === "skip-no-bids",
        )
        if (success) settled.add(key)
      })
      .catch((e) => {
        console.error(`[poll] processAuction(${key}) threw:`, (e as Error).message.slice(0, 200))
      })
      .finally(() => inFlight.delete(key))
  }
}

setInterval(() => {
  void pollTick()
}, POLL_INTERVAL_MS)
console.log(`[relayer] chain poll loop active every ${POLL_INTERVAL_MS}ms`)
