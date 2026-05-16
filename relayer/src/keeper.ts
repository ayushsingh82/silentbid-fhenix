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
    | "endAuction-error"
    | "finalizeAuction"
    | "finalize-error"
    | "skip-live"
    | "skip-finalized"
    | "skip-pending-oracle"
    | "skip-no-bids"
    | "noop"
  tx?: `0x${string}`
  error?: string
}

// CoFHE threshold network indexing lag after FHE.allowPublic. The SDK
// retries decryptForTx internally until this budget elapses. Short value
// is fine because the background poll loop retries every 5s, so if the
// oracle isn't ready yet we try again on the next tick rather than
// holding a single request open.
const COFHE_ORACLE_WAIT_MS = 30_000

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
    // Both handles got their `allowPublic` flag set in the same endAuction
    // tx, so the threshold network indexes them together. Run the two
    // decrypts in parallel — saves whichever-is-slower's worth of wall time.
    const [bidderResult, amountResult] = await Promise.all([
      client
        .decryptForTx(a.highestBidderHandle)
        .set404RetryTimeout(COFHE_ORACLE_WAIT_MS)
        .withoutPermit()
        .execute(),
      client
        .decryptForTx(a.highestBidHandle)
        .set404RetryTimeout(COFHE_ORACLE_WAIT_MS)
        .withoutPermit()
        .execute(),
    ])

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
          : "finalize-error",
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
      out.push({ auctionId: id.toString(), action: "endAuction", tx: hash })
      // Don't `waitForTransactionReceipt` here — the CoFHE threshold
      // network watches chain events directly, so it sees `allowPublic` as
      // soon as endAuction mines (regardless of whether we waited). Going
      // straight into the decrypt call lets the SDK's internal polling
      // overlap with the tx confirmation.
      // Re-read so the finalize step sees the post-endAuction handles.
      // Small chance the read races the mine; if it does, the handles will
      // be zeros and decryptForTx 404s — the 90s budget covers the few
      // seconds until the new block lands.
      a = await readAuction(id, ctx)
    } catch (e) {
      out.push({
        auctionId: id.toString(),
        action: "endAuction-error",
        error: (e as Error).message.slice(0, 240),
      })
      return out
    }
  }

  // ended && !finalized — chain immediately into finalize.
  out.push(await doFinalize(id, a, ctx))
  return out
}
