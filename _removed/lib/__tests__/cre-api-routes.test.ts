import { describe, it, expect } from "vitest"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { buildBidTypedData, computeBidCommitment } from "../cre-bid"
import { ethToQ96 } from "../auction-contracts"

/**
 * Tests for the CRE API route handlers.
 *
 * These test the actual Next.js route handler functions directly (no HTTP server needed).
 * No mocks — uses real crypto, real EIP-712 signatures, real bid storage.
 */

// Import the route handlers directly
import { POST as bidPOST } from "../../app/api/cre/bid/route"
import { POST as finalizePOST } from "../../app/api/cre/finalize/route"
import { POST as settlePOST } from "../../app/api/cre/settle/route"

// Generate real keypairs for signing
const pk1 = generatePrivateKey()
const pk2 = generatePrivateKey()
const account1 = privateKeyToAccount(pk1)
const account2 = privateKeyToAccount(pk2)

const TEST_AUCTION = "0x000000000000000000000000000000000000bEEF" as `0x${string}`
const PRICE_Q96 = ethToQ96("0.005")
const AMOUNT = BigInt("50000000000000000") // 0.05 ETH
const TIMESTAMP = BigInt(Math.floor(Date.now() / 1000))

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/cre/bid", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/cre/bid", () => {
  it("rejects missing fields", async () => {
    const res = await bidPOST(makeRequest({}))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain("Missing required fields")
  })

  it("rejects invalid sender address", async () => {
    const res = await bidPOST(makeRequest({
      signature: "0x" + "ab".repeat(65),
      sender: "notanaddress",
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96.toString(),
      amount: AMOUNT.toString(),
      timestamp: TIMESTAMP.toString(),
    }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain("Invalid sender address")
  })

  it("rejects non-positive maxPrice", async () => {
    const res = await bidPOST(makeRequest({
      signature: "0x" + "ab".repeat(65),
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: "0",
      amount: AMOUNT.toString(),
      timestamp: TIMESTAMP.toString(),
    }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain("maxPrice must be positive")
  })

  it("accepts a valid EIP-712 signed bid", async () => {
    const td = buildBidTypedData({
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96,
      amount: AMOUNT,
      timestamp: TIMESTAMP,
    })

    const signature = await account1.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    })

    const res = await bidPOST(makeRequest({
      signature,
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96.toString(),
      amount: AMOUNT.toString(),
      flags: "0",
      timestamp: TIMESTAMP.toString(),
    }))

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.status).toBe("accepted")
    expect(data.commitment).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(data.sender).toBe(account1.address)
  })

  it("rejects duplicate bid commitment", async () => {
    // Submit the same bid again (same params → same commitment)
    const td = buildBidTypedData({
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96,
      amount: AMOUNT,
      timestamp: TIMESTAMP,
    })

    const signature = await account1.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    })

    const res = await bidPOST(makeRequest({
      signature,
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96.toString(),
      amount: AMOUNT.toString(),
      timestamp: TIMESTAMP.toString(),
    }))

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toContain("Duplicate bid")
  })

  it("rejects wrong signature (different signer)", async () => {
    const td = buildBidTypedData({
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96,
      amount: AMOUNT + BigInt(1), // different amount so commitment is new
      timestamp: TIMESTAMP,
    })

    // Sign with account2 but claim to be account1
    const wrongSig = await account2.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    })

    const res = await bidPOST(makeRequest({
      signature: wrongSig,
      sender: account1.address,
      auctionId: TEST_AUCTION,
      maxPrice: PRICE_Q96.toString(),
      amount: (AMOUNT + BigInt(1)).toString(),
      timestamp: TIMESTAMP.toString(),
    }))

    expect(res.status).toBe(401)
  })
})

