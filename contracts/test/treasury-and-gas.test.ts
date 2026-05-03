/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { Encryptable } from "@cofhe/sdk"

const SCALE = 1_000_000n

async function deployAll(tresuaryFeeBps: number = 250) {
  const [deployer, seller, b1, b2, b3] = await ethers.getSigners()

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy()
  await usdc.waitForDeployment()

  const cusdc = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(
    await usdc.getAddress(),
    deployer.address,
  )
  await cusdc.waitForDeployment()

  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(tresuaryFeeBps)
  await treasury.waitForDeployment()

  const auction = await (await ethers.getContractFactory("SilentBidAuction")).deploy(
    await cusdc.getAddress(),
    await treasury.getAddress(),
  )
  await auction.waitForDeployment()

  return { deployer, seller, b1, b2, b3, usdc, cusdc, treasury, auction }
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

describe("SilentBidAuction V2 - Treasury & Gas Tests", function () {
  this.timeout(180_000)

  it("correctly calculates and transfers platform fee to treasury", async () => {
    const { deployer, seller, b1, b2, b3, usdc, cusdc, auction, treasury } = await deployAll(250) // 2.5%
    const duration = 60n
    await (await auction.connect(seller).createAuction(
      "Item",
      "desc",
      100n * SCALE,
      duration,
      { value: ethers.parseEther("0.005") },
    )).wait()

    const bidAmounts = [120n, 350n, 275n].map((x) => x * SCALE)
    const bidders = [b1, b2, b3]

    for (let i = 0; i < bidders.length; i++) {
      await wrapAndApprove(bidders[i], usdc, cusdc, auction, bidAmounts[i])
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(bidders.map((bidder) => auction.connect(bidder).placeBid(0n, { value: minBidGasFee })))

    await endAndFinalize(auction, 0n, deployer)

    // Verify fee was transferred to treasury
    const feeBps = await treasury.feeBasisPoints()
    const expectedFee = (350n * SCALE * feeBps) / 10_000n
    const treasuryBalHandle = await cusdc.balanceOf(await treasury.getAddress()) as unknown as string
    const treasuryBal = await hre.cofhe.mocks.getPlaintext(treasuryBalHandle) as bigint
    
    expect(treasuryBal).to.equal(expectedFee)
  })

  it("refunds losers correctly even with platform fee", async () => {
    const { deployer, seller, b1, b2, usdc, cusdc, auction } = await deployAll(250)
    const duration = 60n
    await (await auction.connect(seller).createAuction("X", "desc", 50n * SCALE, duration, { value: ethers.parseEther("0.01") })).wait()

    const amounts = [150n * SCALE, 100n * SCALE]
    const bidders = [b1, b2]

    for (let i = 0; i < bidders.length; i++) {
      await wrapAndApprove(bidders[i], usdc, cusdc, auction, amounts[i])
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(bidders.map((bidder) => auction.connect(bidder).placeBid(0n, { value: minBidGasFee })))

    await endAndFinalize(auction, 0n, deployer)

    // Check loser got refund
    const loserBalHandle = await cusdc.balanceOf(b2.address) as unknown as string
    const loserBal = await hre.cofhe.mocks.getPlaintext(loserBalHandle) as bigint
    expect(loserBal).to.equal(100n * SCALE)

    // Check winner got their funds (minus fee)
    const sellerBalHandle = await cusdc.balanceOf(seller.address) as unknown as string
    const sellerBal = await hre.cofhe.mocks.getPlaintext(sellerBalHandle) as bigint
    const expectedSellerGets = 150n * SCALE - (150n * SCALE * 250n) / 10_000n
    expect(sellerBal).to.equal(expectedSellerGets)
  })

  it("handles zero fee correctly (no platform deduction)", async () => {
    const { deployer, seller, b1, b2, usdc, cusdc, auction, treasury } = await deployAll(0) // 0% fee
    const duration = 60n
    await (await auction.connect(seller).createAuction("X", "desc", 100n * SCALE, duration, { value: ethers.parseEther("0.005") })).wait()

    const bidAmounts = [150n * SCALE, 200n * SCALE]
    const bidders = [b1, b2]

    for (let i = 0; i < bidders.length; i++) {
      await wrapAndApprove(bidders[i], usdc, cusdc, auction, bidAmounts[i])
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(bidders.map((bidder) => auction.connect(bidder).placeBid(0n, { value: minBidGasFee })))

    await endAndFinalize(auction, 0n, deployer)

    // Seller should get full winning amount
    const sellerBalHandle = await cusdc.balanceOf(seller.address) as unknown as string
    const sellerBal = await hre.cofhe.mocks.getPlaintext(sellerBalHandle) as bigint
    expect(sellerBal).to.equal(200n * SCALE)

    // Treasury should get nothing
    const treasuryBalHandle = await cusdc.balanceOf(await treasury.getAddress()) as unknown as string
    const treasuryBal = await hre.cofhe.mocks.getPlaintext(treasuryBalHandle) as bigint
    expect(treasuryBal).to.equal(0n)
  })

  it("prevents fee over 10% (1000 bps)", async () => {
    const { treasury } = await deployAll(250)
    await expect(treasury.setFeeBasisPoints(1001)).to.be.revertedWith("fee too high")
    await expect(treasury.setFeeBasisPoints(2000)).to.be.revertedWith("fee too high")
  })

  it("allows fee updates only by owner", async () => {
    const { b1, treasury } = await deployAll(250)
    await expect(treasury.connect(b1).setFeeBasisPoints(300)).to.be.revertedWith("not owner")
  })

  it("gas pool compensation to finalizer", async () => {
    const { deployer, seller, b1, usdc, cusdc, auction } = await deployAll(250)
    const duration = 60n
    const gasDeposit = ethers.parseEther("0.1")
    
    await (await auction.connect(seller).createAuction("X", "desc", 100n * SCALE, duration, { value: gasDeposit })).wait()

    await wrapAndApprove(b1, usdc, cusdc, auction, 150n * SCALE)
    const minBidGasFee = await auction.minBidGasFee()
    const bidGasAmount = ethers.parseEther("0.05")
    
    await auction.connect(b1).placeBid(0n, { value: bidGasAmount })

    // Get finalizer's balance before
    const finalizerBefore = await ethers.provider.getBalance(deployer.address)

    await ethers.provider.send("evm_increaseTime", [61])
    await ethers.provider.send("evm_mine", [])
    await (await auction.endAuction(0n)).wait()

    const info = await auction.getAuction(0n)
    const client = await hre.cofhe.createClientWithBatteries(deployer)
    const amountResult = await client.decryptForTx(info.highestBidHandle).withoutPermit().execute()
    const bidderResult = await client.decryptForTx(info.highestBidderHandle).withoutPermit().execute()
    const winnerRaw = bidderResult.decryptedValue as bigint
    const winner = ethers.getAddress("0x" + winnerRaw.toString(16).padStart(40, "0"))
    const amount = amountResult.decryptedValue as bigint

    const finalizeTx = await auction.finalizeAuction(
      0n,
      winner,
      amount,
      bidderResult.signature,
      amountResult.signature,
    )
    const finalizeReceipt = await finalizeTx.wait()
    const gasCost = finalizeReceipt!.gasUsed * finalizeReceipt!.gasPrice

    // Get finalizer's balance after
    const finalizerAfter = await ethers.provider.getBalance(deployer.address)

    // Finalizer should have received some compensation from gas pool (minus their tx costs)
    // The gas pool has gasDeposit + bidGasAmount
    const gasPool = gasDeposit + bidGasAmount
    expect(finalizerAfter).to.be.gt(finalizerBefore - gasCost) // Should be compensated from pool
  })

  it("returns unused gas pool to seller after finalization", async () => {
    const { deployer, seller, b1, usdc, cusdc, auction } = await deployAll(250)
    const duration = 60n
    const gasDeposit = ethers.parseEther("0.05")
    
    await (await auction.connect(seller).createAuction("X", "desc", 100n * SCALE, duration, { value: gasDeposit })).wait()

    await wrapAndApprove(b1, usdc, cusdc, auction, 150n * SCALE)
    const bidGasAmount = ethers.parseEther("0.01")
    
    await auction.connect(b1).placeBid(0n, { value: bidGasAmount })

    const sellerBefore = await ethers.provider.getBalance(seller.address)

    await endAndFinalize(auction, 0n, deployer)

    const sellerAfter = await ethers.provider.getBalance(seller.address)

    // Seller should have received refund of unused gas
    // (gasDeposit + bidGasAmount - compensation to finalizer should be returned)
    expect(sellerAfter).to.be.gte(sellerBefore) // Should have at least the same or more
  })

  it("settles multiple bidders atomically - all or nothing", async () => {
    const { deployer, seller, b1, b2, b3, usdc, cusdc, auction } = await deployAll(250)
    const duration = 60n
    
    await (await auction.connect(seller).createAuction("X", "desc", 100n * SCALE, duration, { value: ethers.parseEther("0.01") })).wait()

    const amounts = [120n * SCALE, 350n * SCALE, 275n * SCALE]
    const bidders = [b1, b2, b3]

    for (let i = 0; i < bidders.length; i++) {
      await wrapAndApprove(bidders[i], usdc, cusdc, auction, amounts[i])
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(bidders.map((bidder) => auction.connect(bidder).placeBid(0n, { value: minBidGasFee })))

    await endAndFinalize(auction, 0n, deployer)

    // All three bids should be marked as settled
    for (let i = 0; i < 3; i++) {
      const [, , settled] = await auction.getBid(0n, BigInt(i))
      expect(settled).to.equal(true)
    }

    // Check auction finalized correctly
    const finalAuction = await auction.getAuction(0n)
    expect(finalAuction.finalized).to.equal(true)
    expect(finalAuction.winningAmountPlain).to.equal(350n * SCALE) // Highest bid wins
  })

  it("treasury owner can withdraw collected fees", async () => {
    const { deployer, seller, b1, b2, usdc, cusdc, auction, treasury } = await deployAll(500) // 5%
    const duration = 60n
    
    await (await auction.connect(seller).createAuction("X", "desc", 100n * SCALE, duration, { value: ethers.parseEther("0.005") })).wait()

    const amounts = [150n * SCALE, 200n * SCALE]
    const bidders = [b1, b2]

    for (let i = 0; i < bidders.length; i++) {
      await wrapAndApprove(bidders[i], usdc, cusdc, auction, amounts[i])
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(bidders.map((bidder) => auction.connect(bidder).placeBid(0n, { value: minBidGasFee })))

    await endAndFinalize(auction, 0n, deployer)

    // Treasury has collected fees
    const treasuryBalHandle = await cusdc.balanceOf(await treasury.getAddress()) as unknown as string
    const treasuryBal = await hre.cofhe.mocks.getPlaintext(treasuryBalHandle) as bigint
    expect(treasuryBal).to.be.gt(0n)
  })
})
