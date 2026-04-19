import { keccak256, encodePacked, verifyTypedData } from "viem"
import { chainId } from "./chain-config"

// ── EIP-712 domain and types for SilentBid sealed bids ──────────────────

export const SILENTBID_DOMAIN = {
  name: "SilentBid",
  version: "1",
  chainId,
} as const

export const SILENTBID_BID_TYPES = {
  Bid: [
    { name: "sender", type: "address" },
    { name: "auctionId", type: "address" },
    { name: "maxPrice", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "flags", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
} as const

export interface BidTypedDataParams {
  sender: `0x${string}`
  auctionId: `0x${string}`
  maxPrice: bigint
  amount: bigint
  flags?: bigint
  timestamp?: bigint
}

/**
 * Build the full EIP-712 typed data object for signing a SilentBid bid.
 */
export function buildBidTypedData(params: BidTypedDataParams) {
  const message = {
    sender: params.sender,
    auctionId: params.auctionId,
    maxPrice: params.maxPrice,
    amount: params.amount,
    flags: params.flags ?? BigInt(0),
    timestamp: params.timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
  }
  return {
    domain: SILENTBID_DOMAIN,
    types: SILENTBID_BID_TYPES,
    primaryType: "Bid" as const,
    message,
  }
}

/**
 * Verify an EIP-712 bid signature against an expected signer address.
 * Returns true if the recovered address matches.
 */
export async function verifyBidSignature(
  typedData: ReturnType<typeof buildBidTypedData>,
  signature: `0x${string}`,
  expectedSigner: `0x${string}`
): Promise<boolean> {
  return verifyTypedData({
    address: expectedSigner,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature,
  })
}

/**
 * Compute the onchain bid commitment for SilentBid (SilentBidCCA.submitSilentBid(bytes32)).
 * Must match the format expected by CRE workflows (see md/CRE_INTEGRATION.md).
 */
export function computeBidCommitment(
  auctionId: `0x${string}`,
  sender: `0x${string}`,
  maxPriceQ96: bigint,
  amountWei: bigint,
  timestampSeconds: bigint = BigInt(Math.floor(Date.now() / 1000))
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint256"],
      [auctionId, sender, maxPriceQ96, amountWei, timestampSeconds]
    )
  )
}
