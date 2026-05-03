import { type Address } from "viem"

export const USDC_ADDRESS = "0xA8269A6Dc3f9AE5936A930e5F8Fa9B17937feE94" as Address
export const CUSDC_ADDRESS = "0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d" as Address
export const AUCTION_ADDRESS = "0xbf6b4Dd1E1498f575ffC3722E4350F9C51abEa78" as Address
export const UNWRAPPER_ADDRESS = "0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7" as Address
export const TREASURY_ADDRESS = "0x1D1494b3a858Ed8b37B362eA6895665FfC71D11B" as Address

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
    outputs: [{ type: "bytes32" }], // euint64 handle (bytes32 in v0.1.3)
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
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
    outputs: [{ type: "bytes32" }],
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
      { name: "encAmountHandle", type: "bytes32", indexed: false },
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

// ─── Treasury ───────────────────────────────────────────
export const TREASURY_ABI = [
  {
    name: "feeBasisPoints",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "setFeeBasisPoints",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_bps", type: "uint16" }],
    outputs: [],
  },
  {
    name: "authorizeContract",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_contract", type: "address" }],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const

// ─── SilentBidAuction V2 ───────────────────────────────
export const AUCTION_ABI = [
  {
    name: "nextAuctionId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "minGasDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "minBidGasFee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "createAuction",
    type: "function",
    stateMutability: "payable",
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
    stateMutability: "payable",
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
    name: "finalizeAuction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "winner", type: "address" },
      { name: "amount", type: "uint64" },
      { name: "winnerSig", type: "bytes" },
      { name: "amountSig", type: "bytes" },
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
      { name: "encAmountHandle", type: "bytes32" },
      { name: "settled", type: "bool" },
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
          { name: "highestBidHandle", type: "bytes32" },
          { name: "highestBidderHandle", type: "bytes32" },
          { name: "finalized", type: "bool" },
          { name: "winnerPlain", type: "address" },
          { name: "winningAmountPlain", type: "uint64" },
          { name: "numBids", type: "uint256" },
          { name: "gasDeposit", type: "uint256" },
          { name: "bidGasPool", type: "uint256" },
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
      { name: "gasDeposit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BidPlaced",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "bidIndex", type: "uint256", indexed: true },
      { name: "bidder", type: "address", indexed: true },
      { name: "encAmountHandle", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AuctionFinalized",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
      { name: "fee", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BidRevealed",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "bidIndex", type: "uint256", indexed: true },
      { name: "bidder", type: "address", indexed: true },
      { name: "encAmountHandle", type: "bytes32", indexed: false },
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
  highestBidHandle: string  // bytes32 hex
  highestBidderHandle: string  // bytes32 hex
  finalized: boolean
  winnerPlain: Address
  winningAmountPlain: bigint
  numBids: bigint
  gasDeposit: bigint
  bidGasPool: bigint
}

export type AuctionStatus = "active" | "ended" | "settled"

export function auctionStatus(a: AuctionData): AuctionStatus {
  if (a.finalized) return "settled"
  if (a.ended || BigInt(Math.floor(Date.now() / 1000)) >= a.endTime) return "ended"
  return "active"
}

export function decryptPending(a: AuctionData): boolean {
  return a.ended && !a.finalized
}
