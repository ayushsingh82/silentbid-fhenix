/**
 * SilentBid Auction Finalization Workflow (CRE)
 *
 * HTTP trigger: POST body = { auctionId, silentBidAddress?, tokenSupply? }
 * - Loads sealed bids for auction from CRE data store (simulated in-memory store).
 * - Sorts bids by maxPrice descending (uniform-price auction).
 * - Computes clearing price: the price at which cumulative ETH committed meets
 *   the token supply (or the lowest winning bid's maxPrice).
 * - Determines winning bids and per-bid allocations (pro-rata at the margin).
 * - Generates the calldata for SilentBidCCA.forwardBidsToCCA(
 *     silentBidIds, clearMaxPrices, clearAmounts, owners, hookData
 *   ).
 * - Returns the finalization result with clearing price, total raised,
 *   winning bids, and the encoded calldata.
 *
 * Refs: plan_execution.md, SilentBid-scripts/src/SilentBidCCA.sol
 */

import {
  HTTPCapability,
  handler,
  Runner,
  decodeJson,
  type Runtime,
  type HTTPPayload,
} from "@chainlink/cre-sdk"
import { encodeFunctionData, type Hex, parseAbi } from "viem"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  chainId: z.number(),
  silentBidAddress: z.string(),
  rpcUrl: z.string(),
})

type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FinalizePayload = {
  auctionId: string
  silentBidAddress?: string
  /** Total token supply available in the auction (in wei). Defaults to 1000e18. */
  tokenSupply?: string
}

/** A stored bid as kept in the CRE private data store. */
interface StoredBid {
  silentBidId: number
  owner: string        // bidder address
  maxPrice: bigint     // max price willing to pay (wei per token unit)
  amount: bigint       // ETH committed / escrowed
  ethDeposit: bigint   // original ETH deposit on-chain
  commitment: string   // bid commitment hash
  timestamp: bigint
}

/** Result for a single winning bid after clearing. */
interface WinningBid {
  silentBidId: number
  owner: string
  maxPrice: string
  clearAmount: string   // actual ETH allocated at clearing price
  allocation: string    // tokens allocated (in wei)
}

/** The complete finalization result returned to the caller. */
interface FinalizeResult {
  auctionId: string
  silentBidAddress: string
  status: string
  clearingPrice: string
  totalRaised: string
  totalTokensAllocated: string
  tokenSupply: string
  winningBids: WinningBid[]
  losingBidIds: number[]
  calldata: string
}

// ---------------------------------------------------------------------------
// ABI for SilentBidCCA.forwardBidsToCCA (batch)
// ---------------------------------------------------------------------------

const SILENT_BID_CCA_ABI = parseAbi([
  "function forwardBidsToCCA(uint256[] _silentBidIds, uint256[] _clearMaxPrices, uint128[] _clearAmounts, address[] _owners, bytes[] _hookData) external",
])

// ---------------------------------------------------------------------------
// Simulated Bid Store
// ---------------------------------------------------------------------------
// In production this would load from CRE's confidential data store or an
// encrypted database. For simulation and hackathon purposes we use an
// in-memory store populated with representative test bids.

function loadBidsForAuction(auctionId: string, runtime: Runtime<Config>): StoredBid[] {
  // Simulated bids for demonstration — in production these would be fetched
  // from the CRE private store keyed by auctionId.
  const simulatedBids: StoredBid[] = [
    {
      silentBidId: 0,
      owner: "0x1111111111111111111111111111111111111111",
      maxPrice: BigInt("5000000000000000000"),   // 5 ETH per token
      amount: BigInt("10000000000000000000"),     // 10 ETH committed
      ethDeposit: BigInt("10000000000000000000"),
      commitment: "0xaaa1",
      timestamp: BigInt(1700000001),
    },
    {
      silentBidId: 1,
      owner: "0x2222222222222222222222222222222222222222",
      maxPrice: BigInt("4000000000000000000"),   // 4 ETH per token
      amount: BigInt("8000000000000000000"),      // 8 ETH committed
      ethDeposit: BigInt("8000000000000000000"),
      commitment: "0xbbb2",
      timestamp: BigInt(1700000002),
    },
    {
      silentBidId: 2,
      owner: "0x3333333333333333333333333333333333333333",
      maxPrice: BigInt("3000000000000000000"),   // 3 ETH per token
      amount: BigInt("6000000000000000000"),      // 6 ETH committed
      ethDeposit: BigInt("6000000000000000000"),
      commitment: "0xccc3",
      timestamp: BigInt(1700000003),
    },
    {
      silentBidId: 3,
      owner: "0x4444444444444444444444444444444444444444",
      maxPrice: BigInt("2000000000000000000"),   // 2 ETH per token
      amount: BigInt("4000000000000000000"),      // 4 ETH committed
      ethDeposit: BigInt("4000000000000000000"),
      commitment: "0xddd4",
      timestamp: BigInt(1700000004),
    },
    {
      silentBidId: 4,
      owner: "0x5555555555555555555555555555555555555555",
      maxPrice: BigInt("1000000000000000000"),   // 1 ETH per token
      amount: BigInt("2000000000000000000"),      // 2 ETH committed
      ethDeposit: BigInt("2000000000000000000"),
      commitment: "0xeee5",
      timestamp: BigInt(1700000005),
    },
  ]

  runtime.log(`Loaded ${simulatedBids.length} bids for auction ${auctionId}`)
  return simulatedBids
}

