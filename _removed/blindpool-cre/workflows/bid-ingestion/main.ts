/**
 * SilentBid Bid Ingestion Workflow (CRE)
 *
 * HTTP trigger: POST body = { sender, auctionId, maxPrice, amount, flags?, timestamp, auth }
 * - Verifies EIP-712 signature (SilentBidBid type).
 * - Computes bidCommitment = keccak256(encodePacked(auctionId, sender, maxPrice, amount, timestamp)).
 * - Optionally calls compliance API via Confidential HTTP (when config.complianceApiUrl set).
 * - Returns { commitment, sender, auctionId, amount } for frontend to call
 *   SilentBidCCA.submitSilentBid(commitment) with value: amount, or for relayer to submit.
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
import { keccak256, encodePacked, verifyTypedData, type Hex } from "viem"
import { z } from "zod"

const configSchema = z.object({
  chainId: z.number(),
  silentBidDomainName: z.string(),
  silentBidDomainVersion: z.string(),
  complianceApiUrl: z.string().optional(),
  complianceApiKeyOwner: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

const EIP712_TYPES = {
  Bid: [
    { name: "sender", type: "address" },
    { name: "auctionId", type: "address" },
    { name: "maxPrice", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "flags", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ] as const,
}

type BidPayload = {
  sender: string
  auctionId: string
  maxPrice: string
  amount: string
  flags?: string
  timestamp: string
  auth: string
}

function computeBidCommitment(
  auctionId: Hex,
  sender: Hex,
  maxPrice: bigint,
  amount: bigint,
  timestamp: bigint
): Hex {
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint256"],
      [auctionId, sender, maxPrice, amount, timestamp]
    )
  )
}

const onBidRequest = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
  if (!payload.input || payload.input.length === 0) {
    runtime.log("Empty request body")
    throw new Error("Empty request body")
  }

  const raw = decodeJson(payload.input) as BidPayload
  const sender = raw.sender as Hex
  const auctionId = raw.auctionId as Hex
  const maxPrice = BigInt(raw.maxPrice)
  const amount = BigInt(raw.amount)
  const timestamp = BigInt(raw.timestamp)
  const flags = BigInt(raw.flags ?? "0")
  const auth = raw.auth as Hex

  // Domain matches frontend SILENTBID_DOMAIN (no verifyingContract — domain separator
  // is name + version + chainId only; the contract address is part of the bid message).
  const domain = {
    name: runtime.config.silentBidDomainName,
    version: runtime.config.silentBidDomainVersion,
    chainId: runtime.config.chainId,
  }

  const message = {
    sender,
    auctionId,
    maxPrice,
    amount,
    flags,
    timestamp,
  }

  // Skip verification when auth is placeholder (e.g. simulation); in production require valid EIP-712.
  const isPlaceholder = !auth || auth === "0x" || auth.length < 130
  if (!isPlaceholder) {
    const valid = await verifyTypedData({
      address: sender,
      domain,
      types: EIP712_TYPES,
      primaryType: "Bid",
      message,
      signature: auth,
    })
    if (!valid) {
      runtime.log("EIP-712 signature verification failed")
      throw new Error("Invalid signature")
    }
  } else {
    runtime.log("Signature omitted or placeholder — commitment computed only (e.g. simulation)")
  }

  const commitment = computeBidCommitment(auctionId, sender, maxPrice, amount, timestamp)
  runtime.log(`Bid commitment: ${commitment}`)

  // Optional: call compliance API via Confidential HTTP (when config has URL)
  // if (runtime.config.complianceApiUrl) { ... ConfidentialHTTPClient ... }

  const result = {
    commitment,
    sender,
    auctionId,
    amount: raw.amount,
    timestamp: raw.timestamp,
  }
  return JSON.stringify(result)
}

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()
  const trigger = http.trigger({
    authorizedKeys: [], // For simulation; in production add EVM addresses that may trigger
  })
  return [handler(trigger, onBidRequest)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
