import { describe, it, expect } from "vitest"
import { createPublicClient, http, type Address } from "viem"
import { sepolia } from "viem/chains"

/**
 * Real Sepolia connectivity and contract verification tests.
 * No mocks — hits real Sepolia RPC and reads real deployed contracts.
 */

const client = createPublicClient({
  chain: sepolia,
  transport: http("https://1rpc.io/sepolia"),
})

// Real deployed addresses
const SILENTBID_FACTORY = "0xe4d9d1ab7F7d1AbB85b3EF7cDb4505c8D5a74fB5" as Address

describe("Sepolia connectivity", () => {
  it("can fetch the latest block number", async () => {
    const blockNumber = await client.getBlockNumber()
    expect(blockNumber).toBeGreaterThan(BigInt(0))
  })

  it("chain ID is 11155111 (Sepolia)", async () => {
    const chainId = await client.getChainId()
    expect(chainId).toBe(11155111)
  })

  it("can read a historical block", async () => {
    const block = await client.getBlock({ blockNumber: BigInt(1) })
    expect(block).toBeDefined()
    expect(block.number).toBe(BigInt(1))
  })
})

describe("SilentBidFactory on Sepolia", () => {
  it("factory contract has code", async () => {
    const code = await client.getCode({ address: SILENTBID_FACTORY })
    expect(code).toBeDefined()
    expect(code!.length).toBeGreaterThan(2)
  })
})

describe("ERC20 token on Sepolia", () => {
  const TOKEN = "0x9D3B8A874b173DA351C026132319459C957D1528" as Address

  it("token contract has code", async () => {
    const code = await client.getCode({ address: TOKEN })
    expect(code!.length).toBeGreaterThan(2)
  })

  it("can read token symbol", async () => {
    const symbol = await client.readContract({
      address: TOKEN,
      abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }],
      functionName: "symbol",
    })
    expect(typeof symbol).toBe("string")
    expect((symbol as string).length).toBeGreaterThan(0)
  })
})
