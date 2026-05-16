export const AUCTION_ABI = [
  {
    name: "nextAuctionId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
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
] as const

export type AuctionData = {
  seller: `0x${string}`
  itemName: string
  itemDescription: string
  minBidPlain: bigint
  endTime: bigint
  ended: boolean
  decryptRequested: boolean
  highestBidHandle: `0x${string}`
  highestBidderHandle: `0x${string}`
  finalized: boolean
  winnerPlain: `0x${string}`
  winningAmountPlain: bigint
  numBids: bigint
  gasDeposit: bigint
  bidGasPool: bigint
}
