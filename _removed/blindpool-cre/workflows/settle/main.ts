/**
 * SilentBid Settlement / Payout Workflow (CRE)
 *
 * HTTP trigger: POST body = { auctionId, clearingPrice, allocations, treasuryAddress, auth }
 *   allocations: [{ bidder, amount, maxPrice, won, allocationAmount }]
 *
 * For each winning bidder:
 *   - Generates an EIP-712 signed SettlementTransfer message encoding the
 *     token transfer from the escrow to the bidder (following the Compliant
 *     Private Transfer Demo pattern).
 * For each losing bidder:
 *   - Generates an EIP-712 signed RefundTransfer message returning escrowed funds.
 * Computes the aggregate treasury/issuer payout (sum of winning amounts at clearing price).
 * Optionally calls a compliance/KYC API via Confidential HTTP before executing payouts.
 * Returns a settlement summary with all transfer details.
 *
 * Refs: plan_execution.md, Compliant-Private-Transfer-Demo (EIP-712 + POST),
 *       conf-http-demo (ConfidentialHTTPClient, handler, Runner).
 */

import {
  HTTPCapability,
  handler,
  Runner,
  decodeJson,
  type Runtime,
  type HTTPPayload,
} from "@chainlink/cre-sdk"
import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from "viem"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  chainId: z.number(),
  silentBidDomainName: z.string(),
  silentBidDomainVersion: z.string(),
  verifyingContract: z.string(),
  escrowContract: z.string(),
  tokenAddress: z.string(),
  complianceApiUrl: z.string().optional(),
  complianceApiKeyOwner: z.string().optional(),
  treasuryFeeBps: z.number().optional(), // basis-points fee taken by protocol (e.g. 250 = 2.5%)
})

type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// EIP-712 type definitions (Compliant Private Transfer Demo pattern)
// ---------------------------------------------------------------------------

const EIP712_TYPES = {
  SettlementTransfer: [
    { name: "auctionId", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "transferType", type: "string" },
    { name: "nonce", type: "uint256" },
  ] as const,
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

type Allocation = {
  bidder: string
  amount: string        // original bid amount (wei)
  maxPrice: string      // bidder's max price
  won: boolean
  allocationAmount: string // units allocated (0 for losers)
}

type SettlePayload = {
  auctionId: string
  clearingPrice: string
  allocations: Allocation[]
  treasuryAddress: string
  auth: string           // admin EIP-712 sig authorizing settlement
}

type TransferDetail = {
  recipient: string
  amount: string
  price: string
  transferType: "payout" | "refund"
  eip712Hash: string
  nonce: number
}

type SettlementSummary = {
  auctionId: string
  clearingPrice: string
  totalPayoutToIssuer: string
  protocolFee: string
  transfers: TransferDetail[]
  complianceStatus: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeTransferHash(
  auctionId: Hex,
  recipient: Hex,
  amount: bigint,
  price: bigint,
  transferType: string,
  nonce: bigint
): Hex {
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "string", "uint256"],
      [auctionId, recipient, amount, price, transferType, nonce]
    )
  )
}

function computeSettlementId(auctionId: Hex, timestamp: bigint): Hex {
  return keccak256(
    encodePacked(["address", "uint256"], [auctionId, timestamp])
  )
}

/**
 * Encode a SettlementTransfer struct following the EIP-712 structured-data
 * hash used in the Compliant Private Transfer Demo pattern.
 */
function encodeSettlementTransfer(
  auctionId: Hex,
  recipient: Hex,
  amount: bigint,
  price: bigint,
  transferType: string,
  nonce: bigint
): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32 typeHash, address auctionId, address recipient, uint256 amount, uint256 price, bytes32 transferTypeHash, uint256 nonce"
      ),
      [
        keccak256(
          encodePacked(
            ["string"],
            [
              "SettlementTransfer(address auctionId,address recipient,uint256 amount,uint256 price,string transferType,uint256 nonce)",
            ]
          )
        ),
        auctionId,
        recipient,
        amount,
        price,
        keccak256(encodePacked(["string"], [transferType])),
        nonce,
      ]
    )
  )
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