describe("POST /api/cre/finalize", () => {
  const FINALIZE_AUCTION = "0x000000000000000000000000000000000000cafE" as `0x${string}`
  const HIGH_PRICE = ethToQ96("0.01")
  const LOW_PRICE = ethToQ96("0.005")

  it("rejects missing auctionId", async () => {
    const req = new Request("http://localhost:3000/api/cre/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const res = await finalizePOST(req)
    expect(res.status).toBe(400)
  })

  it("returns 404 for auction with no bids", async () => {
    const req = new Request("http://localhost:3000/api/cre/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auctionId: "0x0000000000000000000000000000000000000000" }),
    })
    const res = await finalizePOST(req)
    expect(res.status).toBe(404)
  })

  it("runs price discovery on submitted bids", async () => {
    // Submit 2 bids with different prices to the finalize auction
    const ts1 = BigInt(Math.floor(Date.now() / 1000))
    const ts2 = ts1 + BigInt(1)

    // Bid 1: high price
    const td1 = buildBidTypedData({
      sender: account1.address,
      auctionId: FINALIZE_AUCTION,
      maxPrice: HIGH_PRICE,
      amount: AMOUNT,
      timestamp: ts1,
    })
    const sig1 = await account1.signTypedData({
      domain: td1.domain, types: td1.types, primaryType: td1.primaryType, message: td1.message,
    })
    await bidPOST(makeRequest({
      signature: sig1,
      sender: account1.address,
      auctionId: FINALIZE_AUCTION,
      maxPrice: HIGH_PRICE.toString(),
      amount: AMOUNT.toString(),
      timestamp: ts1.toString(),
    }))

    // Bid 2: low price
    const td2 = buildBidTypedData({
      sender: account2.address,
      auctionId: FINALIZE_AUCTION,
      maxPrice: LOW_PRICE,
      amount: AMOUNT,
      timestamp: ts2,
    })
    const sig2 = await account2.signTypedData({
      domain: td2.domain, types: td2.types, primaryType: td2.primaryType, message: td2.message,
    })
    await bidPOST(makeRequest({
      signature: sig2,
      sender: account2.address,
      auctionId: FINALIZE_AUCTION,
      maxPrice: LOW_PRICE.toString(),
      amount: AMOUNT.toString(),
      timestamp: ts2.toString(),
    }))

    // Now finalize
    const req = new Request("http://localhost:3000/api/cre/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auctionId: FINALIZE_AUCTION }),
    })
    const res = await finalizePOST(req)
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.bidCount).toBe(2)
    expect(data.winningBids.length).toBe(2)
    expect(BigInt(data.clearingPrice)).toBe(LOW_PRICE)
    expect(data.calldataForForwardBids).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(data.finalizedAt).toBeDefined()
  })
})

describe("POST /api/cre/settle", () => {
  it("rejects missing auctionId", async () => {
    const req = new Request("http://localhost:3000/api/cre/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const res = await settlePOST(req)
    expect(res.status).toBe(400)
  })

  it("rejects empty allocations", async () => {
    const req = new Request("http://localhost:3000/api/cre/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auctionId: "0x1234", allocations: [] }),
    })
    const res = await settlePOST(req)
    expect(res.status).toBe(400)
  })

  it("generates settlement plan for winners and losers", async () => {
    const req = new Request("http://localhost:3000/api/cre/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auctionId: "0x000000000000000000000000000000000000dEaD",
        allocations: [
          {
            sender: account1.address,
            allocatedAmount: "100000000000000000",
            cost: "50000000000000000",
            originalAmount: "80000000000000000",
            isWinner: true,
          },
          {
            sender: account2.address,
            allocatedAmount: "0",
            cost: "0",
            originalAmount: "30000000000000000",
            isWinner: false,
          },
        ],
      }),
    })

    const res = await settlePOST(req)
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.auctionId).toBe("0x000000000000000000000000000000000000dEaD")
    expect(data.actionCount).toBeGreaterThanOrEqual(2) // at least 1 payout + 1 refund

    // Winner should get payout + possible excess refund
    const payouts = data.settlementPlan.filter((a: { type: string }) => a.type === "payout")
    const refunds = data.settlementPlan.filter((a: { type: string }) => a.type === "refund")

    expect(payouts.length).toBeGreaterThanOrEqual(1)
    expect(refunds.length).toBeGreaterThanOrEqual(1)

    // Winner's excess: 80000000000000000 - 50000000000000000 = 30000000000000000
    const winnerRefund = refunds.find((r: { recipient: string }) => r.recipient === account1.address)
    expect(winnerRefund).toBeDefined()
    expect(winnerRefund!.amount).toBe("30000000000000000")

    // Loser gets full refund
    const loserRefund = refunds.find((r: { recipient: string }) => r.recipient === account2.address)
    expect(loserRefund).toBeDefined()
    expect(loserRefund!.amount).toBe("30000000000000000")

    expect(data.settledAt).toBeDefined()
  })
})
