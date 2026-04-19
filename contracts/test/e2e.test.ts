/**
 * End-to-end local test for SilentBid on Fhenix.
 * Run with: npx hardhat test test/e2e.test.ts
 *
 * The cofhe-hardhat-plugin auto-deploys FHE mocks on the hardhat network when
 * `hardhat test` is invoked, so encrypted ops resolve on-chain via the mock
 * task manager. Encrypted inputs are produced via cofhejs + the plugin's
 * impersonated mock signer so `FHE.asEuint64` signature checks pass.
 */

import { expect } from 'chai'
import hre, { ethers } from 'hardhat'
import { mock_getPlaintext, cofhejs_initializeWithHardhatSigner } from 'cofhe-hardhat-plugin'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'

describe('SilentBid on Fhenix (local)', function () {
  this.timeout(180_000)

  it('runs five concurrent bids, reveals winner, settles + reveals losers', async () => {
    const signers = await ethers.getSigners()
    const [deployer, seller, ...bidders] = signers
    const activeBidders = bidders.slice(0, 5)

    console.log('\n  deployer :', deployer.address)
    console.log('  seller   :', seller.address)
    activeBidders.forEach((b, i) => console.log(`  bidder[${i}]:`, b.address))

    // 1. Deploy
    console.log('\n  [1/6] deploying contracts')
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy()
    await usdc.waitForDeployment()
    const cusdc = await (await ethers.getContractFactory('ConfidentialUSDC'))
      .deploy(await usdc.getAddress(), deployer.address)
    await cusdc.waitForDeployment()
    const auction = await (await ethers.getContractFactory('SilentBidAuction'))
      .deploy(await cusdc.getAddress())
    await auction.waitForDeployment()
    console.log('    MockUSDC         :', await usdc.getAddress())
    console.log('    ConfidentialUSDC :', await cusdc.getAddress())
    console.log('    SilentBidAuction :', await auction.getAddress())

    // 2. Create auction
    console.log('\n  [2/6] seller createAuction')
    const duration = 60n
    await (await auction.connect(seller).createAuction(
      'Vintage Lot #42',
      'A rare vintage lot with mystery provenance',
      100_000_000n,
      duration,
    )).wait()
    const auctionId = 0n

    // 3. Bidders mint + wrap
    console.log('\n  [3/6] bidders mint + wrap USDC → cUSDC')
    const bidAmounts = [120n, 350n, 275n, 500n, 180n]
    const SCALE = 1_000_000n

    for (const [i, bidder] of activeBidders.entries()) {
      const amt = bidAmounts[i] * SCALE
      await (await usdc.mint(bidder.address, 1000n * SCALE)).wait()
      await (await usdc.connect(bidder).approve(await cusdc.getAddress(), amt)).wait()
      await (await cusdc.connect(bidder).wrap(amt)).wait()
    }

    // 4. Encrypted cUSDC approvals → auction. We init cofhejs per-bidder so
    // the mock signer binds each encrypted input to the correct sender
    // (`FHE.asEuint64` validates the signature against msg.sender).
    console.log('\n  [4/6] encrypted cUSDC.approve(auction, encBid) for each bidder')
    for (const [i, bidder] of activeBidders.entries()) {
      await cofhejs_initializeWithHardhatSigner(hre, bidder)
      const amtRaw = bidAmounts[i] * SCALE
      const enc = await cofhejs.encrypt([Encryptable.uint64(amtRaw)] as const)
      if (enc.error || !enc.data) throw new Error(`encrypt failed: ${JSON.stringify(enc.error)}`)
      const [encAmount] = enc.data
      await (await cusdc.connect(bidder).approve(await auction.getAddress(), encAmount)).wait()
    }

    // 5. Concurrent placeBid
    console.log('\n  [5/6] concurrent placeBid()')
    const bidTxs = await Promise.all(
      activeBidders.map((bidder) => auction.connect(bidder).placeBid(auctionId)),
    )
    await Promise.all(bidTxs.map((tx) => tx.wait()))
    const bidCount = await auction.bidCount(auctionId)
    expect(bidCount).to.equal(5n)
    console.log('    bidCount =', bidCount.toString())

    // 6. Fast-forward + endAuction + unseal winner via mock plaintext.
    console.log('\n  [6/6] fast-forward + endAuction + unseal winner')
    await ethers.provider.send('evm_increaseTime', [Number(duration) + 1])
    await ethers.provider.send('evm_mine', [])
    await (await auction.endAuction(auctionId)).wait()

    const info = await auction.getAuction(auctionId)
    const highestBidHandle = info.highestBidHandle as bigint
    const highestBidderHandle = info.highestBidderHandle as bigint
    const winnerAmount = (await mock_getPlaintext(ethers.provider as any, highestBidHandle)) as bigint
    const winnerAddressRaw = (await mock_getPlaintext(ethers.provider as any, highestBidderHandle)) as bigint
    const winnerAddress = ethers.getAddress('0x' + winnerAddressRaw.toString(16).padStart(40, '0'))
    console.log('    unsealed winner  :', winnerAddress, '  amount =', winnerAmount.toString())

    const expectedIdx = bidAmounts.indexOf(bidAmounts.reduce((a, b) => (a > b ? a : b)))
    const expectedAmount = bidAmounts[expectedIdx] * SCALE
    expect(winnerAddress.toLowerCase()).to.equal(activeBidders[expectedIdx].address.toLowerCase())
    expect(winnerAmount).to.equal(expectedAmount)

    await (await auction.publishWinner(auctionId, winnerAddress, winnerAmount)).wait()
    for (let i = 0n; i < bidCount; i++) {
      await (await auction.settleBid(auctionId, i)).wait()
    }

    // Concurrent placeBid lands in nondeterministic order; look up each
    // bidder's own bid index before revealing.
    async function bidIndexFor(addr: string): Promise<bigint> {
      const total = Number(await auction.bidCount(auctionId))
      for (let i = 0; i < total; i++) {
        const [bidder] = await auction.getBid(auctionId, i)
        if ((bidder as string).toLowerCase() === addr.toLowerCase()) return BigInt(i)
      }
      throw new Error(`no bid from ${addr}`)
    }

    console.log('\n  [reveal] bidders 0 and 2 opt to reveal their bids')
    for (const bidderIdx of [0, 2]) {
      const bidder = activeBidders[bidderIdx]
      const onchainIdx = await bidIndexFor(bidder.address)
      await (await auction.connect(bidder).revealMyBid(auctionId, onchainIdx)).wait()
      const [, handle] = await auction.getBid(auctionId, onchainIdx)
      const plain = (await mock_getPlaintext(ethers.provider as any, handle as bigint)) as bigint
      console.log(`    bidder[${bidderIdx}] bid[${onchainIdx}] = ${plain.toString()}`)
      expect(plain).to.equal(bidAmounts[bidderIdx] * SCALE)
    }

    console.log('\n  [post-settle] cUSDC plaintext balances:')
    const sellerBalHandle = (await cusdc.balanceOf(seller.address)) as unknown as bigint
    const sellerPlain = (await mock_getPlaintext(ethers.provider as any, sellerBalHandle)) as bigint
    console.log('    seller          :', sellerPlain.toString(), `(expected ${expectedAmount})`)
    expect(sellerPlain).to.equal(expectedAmount)

    for (let i = 0; i < activeBidders.length; i++) {
      const handle = (await cusdc.balanceOf(activeBidders[i].address)) as unknown as bigint
      const plain = (await mock_getPlaintext(ethers.provider as any, handle)) as bigint
      const isWinner = activeBidders[i].address.toLowerCase() === winnerAddress.toLowerCase()
      console.log(
        `    bidder[${i}] ${isWinner ? '(WIN) ' : '(LOSE)'}: ${plain.toString()} cUSDC`,
      )
      if (isWinner) {
        // Winner wrapped 500 USDC, then all 500 went to auction → seller.
        // Residual balance = 0.
        expect(plain).to.equal(0n)
      } else {
        expect(plain).to.equal(bidAmounts[i] * SCALE)
      }
    }

    console.log('\n  ✅ end-to-end passed')
  })
})
