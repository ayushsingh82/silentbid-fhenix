/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { Encryptable } from "@cofhe/sdk"

const SCALE = 1_000_000n

async function deployAll() {
  const [deployer, seller, b1, b2] = await ethers.getSigners()

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy()
  await usdc.waitForDeployment()

  const cusdc = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(
    await usdc.getAddress(),
    deployer.address,
  )
  await cusdc.waitForDeployment()

  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(250)
  await treasury.waitForDeployment()

  const auction = await (await ethers.getContractFactory("SilentBidAuction")).deploy(
    await cusdc.getAddress(),
    await treasury.getAddress(),
  )
  await auction.waitForDeployment()

  return { deployer, seller, b1, b2, usdc, cusdc, treasury, auction }
}

async function wrapAndApprove(bidder: any, usdc: any, cusdc: any, auction: any, amount: bigint) {
  await (await usdc.mint(bidder.address, amount)).wait()
  await (await usdc.connect(bidder).approve(await cusdc.getAddress(), amount)).wait()
  await (await cusdc.connect(bidder).wrap(amount)).wait()
  const client = await hre.cofhe.createClientWithBatteries(bidder)
  const encrypted = await client.encryptInputs([Encryptable.uint64(amount)]).execute()
  await (await cusdc.connect(bidder).approve(await auction.getAddress(), encrypted[0])).wait()
}

async function endAndFinalize(auction: any, auctionId: bigint, caller: any) {
  await ethers.provider.send("evm_increaseTime", [61])
  await ethers.provider.send("evm_mine", [])
  await (await auction.endAuction(auctionId)).wait()

  const info = await auction.getAuction(auctionId)
  const client = await hre.cofhe.createClientWithBatteries(caller)
  const amountResult = await client.decryptForTx(info.highestBidHandle).withoutPermit().execute()
  const bidderResult = await client.decryptForTx(info.highestBidderHandle).withoutPermit().execute()
  const winnerRaw = bidderResult.decryptedValue as bigint
  const winner = ethers.getAddress("0x" + winnerRaw.toString(16).padStart(40, "0"))
  const amount = amountResult.decryptedValue as bigint

  await (await auction.finalizeAuction(
    auctionId,
    winner,
    amount,
    bidderResult.signature,
    amountResult.signature,
  )).wait()
}

describe("SilentBidAuction V2 edge cases", function () {
  this.timeout(180_000)

  it("rejects seller bidding", async () => {
    const { seller, auction, usdc, cusdc } = await deployAll()
    await (await auction.connect(seller).createAuction("X", "desc", 100n, 120n, { value: ethers.parseEther("0.005") })).wait()
    await wrapAndApprove(seller, usdc, cusdc, auction, 50n * SCALE)
    await expect(auction.connect(seller).placeBid(0n, { value: await auction.minBidGasFee() }))
      .to.be.revertedWith("seller cannot bid")
  })

  it("rejects second bid from the same bidder in one auction", async () => {
    const { seller, b1, auction, usdc, cusdc } = await deployAll()
    await (await auction.connect(seller).createAuction("X", "desc", 100n, 120n, { value: ethers.parseEther("0.005") })).wait()
    await wrapAndApprove(b1, usdc, cusdc, auction, 100n * SCALE)
    const fee = await auction.minBidGasFee()
    await (await auction.connect(b1).placeBid(0n, { value: fee })).wait()
    await expect(auction.connect(b1).placeBid(0n, { value: fee })).to.be.revertedWith("bid already placed")
  })

  it("only bid owner can mark reveal", async () => {
    const { seller, b1, b2, auction, usdc, cusdc } = await deployAll()
    await (await auction.connect(seller).createAuction("X", "desc", 100n, 60n, { value: ethers.parseEther("0.005") })).wait()
    await wrapAndApprove(b1, usdc, cusdc, auction, 120n * SCALE)
    await (await auction.connect(b1).placeBid(0n, { value: await auction.minBidGasFee() })).wait()
    await ethers.provider.send("evm_increaseTime", [61])
    await ethers.provider.send("evm_mine", [])
    await (await auction.endAuction(0n)).wait()
    await expect(auction.connect(b2).revealMyBid(0n, 0n)).to.be.revertedWith("not your bid")
  })

  it("settles all bids on finalize and prevents second finalize", async () => {
    const { deployer, seller, b1, b2, auction, usdc, cusdc } = await deployAll()
    await (await auction.connect(seller).createAuction("X", "desc", 100n, 60n, { value: ethers.parseEther("0.005") })).wait()
    await wrapAndApprove(b1, usdc, cusdc, auction, 140n * SCALE)
    await wrapAndApprove(b2, usdc, cusdc, auction, 220n * SCALE)
    const fee = await auction.minBidGasFee()
    await (await auction.connect(b1).placeBid(0n, { value: fee })).wait()
    await (await auction.connect(b2).placeBid(0n, { value: fee })).wait()

    await endAndFinalize(auction, 0n, deployer)

    const after = await auction.getAuction(0n)
    expect(after.finalized).to.equal(true)
    await expect(endAndFinalize(auction, 0n, deployer)).to.be.reverted

    const [, , settled0] = await auction.getBid(0n, 0n)
    const [, , settled1] = await auction.getBid(0n, 1n)
    expect(settled0).to.equal(true)
    expect(settled1).to.equal(true)
  })
})
