import { type Address } from "viem"

export const USDC_ADDRESS = "0xF1235b1782D48EbDf23673b115E51d03703463a1" as Address
export const CUSDC_ADDRESS = "0x651524Af19c2edeb94DE60ECd0B9B361B53AAAFF" as Address
export const AUCTION_ADDRESS = "0x3199d17cfa7027f91504F960DbCd34D44d284434" as Address
export const UNWRAPPER_ADDRESS = "0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7" as Address

export const USDC_DECIMALS = 6
export const SCALE = 1_000_000n // 10 ** 6

export function formatUsdc(raw: bigint | undefined | null, dp = 2): string {
  if (raw === undefined || raw === null) return "—"
  const whole = raw / SCALE
  const frac = raw % SCALE
  const fracStr = frac.toString().padStart(6, "0").slice(0, dp)
  return `${whole.toString()}.${fracStr}`
}

const InEncStruct = [
  { name: "ctHash", type: "uint256" },
  { name: "securityZone", type: "uint8" },
  { name: "utype", type: "uint8" },
  { name: "signature", type: "bytes" },
] as const

// ─── MockUSDC ───────────────────────────────────────────
export const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const

// ─── ConfidentialUSDC ───────────────────────────────────
export const CUSDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }], // euint64 handle
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint64" }],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "encAmount", type: "tuple", components: InEncStruct },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "requestUnwrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "encAmount", type: "tuple", components: InEncStruct }],
    outputs: [{ name: "unwrapId", type: "uint256" }],
  },
  {
    name: "claimUnwrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "unwrapId", type: "uint256" },
      { name: "plain", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "UnwrapRequested",
    inputs: [
      { name: "unwrapId", type: "uint256", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "encAmountHandle", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UnwrapClaimed",
    inputs: [
      { name: "unwrapId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const

// ─── SilentBidAuction ───────────────────────────────────
export const AUCTION_ABI = [
  {
    name: "nextAuctionId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "createAuction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "itemName", type: "string" },
      { name: "itemDescription", type: "string" },
      { name: "minBidPlain", type: "uint64" },
      { name: "durationSeconds", type: "uint64" },
    ],
    outputs: [{ name: "auctionId", type: "uint256" }],
  },
  {
    name: "placeBid",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "auctionId", type: "uint256" }],
    outputs: [{ name: "bidIndex", type: "uint256" }],
  },
  {
    name: "endAuction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "auctionId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "publishWinner",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "winner", type: "address" },
      { name: "amount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    name: "revealMyBid",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "bidIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "settleBid",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "bidIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "bidCount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "auctionId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getBid",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "bidIndex", type: "uint256" },
    ],
    outputs: [
      { name: "bidder", type: "address" },
      { name: "encAmountHandle", type: "uint256" },
      { name: "refunded", type: "bool" },
      { name: "revealed", type: "bool" },
    ],
  },
  {
    name: "getAuction",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "auctionId", type: "uint256" }],
    outputs: [
      {
        name: "v",
        type: "tuple",
        components: [
          { name: "seller", type: "address" },
          { name: "itemName", type: "string" },
          { name: "itemDescription", type: "string" },
          { name: "minBidPlain", type: "uint64" },
          { name: "endTime", type: "uint64" },
          { name: "ended", type: "bool" },
          { name: "decryptRequested", type: "bool" },
          { name: "highestBidHandle", type: "uint256" },
          { name: "highestBidderHandle", type: "uint256" },
          { name: "winnerPublished", type: "bool" },
          { name: "winnerPlain", type: "address" },
          { name: "winningAmountPlain", type: "uint64" },
          { name: "numBids", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "AuctionCreated",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "itemName", type: "string", indexed: false },
      { name: "minBidPlain", type: "uint64", indexed: false },
      { name: "endTime", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BidPlaced",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "bidIndex", type: "uint256", indexed: true },
      { name: "bidder", type: "address", indexed: true },
      { name: "encAmountHandle", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WinnerPublished",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BidRevealed",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "bidIndex", type: "uint256", indexed: true },
      { name: "bidder", type: "address", indexed: true },
      { name: "encAmountHandle", type: "uint256", indexed: false },
    ],
  },
] as const

export type AuctionData = {
  id: bigint
  seller: Address
  itemName: string
  itemDescription: string
  minBidPlain: bigint
  endTime: bigint
  ended: boolean
  decryptRequested: boolean
  highestBidHandle: bigint
  highestBidderHandle: bigint
  winnerPublished: boolean
  winnerPlain: Address
  winningAmountPlain: bigint
  numBids: bigint
}

export type AuctionStatus = "active" | "ended" | "settled"

export function auctionStatus(a: AuctionData): AuctionStatus {
  if (a.winnerPublished) return "settled"
  if (a.ended || BigInt(Math.floor(Date.now() / 1000)) >= a.endTime) return "ended"
  return "active"
}

export function decryptPending(a: AuctionData): boolean {
  return a.ended && !a.winnerPublished
}