// ---------------------------------------------------------------------------
// Clearing Price Computation (Uniform-Price Auction)
// ---------------------------------------------------------------------------
//
// Algorithm:
// 1. Sort bids by maxPrice descending (highest willingness-to-pay first).
// 2. Walk through bids accumulating token allocations:
//    - Each bid at price P can purchase at most (amount / clearingPrice) tokens,
//      but since we don't know the clearing price yet, we compute the maximum
//      tokens each bidder WOULD get at their own maxPrice:
//        tokensAtOwnPrice = amount (ETH committed) — the bidder committed this ETH.
//    - Actually for a uniform-price auction: everyone pays the clearing price.
//      A bidder who bid maxPrice >= clearingPrice gets tokens at the clearing price.
//      tokens_i = ethCommitted_i / clearingPrice  (for winning bids).
// 3. The clearing price is the lowest maxPrice among winning bids, OR the price
//    at which cumulative demand (in tokens) exactly equals supply.
// 4. At the marginal price, bids may need to be pro-rated if total demand exceeds supply.

interface ClearingResult {
  clearingPrice: bigint
  winningBids: WinningBid[]
  losingBidIds: number[]
  totalRaised: bigint
  totalTokensAllocated: bigint
}

function computeClearing(
  bids: StoredBid[],
  tokenSupply: bigint,
  runtime: Runtime<Config>
): ClearingResult {
  if (bids.length === 0) {
    return {
      clearingPrice: 0n,
      winningBids: [],
      losingBidIds: [],
      totalRaised: 0n,
      totalTokensAllocated: 0n,
    }
  }

  // Sort by maxPrice descending; ties broken by earlier timestamp
  const sorted = [...bids].sort((a, b) => {
    if (b.maxPrice > a.maxPrice) return 1
    if (b.maxPrice < a.maxPrice) return -1
    if (a.timestamp < b.timestamp) return -1
    if (a.timestamp > b.timestamp) return 1
    return 0
  })

  runtime.log(`Sorted ${sorted.length} bids by maxPrice descending`)

  // Walk through price levels from highest to lowest.
  // At each candidate clearing price P (= bid's maxPrice), compute total tokens
  // demanded by all bidders with maxPrice >= P:
  //   tokens_demanded = sum( ethCommitted_i / P ) for all i with maxPrice >= P
  //
  // The clearing price is the highest P where tokens_demanded >= tokenSupply,
  // OR if demand never reaches supply, the lowest bidder's maxPrice (all bids win).

  // We use 18-decimal fixed point: 1 token = 1e18 wei units.
  const PRECISION = BigInt("1000000000000000000") // 1e18

  let clearingPrice = 0n
  let foundClearing = false

  // Try each bid's maxPrice as a candidate clearing price (from high to low)
  for (let i = 0; i < sorted.length; i++) {
    const candidatePrice = sorted[i].maxPrice

    // Compute total tokens demanded at this price by all eligible bidders
    let totalTokensDemanded = 0n
    for (let j = 0; j <= i; j++) {
      // tokens = (ethCommitted * PRECISION) / candidatePrice
      // This gives tokens in wei (18 decimals) when price is in wei-per-token
      const tokens = (sorted[j].amount * PRECISION) / candidatePrice
      totalTokensDemanded += tokens
    }

    runtime.log(
      `Price level ${candidatePrice.toString()}: ` +
      `${i + 1} eligible bidders, tokens demanded = ${totalTokensDemanded.toString()}, ` +
      `supply = ${tokenSupply.toString()}`
    )

    if (totalTokensDemanded >= tokenSupply) {
      clearingPrice = candidatePrice
      foundClearing = true
      runtime.log(`Clearing price found: ${clearingPrice.toString()}`)
      break
    }
  }

  // If demand never reaches supply, all bids win at the lowest bidder's price
  if (!foundClearing) {
    clearingPrice = sorted[sorted.length - 1].maxPrice
    runtime.log(`Demand < supply; clearing at lowest bid price: ${clearingPrice.toString()}`)
  }

  // Now allocate tokens to each winning bidder (maxPrice >= clearingPrice)
  const winningBids: WinningBid[] = []
  const losingBidIds: number[] = []
  let totalTokensAllocated = 0n
  let totalRaised = 0n
  let remainingSupply = tokenSupply

  // Separate bids into winners (above clearing) and marginal (at clearing)
  const aboveClearing: StoredBid[] = []
  const atClearing: StoredBid[] = []

  for (const bid of sorted) {
    if (bid.maxPrice > clearingPrice) {
      aboveClearing.push(bid)
    } else if (bid.maxPrice === clearingPrice) {
      atClearing.push(bid)
    } else {
      losingBidIds.push(bid.silentBidId)
    }
  }

  // Allocate to above-clearing bids first (they get full allocation at clearing price)
  for (const bid of aboveClearing) {
    const tokensForBid = (bid.amount * PRECISION) / clearingPrice
    const actualTokens = tokensForBid > remainingSupply ? remainingSupply : tokensForBid
    const ethUsed = (actualTokens * clearingPrice) / PRECISION

    remainingSupply -= actualTokens
    totalTokensAllocated += actualTokens
    totalRaised += ethUsed

    winningBids.push({
      silentBidId: bid.silentBidId,
      owner: bid.owner,
      maxPrice: bid.maxPrice.toString(),
      clearAmount: ethUsed.toString(),
      allocation: actualTokens.toString(),
    })
  }

  // Allocate to marginal bids (at clearing price) — pro-rata if needed
  if (remainingSupply > 0n && atClearing.length > 0) {
    // Total tokens demanded by marginal bidders
    let totalMarginalDemand = 0n
    for (const bid of atClearing) {
      totalMarginalDemand += (bid.amount * PRECISION) / clearingPrice
    }

    for (const bid of atClearing) {
      if (remainingSupply <= 0n) {
        losingBidIds.push(bid.silentBidId)
        continue
      }

      const rawTokens = (bid.amount * PRECISION) / clearingPrice

      // Pro-rata: this bidder gets (rawTokens / totalMarginalDemand) * remainingSupply
      let actualTokens: bigint
      if (totalMarginalDemand <= remainingSupply) {
        // All marginal bidders fit
        actualTokens = rawTokens
      } else {
        // Pro-rate among marginal bidders
        actualTokens = (rawTokens * remainingSupply) / totalMarginalDemand
      }

      if (actualTokens <= 0n) {
        losingBidIds.push(bid.silentBidId)
        continue
      }

      const ethUsed = (actualTokens * clearingPrice) / PRECISION

      remainingSupply -= actualTokens
      totalTokensAllocated += actualTokens
      totalRaised += ethUsed

      winningBids.push({
        silentBidId: bid.silentBidId,
        owner: bid.owner,
        maxPrice: bid.maxPrice.toString(),
        clearAmount: ethUsed.toString(),
        allocation: actualTokens.toString(),
      })
    }
  }

  runtime.log(
    `Clearing complete: price=${clearingPrice.toString()}, ` +
    `winners=${winningBids.length}, losers=${losingBidIds.length}, ` +
    `totalRaised=${totalRaised.toString()}, tokensAllocated=${totalTokensAllocated.toString()}`
  )

  return {
    clearingPrice,
    winningBids,
    losingBidIds,
    totalRaised,
    totalTokensAllocated,
  }
}

