import { describe, it, expect } from "vitest"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { keccak256, encodePacked } from "viem"
import {
  SILENTBID_DOMAIN,
  SILENTBID_BID_TYPES,
  buildBidTypedData,
  verifyBidSignature,
  computeBidCommitment,
} from "../cre-bid"

// Generate a real keypair for testing — no mocks
const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)

const TEST_AUCTION = "0x000000000000000000000000000000000000dEaD" as `0x${string}`
const TEST_MAX_PRICE = BigInt("79228162514264337593543950336") // ~1 ETH in Q96
const TEST_AMOUNT = BigInt("10000000000000000") // 0.01 ETH
const TEST_TIMESTAMP = BigInt(Math.floor(Date.now() / 1000))

describe("buildBidTypedData", () => {
  it("builds valid EIP-712 typed data", () => {
    const td = buildBidTypedData({
      sender: account.address,
      auctionId: TEST_AUCTION,
      maxPrice: TEST_MAX_PRICE,
      amount: TEST_AMOUNT,
      timestamp: TEST_TIMESTAMP,
    })

    expect(td.domain).toEqual(SILENTBID_DOMAIN)
    expect(td.types).toEqual(SILENTBID_BID_TYPES)
    expect(td.primaryType).toBe("Bid")
    expect(td.message.sender).toBe(account.address)
    expect(td.message.auctionId).toBe(TEST_AUCTION)
    expect(td.message.maxPrice).toBe(TEST_MAX_PRICE)
    expect(td.message.amount).toBe(TEST_AMOUNT)
    expect(td.message.flags).toBe(BigInt(0))
    expect(td.message.timestamp).toBe(TEST_TIMESTAMP)
  })

  it("defaults flags to 0 and timestamp to current time", () => {
    const td = buildBidTypedData({
      sender: account.address,
      auctionId: TEST_AUCTION,
      maxPrice: TEST_MAX_PRICE,
      amount: TEST_AMOUNT,
    })

    expect(td.message.flags).toBe(BigInt(0))
    expect(td.message.timestamp).toBeGreaterThan(BigInt(0))
  })
})

describe("EIP-712 signature round-trip", () => {
  it("signs and verifies a bid with a real keypair", async () => {
    const td = buildBidTypedData({
      sender: account.address,
      auctionId: TEST_AUCTION,
      maxPrice: TEST_MAX_PRICE,
      amount: TEST_AMOUNT,
      timestamp: TEST_TIMESTAMP,
    })

    // Sign with the real private key
    const signature = await account.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    })

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/)

    // Verify with the signer's address
    const isValid = await verifyBidSignature(td, signature, account.address)
    expect(isValid).toBe(true)
  })

  it("rejects signature from wrong signer", async () => {
    const td = buildBidTypedData({
      sender: account.address,
      auctionId: TEST_AUCTION,
      maxPrice: TEST_MAX_PRICE,
      amount: TEST_AMOUNT,
      timestamp: TEST_TIMESTAMP,
    })

    const signature = await account.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    })

    // Use a different address for verification — should fail
    const otherAccount = privateKeyToAccount(generatePrivateKey())
    const isValid = await verifyBidSignature(td, signature, otherAccount.address)
    expect(isValid).toBe(false)
  })
})

describe("computeBidCommitment", () => {
  it("produces a deterministic bytes32 hash", () => {
    const c1 = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP)
    const c2 = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP)
    expect(c1).toBe(c2)
    expect(c1).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it("changes when any parameter changes", () => {
    const base = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP)

    const diffPrice = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE + BigInt(1), TEST_AMOUNT, TEST_TIMESTAMP)
    expect(diffPrice).not.toBe(base)

    const diffAmount = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT + BigInt(1), TEST_TIMESTAMP)
    expect(diffAmount).not.toBe(base)

    const diffTime = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP + BigInt(1))
    expect(diffTime).not.toBe(base)
  })

  it("matches manual keccak256(encodePacked(...))", () => {
    const manual = keccak256(
      encodePacked(
        ["address", "address", "uint256", "uint256", "uint256"],
        [TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP]
      )
    )
    const fn = computeBidCommitment(TEST_AUCTION, account.address, TEST_MAX_PRICE, TEST_AMOUNT, TEST_TIMESTAMP)
    expect(fn).toBe(manual)
  })
})
