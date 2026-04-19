import { describe, it, expect } from "vitest"
import { createPublicClient, http, type Address } from "viem"
import { sepolia } from "viem/chains"
import {
  CCA_FACTORY,
  FACTORY_ABI,
  FACTORY_DEPLOY_BLOCK,
  AUCTION_ABI,
  SILENTBID_ABI,
  q96ToEth,
  ethToQ96,
  snapToTickBoundary,
  Q96,
} from "../auction-contracts"

// ── Pure function tests (no network needed) ─────────────────────────────

describe("q96ToEth", () => {
  it("returns '0' for zero input", () => {
    expect(q96ToEth(BigInt(0))).toBe("0")
  })

  it("converts 1 * Q96 to '1'", () => {
    expect(q96ToEth(Q96)).toBe("1")
  })

  it("converts 0.5 * Q96 to '0.5'", () => {
    const half = Q96 / BigInt(2)
    expect(q96ToEth(half)).toBe("0.5")
  })

  it("converts 0.001 * Q96 to approximately 0.001", () => {
    const price = (Q96 * BigInt(1)) / BigInt(1000)
    const result = q96ToEth(price)
    expect(parseFloat(result)).toBeCloseTo(0.001, 4)
  })

  it("round-trips ethToQ96 → q96ToEth for '0.0024'", () => {
    const q96 = ethToQ96("0.0024")
    const back = q96ToEth(q96)
    expect(parseFloat(back)).toBeCloseTo(0.0024, 5)
  })
})

describe("ethToQ96", () => {
  it("returns 0n for zero", () => {
    expect(ethToQ96("0")).toBe(BigInt(0))
  })

  it("returns 0n for negative", () => {
    expect(ethToQ96("-1")).toBe(BigInt(0))
  })

  it("returns 0n for non-numeric", () => {
    expect(ethToQ96("abc")).toBe(BigInt(0))
  })

  it("converts '1' to Q96", () => {
    expect(ethToQ96("1")).toBe(Q96)
  })

  it("converts '0.5' to Q96/2", () => {
    expect(ethToQ96("0.5")).toBe(Q96 / BigInt(2))
  })

  it("produces positive value for small prices", () => {
    const result = ethToQ96("0.0001")
    expect(result > BigInt(0)).toBe(true)
  })
})

describe("snapToTickBoundary", () => {
  it("returns price if already on tick boundary", () => {
    const ts = BigInt(100)
    const price = BigInt(300)
    expect(snapToTickBoundary(price, ts)).toBe(BigInt(300))
  })

  it("rounds up to next tick boundary", () => {
    const ts = BigInt(100)
    const price = BigInt(250)
    expect(snapToTickBoundary(price, ts)).toBe(BigInt(300))
  })

  it("returns price unchanged when tickSpacing is 0", () => {
    const price = BigInt(250)
    expect(snapToTickBoundary(price, BigInt(0))).toBe(BigInt(250))
  })

  it("rounds up by 1 tick for price just above boundary", () => {
    const ts = BigInt(1000)
    const price = BigInt(1001)
    expect(snapToTickBoundary(price, ts)).toBe(BigInt(2000))
  })
})

// ── Real on-chain tests against Sepolia deployed contracts ──────────────

const client = createPublicClient({
  chain: sepolia,
  transport: http("https://1rpc.io/sepolia"),
})

// Real deployed addresses from latest deployment
const DEPLOYED_AUCTION = "0x3045F74EBd5d72CEa21118347Dd42e44f89c0eC7" as Address
const DEPLOYED_TOKEN = "0x9D3B8A874b173DA351C026132319459C957D1528" as Address
const DEPLOYED_SILENTBID = "0xb4B81F8F93171Ab65a9f363c0524b2ED18af3F25" as Address
const DEPLOYER = "0xE2b39f4cfFA5B17434e47Ab5F54b984155e4b7aD" as Address