// ---------------------------------------------------------------------------
// Calldata Encoding
// ---------------------------------------------------------------------------

function encodeForwardBidsToCCACalldata(
  winningBids: WinningBid[],
  clearingPrice: bigint
): Hex {
  if (winningBids.length === 0) {
    // Return calldata for an empty batch (all arrays empty)
    return encodeFunctionData({
      abi: SILENT_BID_CCA_ABI,
      functionName: "forwardBidsToCCA",
      args: [[], [], [], [], []],
    })
  }

  const silentBidIds: bigint[] = []
  const clearMaxPrices: bigint[] = []
  const clearAmounts: bigint[] = []
  const owners: `0x${string}`[] = []
  const hookData: `0x${string}`[] = []

  for (const bid of winningBids) {
    silentBidIds.push(BigInt(bid.silentBidId))
    // Use the clearing price as the clearMaxPrice for all winning bids
    // (uniform-price: everyone pays the same price)
    clearMaxPrices.push(clearingPrice)
    // clearAmount is the ETH to forward (capped by deposit in the contract)
    clearAmounts.push(BigInt(bid.clearAmount))
    owners.push(bid.owner as `0x${string}`)
    // Empty hook data for standard bids
    hookData.push("0x" as `0x${string}`)
  }

  return encodeFunctionData({
    abi: SILENT_BID_CCA_ABI,
    functionName: "forwardBidsToCCA",
    args: [silentBidIds, clearMaxPrices, clearAmounts, owners, hookData],
  })
}

