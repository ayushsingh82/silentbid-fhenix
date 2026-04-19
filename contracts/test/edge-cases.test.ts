/**
 * Edge-case tests: negative paths + isolated unit flows that the happy-path
 * e2e doesn't cover. Run with: npx hardhat test test/edge-cases.test.ts
 */

import { expect } from 'chai'
import hre, { ethers } from 'hardhat'
import { mock_getPlaintext, cofhejs_initializeWithHardhatSigner } from 'cofhe-hardhat-plugin'
import { cofhejs, Encryptable } from 'cofhejs/node'

const SCALE = 1_000_000n

async function deployAll() {
  const [deployer, seller, b1, b2] = await ethers.getSigners()
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy()
  await usdc.waitForDeployment()
  const cusdc = await (await ethers.getContractFactory('ConfidentialUSDC'))
    .deploy(await usdc.getAddress(), deployer.address)
  await cusdc.waitForDeployment()
  const auction = await (await ethers.getContractFactory('SilentBidAuction'))
    .deploy(await cusdc.getAddress())
  await auction.waitForDeployment()
  return { deployer, seller, b1, b2, usdc, cusdc, auction }
}

async function wrapAndApprove(
  bidder: any,
  cusdc: any,
  auction: any,
  usdc: any,
  amtUsdc: bigint,
) {
  await (await usdc.mint(bidder.address, amtUsdc)).wait()
  await (await usdc.connect(bidder).approve(await cusdc.getAddress(), amtUsdc)).wait()
  await (await cusdc.connect(bidder).wrap(amtUsdc)).wait()
  await cofhejs_initializeWithHardhatSigner(hre, bidder)
  const enc = await cofhejs.encrypt([Encryptable.uint64(amtUsdc)] as const)
  if (enc.error || !enc.data) throw new Error('encrypt failed')
  await (await cusdc.connect(bidder).approve(await auction.getAddress(), enc.data[0])).wait()
}

