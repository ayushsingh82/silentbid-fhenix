import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { Encryptable } from "@cofhe/sdk"

const SCALE = 1_000_000n

describe("SilentBidAuction V2 (local e2e)", function () {
  this.timeout(180_000)

  it("finalizes once and settles everyone atomically", async () => {
    const [deployer, seller, b1, b2, b3] = await ethers.getSigners()

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy()
    await usdc.waitForDeployment()

    const cusdc = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(
      await usdc.getAddress(),
      deployer.address,
    )
    await cusdc.waitForDeployment()

    const treasury = await (await ethers.getContractFactory("Treasury")).deploy(250) // 2.5%
    await treasury.waitForDeployment()

    const auction = await (await ethers.getContractFactory("SilentBidAuction")).deploy(
      await cusdc.getAddress(),
      await treasury.getAddress(),
    )
    await auction.waitForDeployment()

    const duration = 60n
    await (await auction.connect(seller).createAuction(
      "Lot #42",
      "e2e lot",
      100n * SCALE,
      duration,
      { value: ethers.parseEther("0.005") },
    )).wait()

    const bidAmounts = [120n, 350n, 275n].map((x) => x * SCALE)
    const bidders = [b1, b2, b3]

    for (let i = 0; i < bidders.length; i++) {
      const bidder = bidders[i]
      const amt = bidAmounts[i]

      await (await usdc.mint(bidder.address, 1000n * SCALE)).wait()
      await (await usdc.connect(bidder).approve(await cusdc.getAddress(), amt)).wait()
      await (await cusdc.connect(bidder).wrap(amt)).wait()

      const client = await hre.cofhe.createClientWithBatteries(bidder)
      const encrypted = await client.encryptInputs([Encryptable.uint64(amt)]).execute()
      await (await cusdc.connect(bidder).approve(await auction.getAddress(), encrypted[0])).wait()
    }

    const minBidGasFee = await auction.minBidGasFee()
    await Promise.all(
      bidders.map((bidder) =>
        auction.connect(bidder).placeBid(0n, { value: minBidGasFee }),
      ),
    )
    expect(await auction.bidCount(0n)).to.equal(3n)

    await ethers.provider.send("evm_increaseTime", [Number(duration) + 1])
    await ethers.provider.send("evm_mine", [])
    await (await auction.endAuction(0n)).wait()

    const info = await auction.getAuction(0n)
    const highestBidHandle = info.highestBidHandle as string
    const highestBidderHandle = info.highestBidderHandle as string

    const oracleClient = await hre.cofhe.createClientWithBatteries(deployer)
    const amountResult = await oracleClient.decryptForTx(highestBidHandle).withoutPermit().execute()
    const bidderResult = await oracleClient.decryptForTx(highestBidderHandle).withoutPermit().execute()

    const winnerAmount = amountResult.decryptedValue as bigint
    const winnerRaw = bidderResult.decryptedValue as bigint
    const winner = ethers.getAddress("0x" + winnerRaw.toString(16).padStart(40, "0"))

    await (await auction.finalizeAuction(
      0n,
      winner,
      winnerAmount,
      bidderResult.signature,
      amountResult.signature,
    )).wait()

    const finalized = await auction.getAuction(0n)
    expect(finalized.finalized).to.equal(true)
    expect(finalized.winnerPlain.toLowerCase()).to.equal(winner.toLowerCase())
    expect(finalized.winningAmountPlain).to.equal(350n * SCALE)

    for (let i = 0n; i < 3n; i++) {
      const [, , settled] = await auction.getBid(0n, i)
      expect(settled).to.equal(true)
    }

    const sellerBalHandle = await cusdc.balanceOf(seller.address) as unknown as string
    const sellerBal = await hre.cofhe.mocks.getPlaintext(sellerBalHandle) as bigint
    const fee = (350n * SCALE * 250n) / 10_000n
    expect(sellerBal).to.equal(350n * SCALE - fee)

    const treasuryBalHandle = await cusdc.balanceOf(await treasury.getAddress()) as unknown as string
    const treasuryBal = await hre.cofhe.mocks.getPlaintext(treasuryBalHandle) as bigint
    expect(treasuryBal).to.equal(fee)
  })
})