// ---------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------

const onFinalizeRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  if (!payload.input || payload.input.length === 0) {
    throw new Error("Empty request body")
  }

  const raw = decodeJson(payload.input) as FinalizePayload
  const auctionId = raw.auctionId
  const silentBidAddress = raw.silentBidAddress ?? runtime.config.silentBidAddress

  if (!auctionId) {
    throw new Error("Missing required field: auctionId")
  }

  runtime.log(`Finalize requested for auction ${auctionId}, silentBid ${silentBidAddress}`)

  // Default token supply: 10 tokens (10e18 wei) — override via payload
  const tokenSupply = raw.tokenSupply
    ? BigInt(raw.tokenSupply)
    : BigInt("10000000000000000000") // 10e18

  runtime.log(`Token supply: ${tokenSupply.toString()}`)

  // Step 1: Load all stored bids for this auction
  const bids = loadBidsForAuction(auctionId, runtime)

  if (bids.length === 0) {
    const emptyResult: FinalizeResult = {
      auctionId,
      silentBidAddress,
      status: "no_bids",
      clearingPrice: "0",
      totalRaised: "0",
      totalTokensAllocated: "0",
      tokenSupply: tokenSupply.toString(),
      winningBids: [],
      losingBidIds: [],
      calldata: "0x",
    }
    return JSON.stringify(emptyResult)
  }

  // Step 2-5: Sort bids, compute clearing price, determine winners & allocations
  const clearing = computeClearing(bids, tokenSupply, runtime)

  // Step 6: Generate calldata for forwardBidsToCCA
  const calldata = encodeForwardBidsToCCACalldata(
    clearing.winningBids,
    clearing.clearingPrice
  )

  runtime.log(`Generated forwardBidsToCCA calldata: ${calldata.slice(0, 66)}...`)

  // Step 7: Return finalization result
  const result: FinalizeResult = {
    auctionId,
    silentBidAddress,
    status: "finalized",
    clearingPrice: clearing.clearingPrice.toString(),
    totalRaised: clearing.totalRaised.toString(),
    totalTokensAllocated: clearing.totalTokensAllocated.toString(),
    tokenSupply: tokenSupply.toString(),
    winningBids: clearing.winningBids,
    losingBidIds: clearing.losingBidIds,
    calldata,
  }

  runtime.log(
    `Finalization complete: clearing price = ${clearing.clearingPrice.toString()}, ` +
    `total raised = ${clearing.totalRaised.toString()}, ` +
    `${clearing.winningBids.length} winning bids, ` +
    `${clearing.losingBidIds.length} losing bids`
  )

  return JSON.stringify(result)
}

// ---------------------------------------------------------------------------
// Workflow Init
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()
  const trigger = http.trigger({
    authorizedKeys: [], // For simulation; in production add authorized EVM addresses
  })
  return [handler(trigger, onFinalizeRequest)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