describe('SilentBid edge cases', function () {
  this.timeout(180_000)

  it('rejects placeBid from the seller', async () => {
    const { seller, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 120n)).wait()
    // Give the seller a wrapped+approved balance so we're testing the policy
    // check, not an unrelated revert.
    await wrapAndApprove(seller, cusdc, auction, usdc, 50n * SCALE)
    await expect(auction.connect(seller).placeBid(0n)).to.be.revertedWith('seller cannot bid')
  })

  it('rejects placeBid after the deadline', async () => {
    const { seller, b1, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await wrapAndApprove(b1, cusdc, auction, usdc, 50n * SCALE)
    await ethers.provider.send('evm_increaseTime', [61])
    await ethers.provider.send('evm_mine', [])
    await expect(auction.connect(b1).placeBid(0n)).to.be.revertedWith('auction ended')
  })

  it('rejects endAuction before the deadline', async () => {
    const { seller, auction } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await expect(auction.endAuction(0n)).to.be.revertedWith('not ended')
  })

  it('rejects publishWinner before endAuction is called', async () => {
    const { seller, auction } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await expect(auction.publishWinner(0n, seller.address, 1n)).to.be.revertedWith('not ended')
  })

  it('publishWinner accepts the off-chain unsealed winner + amount', async () => {
    const { seller, b1, b2, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await wrapAndApprove(b1, cusdc, auction, usdc, 40n * SCALE)
    await wrapAndApprove(b2, cusdc, auction, usdc, 75n * SCALE)
    await (await auction.connect(b1).placeBid(0n)).wait()
    await (await auction.connect(b2).placeBid(0n)).wait()

    await ethers.provider.send('evm_increaseTime', [61])
    await ethers.provider.send('evm_mine', [])
    await (await auction.endAuction(0n)).wait()

    const info = await auction.getAuction(0n)
    const amt = (await mock_getPlaintext(ethers.provider as any, info.highestBidHandle as bigint)) as bigint
    const addrRaw = (await mock_getPlaintext(ethers.provider as any, info.highestBidderHandle as bigint)) as bigint
    const winner = ethers.getAddress('0x' + addrRaw.toString(16).padStart(40, '0'))
    expect(amt).to.equal(75n * SCALE)
    expect(winner.toLowerCase()).to.equal(b2.address.toLowerCase())

    await (await auction.publishWinner(0n, winner, amt)).wait()
    const post = await auction.getAuction(0n)
    expect(post.winnerPublished).to.equal(true)
    expect(post.winnerPlain.toLowerCase()).to.equal(b2.address.toLowerCase())
    expect(post.winningAmountPlain).to.equal(75n * SCALE)

    await expect(auction.publishWinner(0n, winner, amt)).to.be.revertedWith('already published')
  })

  it('rejects second settleBid on the same entry', async () => {
    const { seller, b1, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await wrapAndApprove(b1, cusdc, auction, usdc, 50n * SCALE)
    await (await auction.connect(b1).placeBid(0n)).wait()

    await ethers.provider.send('evm_increaseTime', [61])
    await ethers.provider.send('evm_mine', [])
    await (await auction.endAuction(0n)).wait()

    const info = await auction.getAuction(0n)
    const winnerAmount = (await mock_getPlaintext(ethers.provider as any, info.highestBidHandle as bigint)) as bigint
    const winnerAddrRaw = (await mock_getPlaintext(ethers.provider as any, info.highestBidderHandle as bigint)) as bigint
    const winnerAddr = ethers.getAddress('0x' + winnerAddrRaw.toString(16).padStart(40, '0'))

    await (await auction.publishWinner(0n, winnerAddr, winnerAmount)).wait()
    await (await auction.settleBid(0n, 0n)).wait()
    await expect(auction.settleBid(0n, 0n)).to.be.revertedWith('already settled')
  })

  it('rejects revealMyBid from a different bidder', async () => {
    const { seller, b1, b2, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('X', 'desc', 100n, 60n)).wait()
    await wrapAndApprove(b1, cusdc, auction, usdc, 50n * SCALE)
    await (await auction.connect(b1).placeBid(0n)).wait()

    await ethers.provider.send('evm_increaseTime', [61])
    await ethers.provider.send('evm_mine', [])
    await (await auction.endAuction(0n)).wait()

    await expect(auction.connect(b2).revealMyBid(0n, 0n)).to.be.revertedWith('not your bid')
  })

  it('supports two independent auctions in the same contract', async () => {
    const { seller, b1, b2, auction, cusdc, usdc } = await deployAll()
    await (await auction.connect(seller).createAuction('A', 'first',  10n, 60n)).wait()
    await (await auction.connect(seller).createAuction('B', 'second', 20n, 60n)).wait()

    await wrapAndApprove(b1, cusdc, auction, usdc, 111n * SCALE)
    await (await auction.connect(b1).placeBid(0n)).wait()

    await wrapAndApprove(b2, cusdc, auction, usdc, 222n * SCALE)
    await (await auction.connect(b2).placeBid(1n)).wait()

    expect(await auction.bidCount(0n)).to.equal(1n)
    expect(await auction.bidCount(1n)).to.equal(1n)

    await ethers.provider.send('evm_increaseTime', [61])
    await ethers.provider.send('evm_mine', [])
    await (await auction.endAuction(0n)).wait()
    await (await auction.endAuction(1n)).wait()

    const a0 = await auction.getAuction(0n)
    const a1 = await auction.getAuction(1n)
    const amt0 = (await mock_getPlaintext(ethers.provider as any, a0.highestBidHandle as bigint)) as bigint
    const amt1 = (await mock_getPlaintext(ethers.provider as any, a1.highestBidHandle as bigint)) as bigint
    expect(amt0).to.equal(111n * SCALE)
    expect(amt1).to.equal(222n * SCALE)
  })

  it('wrap / unwrap round-trip restores the USDC balance', async () => {
    const { b1, usdc, cusdc } = await deployAll()
    await (await usdc.mint(b1.address, 300n * SCALE)).wait()
    await (await usdc.connect(b1).approve(await cusdc.getAddress(), 300n * SCALE)).wait()
    await (await cusdc.connect(b1).wrap(300n * SCALE)).wait()

    const wrappedHandle = await cusdc.balanceOf(b1.address)
    const wrappedPlain = (await mock_getPlaintext(ethers.provider as any, wrappedHandle as unknown as bigint)) as bigint
    expect(wrappedPlain).to.equal(300n * SCALE)

    await cofhejs_initializeWithHardhatSigner(hre, b1)
    const enc = await cofhejs.encrypt([Encryptable.uint64(120n * SCALE)] as const)
    if (enc.error || !enc.data) throw new Error('encrypt failed')

    const tx = await cusdc.connect(b1).requestUnwrap(enc.data[0])
    const receipt = await tx.wait()
    const unwrapReqLog = receipt!.logs
      .map((l: any) => { try { return cusdc.interface.parseLog(l) } catch { return null } })
      .find((p: any) => p?.name === 'UnwrapRequested')
    const unwrapId = unwrapReqLog!.args.unwrapId as bigint
    const debitHandle = unwrapReqLog!.args.encAmountHandle as bigint
    const debitPlain = (await mock_getPlaintext(ethers.provider as any, debitHandle)) as bigint
    expect(debitPlain).to.equal(120n * SCALE)

    await (await cusdc.connect(b1).claimUnwrap(unwrapId, debitPlain)).wait()

    const usdcBalAfter = await usdc.balanceOf(b1.address)
    // Started with 0, minted 300, wrapped 300 (→0), unwrapped 120 back → 120.
    expect(usdcBalAfter).to.equal(120n * SCALE)
  })
})