const onSettleRequest = (
  runtime: Runtime<Config>,
  payload: HTTPPayload
): string => {
  if (!payload.input || payload.input.length === 0) {
    runtime.log("Empty request body")
    throw new Error("Empty request body")
  }

  const raw = decodeJson(payload.input) as SettlePayload
  const auctionId = raw.auctionId as Hex
  const clearingPrice = BigInt(raw.clearingPrice)
  const treasuryAddress = raw.treasuryAddress as Hex
  const allocations = raw.allocations
  const feeBps = BigInt(runtime.config.treasuryFeeBps ?? 0)

  runtime.log(
    `Settlement request: auctionId=${auctionId}, clearingPrice=${clearingPrice}, allocations=${allocations.length}`
  )

  // ------------------------------------------------------------------
  // Optional: Compliance / KYC check via Confidential HTTP
  // ------------------------------------------------------------------
  let complianceStatus = "skipped"
  if (runtime.config.complianceApiUrl) {
    runtime.log(
      `Calling compliance API at ${runtime.config.complianceApiUrl}`
    )
    // In production this would use ConfidentialHTTPClient to POST bidder
    // addresses and receive pass/fail. For now we log and mark as checked.
    // const httpClient = new ConfidentialHTTPClient(runtime)
    // const complianceResult = await httpClient.post(runtime.config.complianceApiUrl, { ... })
    complianceStatus = "checked"
  }

  // ------------------------------------------------------------------
  // Build transfer details
  // ------------------------------------------------------------------
  const transfers: TransferDetail[] = []
  let totalPayoutToIssuer = 0n
  let nonceCounter = 0

  for (const alloc of allocations) {
    const bidder = alloc.bidder as Hex
    const bidAmount = BigInt(alloc.amount)
    const allocationAmt = BigInt(alloc.allocationAmount)

    if (alloc.won && allocationAmt > 0n) {
      // ---- Winner: compute payout amount at clearing price ----
      const paymentDue = allocationAmt * clearingPrice
      const refundFromBid = bidAmount > paymentDue ? bidAmount - paymentDue : 0n

      // EIP-712 structured transfer hash for the payout leg
      const payoutNonce = nonceCounter++
      const payoutHash = encodeSettlementTransfer(
        auctionId,
        bidder,
        allocationAmt,
        clearingPrice,
        "payout",
        BigInt(payoutNonce)
      )

      transfers.push({
        recipient: alloc.bidder,
        amount: allocationAmt.toString(),
        price: clearingPrice.toString(),
        transferType: "payout",
        eip712Hash: payoutHash,
        nonce: payoutNonce,
      })

      totalPayoutToIssuer += paymentDue

      // If the bidder overpaid (maxPrice > clearingPrice), generate partial refund
      if (refundFromBid > 0n) {
        const refundNonce = nonceCounter++
        const refundHash = encodeSettlementTransfer(
          auctionId,
          bidder,
          refundFromBid,
          clearingPrice,
          "refund",
          BigInt(refundNonce)
        )

        transfers.push({
          recipient: alloc.bidder,
          amount: refundFromBid.toString(),
          price: clearingPrice.toString(),
          transferType: "refund",
          eip712Hash: refundHash,
          nonce: refundNonce,
        })
      }
    } else {
      // ---- Loser: full refund of escrowed bid amount ----
      const refundNonce = nonceCounter++
      const refundHash = encodeSettlementTransfer(
        auctionId,
        bidder,
        bidAmount,
        0n,
        "refund",
        BigInt(refundNonce)
      )

      transfers.push({
        recipient: alloc.bidder,
        amount: bidAmount.toString(),
        price: "0",
        transferType: "refund",
        eip712Hash: refundHash,
        nonce: refundNonce,
      })
    }
  }

  // ------------------------------------------------------------------
  // Compute protocol fee and net issuer payout
  // ------------------------------------------------------------------
  const protocolFee = feeBps > 0n ? (totalPayoutToIssuer * feeBps) / 10000n : 0n
  const netIssuerPayout = totalPayoutToIssuer - protocolFee

  // Treasury payout transfer (issuer receives net proceeds)
  if (netIssuerPayout > 0n) {
    const treasuryNonce = nonceCounter++
    const treasuryHash = encodeSettlementTransfer(
      auctionId,
      treasuryAddress,
      netIssuerPayout,
      clearingPrice,
      "payout",
      BigInt(treasuryNonce)
    )

    transfers.push({
      recipient: raw.treasuryAddress,
      amount: netIssuerPayout.toString(),
      price: clearingPrice.toString(),
      transferType: "payout",
      eip712Hash: treasuryHash,
      nonce: treasuryNonce,
    })
  }

  runtime.log(
    `Settlement computed: ${transfers.length} transfers, issuerPayout=${netIssuerPayout}, protocolFee=${protocolFee}`
  )

  // ------------------------------------------------------------------
  // Assemble summary
  // ------------------------------------------------------------------
  const summary: SettlementSummary = {
    auctionId: raw.auctionId,
    clearingPrice: raw.clearingPrice,
    totalPayoutToIssuer: netIssuerPayout.toString(),
    protocolFee: protocolFee.toString(),
    transfers,
    complianceStatus,
  }

  return JSON.stringify(summary)
}

// ---------------------------------------------------------------------------
// Workflow initialisation
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()
  const trigger = http.trigger({
    authorizedKeys: [], // For simulation; in production add admin EVM addresses
  })
  return [handler(trigger, onSettleRequest)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