describe("CCA Factory on Sepolia", () => {
  it("factory address is a valid contract (has code)", async () => {
    const code = await client.getCode({ address: CCA_FACTORY })
    expect(code).toBeDefined()
    expect(code!.length).toBeGreaterThan(2)
  })

  it("can read AuctionCreated events from factory", async () => {
    const latestBlock = await client.getBlockNumber()
    const fromBlock = latestBlock - BigInt(5000) < FACTORY_DEPLOY_BLOCK
      ? FACTORY_DEPLOY_BLOCK
      : latestBlock - BigInt(5000)

    const logs = await client.getLogs({
      address: CCA_FACTORY,
      event: FACTORY_ABI[0],
      fromBlock,
      toBlock: latestBlock,
    })

    expect(Array.isArray(logs)).toBe(true)
    // Our deployed auction should appear in recent events
    const found = logs.some((l) => l.args.auction?.toLowerCase() === DEPLOYED_AUCTION.toLowerCase())
    expect(found).toBe(true)
  })
})

describe("Deployed CCA Auction on Sepolia", () => {
  it("auction contract has code", async () => {
    const code = await client.getCode({ address: DEPLOYED_AUCTION })
    expect(code!.length).toBeGreaterThan(2)
  })

  it("reads token address correctly", async () => {
    const token = await client.readContract({
      address: DEPLOYED_AUCTION,
      abi: AUCTION_ABI,
      functionName: "token",
    })
    expect((token as string).toLowerCase()).toBe(DEPLOYED_TOKEN.toLowerCase())
  })

  it("reads startBlock and endBlock", async () => {
    const [startBlock, endBlock] = await Promise.all([
      client.readContract({ address: DEPLOYED_AUCTION, abi: AUCTION_ABI, functionName: "startBlock" }),
      client.readContract({ address: DEPLOYED_AUCTION, abi: AUCTION_ABI, functionName: "endBlock" }),
    ])
    expect(startBlock).toBeGreaterThan(BigInt(0))
    expect(endBlock).toBeGreaterThan(startBlock as bigint)
  })

  it("reads clearing price and floor price", async () => {
    const [clearingPrice, floorPrice] = await Promise.all([
      client.readContract({ address: DEPLOYED_AUCTION, abi: AUCTION_ABI, functionName: "clearingPrice" }),
      client.readContract({ address: DEPLOYED_AUCTION, abi: AUCTION_ABI, functionName: "floorPrice" }),
    ])
    // Floor price should be the configured value
    expect(floorPrice).toBeGreaterThan(BigInt(0))
    // Clearing price may be 0 if no bids or equal to floor
    expect(clearingPrice).toBeGreaterThanOrEqual(BigInt(0))
  })

  it("reads total supply (tokens funded)", async () => {
    const totalSupply = await client.readContract({
      address: DEPLOYED_AUCTION,
      abi: AUCTION_ABI,
      functionName: "totalSupply",
    })
    // 1 billion tokens = 1e27 wei
    expect(totalSupply).toBeGreaterThan(BigInt(0))
  })
})

describe("Deployed SilentBidCCA on Sepolia", () => {
  it("silentbid contract has code", async () => {
    const code = await client.getCode({ address: DEPLOYED_SILENTBID })
    expect(code!.length).toBeGreaterThan(2)
  })

  it("reads admin address", async () => {
    const admin = await client.readContract({
      address: DEPLOYED_SILENTBID,
      abi: SILENTBID_ABI,
      functionName: "admin",
    })
    expect((admin as string).toLowerCase()).toBe(DEPLOYER.toLowerCase())
  })

  it("reads linked CCA address", async () => {
    const cca = await client.readContract({
      address: DEPLOYED_SILENTBID,
      abi: SILENTBID_ABI,
      functionName: "cca",
    })
    expect((cca as string).toLowerCase()).toBe(DEPLOYED_AUCTION.toLowerCase())
  })

  it("reads silentBidDeadline", async () => {
    const deadline = await client.readContract({
      address: DEPLOYED_SILENTBID,
      abi: SILENTBID_ABI,
      functionName: "silentBidDeadline",
    })
    expect(deadline).toBeGreaterThan(BigInt(0))
  })

  it("reads nextSilentBidId (starts at 0)", async () => {
    const nextId = await client.readContract({
      address: DEPLOYED_SILENTBID,
      abi: SILENTBID_ABI,
      functionName: "nextSilentBidId",
    })
    expect(nextId).toBeGreaterThanOrEqual(BigInt(0))
  })
})
