/**
 * Keeper state machine — ported from app/api/cron/finalize/route.ts in the
 * Next.js app. Single transition per call; chain is source of truth.
 *
 *   live (chainNow < endTime, !ended)      → skip
 *   expired (chainNow >= endTime, !ended)  → endAuction
 *   ended && !finalized                    → decryptForTx + finalizeAuction
 *   finalized                              → skip
 */

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
import { AUCTION_ABI, type AuctionData } from "./abi.js"

type DecryptForTxResult = { decryptedValue: bigint; signature: `0x${string}` }
type DecryptBuilder = {
  set404RetryTimeout: (ms: number) => DecryptBuilder
  withoutPermit: () => { execute: () => Promise<DecryptForTxResult> }
}
type CofheNodeClient = {
  decryptForTx: (handle: `0x${string}`) => DecryptBuilder
}

export type ActionResult = {
  auctionId: string
  action:
    | "endAuction"
    | "finalizeAuction"
    | "skip-live"
    | "skip-finalized"
    | "skip-pending-oracle"
    | "skip-no-bids"
    | "noop"
  tx?: `0x${string}`
  error?: string
}

// CoFHE threshold network indexing lag after FHE.allowPublic — bump if
// flaky. The SDK retries decryptForTx internally until this budget elapses.
// 120s was too tight: a cron-fired call hit endAuction successfully but
// timed out the decrypt wait before the oracle indexed. 240s covers the
// observed p99 indexing window on Base Sepolia. cron-job.org's own HTTP
// timeout (~30s) doesn't matter here — the relayer keeps running after the
// client disconnects, and the chain finalize lands whenever it lands.
const COFHE_ORACLE_WAIT_MS = 240_000

export type KeeperConfig = {
  privateKey: `0x${string}`
  rpcUrl: string
  auctionAddress: Address
}

export type KeeperContext = {
  publicClient: PublicClient
  walletClient: WalletClient
  account: PrivateKeyAccount
  auctionAddress: Address
  getCofhe: () => Promise<CofheNodeClient>
}

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

export function buildContext(cfg: KeeperConfig): KeeperContext {
  const account = privateKeyToAccount(cfg.privateKey)
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(cfg.rpcUrl),
  })
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(cfg.rpcUrl),
  })
  let cofheClient: CofheNodeClient | null = null
  const getCofhe = async (): Promise<CofheNodeClient> => {
    if (cofheClient) return cofheClient
    cofheClient = await loadCofheClient({ publicClient, walletClient })
    return cofheClient
  }
  return {
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    account,
    auctionAddress: cfg.auctionAddress,
    getCofhe,
  }
}

export async function readChainNow(ctx: KeeperContext): Promise<bigint> {
  const block = await ctx.publicClient.getBlock({ blockTag: "latest" })
  return block.timestamp
}

export async function readNextAuctionId(ctx: KeeperContext): Promise<bigint> {
  return (await ctx.publicClient.readContract({
    address: ctx.auctionAddress,
    abi: AUCTION_ABI,
    functionName: "nextAuctionId",
  })) as bigint
}

async function readAuction(id: bigint, ctx: KeeperContext): Promise<AuctionData> {
  return (await ctx.publicClient.readContract({
    address: ctx.auctionAddress,
    abi: AUCTION_ABI,
    functionName: "getAuction",
    args: [id],
  })) as AuctionData
}

async function doFinalize(
  id: bigint,
  a: AuctionData,
  ctx: KeeperContext,
): Promise<ActionResult> {
  if (a.numBids === 0n) {
    return { auctionId: id.toString(), action: "skip-no-bids" }
  }
  try {
    const client = await ctx.getCofhe()
    // set404RetryTimeout makes the SDK wait up to COFHE_ORACLE_WAIT_MS for
    // the threshold network to index the FHE.allowPublic event mined inside
    // endAuction. Lets us chain endAuction → finalize in a single call.
    const bidderResult = await client
      .decryptForTx(a.highestBidderHandle)
      .set404RetryTimeout(COFHE_ORACLE_WAIT_MS)
      .withoutPermit()
      .execute()
    const amountResult = await client
      .decryptForTx(a.highestBidHandle)
      .set404RetryTimeout(COFHE_ORACLE_WAIT_MS)
      .withoutPermit()
      .execute()

    const winnerRaw = bidderResult.decryptedValue
    const amountRaw = amountResult.decryptedValue
    const winner = (`0x${winnerRaw.toString(16).padStart(40, "0")}`) as Address

    const hash = await ctx.walletClient.writeContract({
      address: ctx.auctionAddress,
      abi: AUCTION_ABI,
      functionName: "finalizeAuction",
      args: [id, winner, amountRaw, bidderResult.signature, amountResult.signature],
      account: ctx.account,
      chain: baseSepolia,
    })
    await ctx.publicClient.waitForTransactionReceipt({ hash })
    return { auctionId: id.toString(), action: "finalizeAuction", tx: hash }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300)
    return {
      auctionId: id.toString(),
      action:
        msg.includes("404") || msg.toLowerCase().includes("not found")
          ? "skip-pending-oracle"
          : "finalizeAuction",
      error: msg,
    }
  }
}

/**
 * Drive an auction as far as it can go in a single call. Chains both
 * transitions (live→ended via endAuction, ended→finalized via finalize)
 * inside one HTTP invocation — cron-job.org only needs to fire once per
 * auction, at endTime + small slack.
 */
export async function processAuction(
  id: bigint,
  ctx: KeeperContext,
  chainNow: bigint,
): Promise<ActionResult[]> {
  const out: ActionResult[] = []
  let a = await readAuction(id, ctx)

  if (a.finalized) {
    out.push({ auctionId: id.toString(), action: "skip-finalized" })
    return out
  }

  if (!a.ended) {
    if (chainNow < a.endTime) {
      out.push({ auctionId: id.toString(), action: "skip-live" })
      return out
    }
    try {
      const hash = await ctx.walletClient.writeContract({
        address: ctx.auctionAddress,
        abi: AUCTION_ABI,
        functionName: "endAuction",
        args: [id],
        account: ctx.account,
        chain: baseSepolia,
      })
      await ctx.publicClient.waitForTransactionReceipt({ hash })
      out.push({ auctionId: id.toString(), action: "endAuction", tx: hash })
      // Re-read so the finalize step sees the post-endAuction handles.
      a = await readAuction(id, ctx)
    } catch (e) {
      out.push({
        auctionId: id.toString(),
        action: "endAuction",
        error: (e as Error).message.slice(0, 240),
      })
      return out
    }
  }

  // ended && !finalized — chain immediately into finalize.
  out.push(await doFinalize(id, a, ctx))
  return out
}
