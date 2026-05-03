/**
 * End-to-end smoke test on Base Sepolia. Uses the keystore wallet as seller,
 * spawns a throwaway wallet for the bidder (funded from the seller), and
 * drives the full flow against the live Fhenix threshold network:
 *
 *   mint → wrap → createAuction → encrypted approve → placeBid
 *   → endAuction (sets FHE.allowPublic) → decryptForTx (signed oracle)
 *   → finalizeAuction(winner, amount, winnerSig, amountSig) → revealMyBid → unseal.
 *
 * Run:
 *   PRIVATE_KEY=... npx hardhat run scripts/e2e-base-sepolia.ts --network base-sepolia
 */

import hre, { ethers } from 'hardhat'
import { Encryptable, FheTypes } from '@cofhe/sdk'
import { Wallet } from 'ethers'

const SCALE = 1_000_000n

const USDC_ADDR = '0xA8269A6Dc3f9AE5936A930e5F8Fa9B17937feE94'
const CUSDC_ADDR = '0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d'
const AUCTION_ADDR = process.env.AUCTION_ADDR || '0xbf6b4Dd1E1498f575ffC3722E4350F9C51abEa78'
const TREASURY_ADDR = process.env.TREASURY_ADDR || '0x1D1494b3a858Ed8b37B362eA6895665FfC71D11B'

async function main() {
  const [deployer] = await ethers.getSigners()
  const provider = deployer.provider!

  console.log('seller =', await deployer.getAddress())
  const net = await provider.getNetwork()
  console.log('chain  =', net.name, Number(net.chainId))

  // Throwaway bidder wallet — funded from seller so it can mint / wrap / bid.
  const bidder = Wallet.createRandom().connect(provider)
  console.log('bidder =', bidder.address)

  const usdc = await ethers.getContractAt('MockUSDC', USDC_ADDR)
  const cusdc = await ethers.getContractAt('ConfidentialUSDC', CUSDC_ADDR)
  const auction = await ethers.getContractAt('SilentBidAuction', AUCTION_ADDR)

  // 1. Fund bidder with ETH for gas.
  console.log('\n[1/9] fund bidder (0.02 ETH)')
  const fundTx = await deployer.sendTransaction({ to: bidder.address, value: ethers.parseEther('0.02') })
  await fundTx.wait()
  console.log('  funded tx:', fundTx.hash)

  // 2. Bidder mints + wraps 200 USDC.
  console.log('\n[2/9] bidder mint 200 USDC')
  const mintAmt = 200n * SCALE
  const mintTx = await usdc.connect(bidder).mint(bidder.address, mintAmt)
  await mintTx.wait()
  console.log('  mint tx:', mintTx.hash)

  console.log('\n[3/9] bidder approve MockUSDC → cUSDC and wrap')
  const apTx = await usdc.connect(bidder).approve(CUSDC_ADDR, mintAmt)
  await apTx.wait()
  const wrapTx = await cusdc.connect(bidder).wrap(mintAmt)
  await wrapTx.wait()
  console.log('  wrap tx:', wrapTx.hash)

  // 3. Seller creates auction (60s min duration required by contract).
  console.log('\n[4/9] seller createAuction (60s) with 0.005 ETH gas deposit')
  const duration = 60n
  const createTx = await auction.connect(deployer).createAuction(
    'Smoke Test Lot',
    'Base Sepolia e2e smoke run',
    10n * SCALE,
    duration,
    { value: ethers.parseEther('0.005') }
  )
  const createRcpt = await createTx.wait()
  console.log('  create tx:', createRcpt!.hash)
  const createdLog = createRcpt!.logs
    .map((l) => { try { return auction.interface.parseLog(l) } catch { return null } })
    .find((p) => p?.name === 'AuctionCreated')
  if (!createdLog) throw new Error('AuctionCreated event not found in receipt')
  const auctionId = createdLog.args.auctionId as bigint
  console.log('  auctionId =', auctionId.toString())

  // 4. Bidder encrypts approval amount via @cofhe/sdk and calls approve.
  console.log('\n[5/9] bidder encrypt + approve cUSDC(auction, 125 USDC)')
  const client = await hre.cofhe.createClientWithBatteries(bidder as never)
  const bidAmtRaw = 125n * SCALE
  const encrypted = await client.encryptInputs([Encryptable.uint64(bidAmtRaw)]).execute()
  const encAmount = encrypted[0]
  // Convert ctHash from bigint to bytes32 hex for the contract ABI
  const encAmountForContract = {
    ctHash: "0x" + encAmount.ctHash.toString(16).padStart(64, "0") as `0x${string}`,
    securityZone: encAmount.securityZone,
    utype: encAmount.utype,
    signature: encAmount.signature as `0x${string}`,
  }
  const approveEncTx = await cusdc.connect(bidder).approve(AUCTION_ADDR, encAmountForContract)
  await approveEncTx.wait()
  console.log('  approve tx:', approveEncTx.hash)

  // 5. Bidder placeBid.
  console.log('\n[6/9] bidder placeBid with 0.0005 ETH gas fee')
  const bidTx = await auction.connect(bidder).placeBid(auctionId, { value: ethers.parseEther('0.0005') })
  const bidRcpt = await bidTx.wait()
  console.log('  placeBid tx:', bidRcpt!.hash)
  const bidCount = await auction.bidCount(auctionId)
  console.log('  bidCount =', bidCount.toString())

  // 6. Wait the deadline + endAuction.
  console.log('\n[7/9] wait for timer, then endAuction')
  const auctionInfo = await auction.getAuction(auctionId)
  const endTime = Number(auctionInfo.endTime)
  const latestBlock = await provider.getBlock('latest')
  const nowChain = latestBlock!.timestamp
  const waitSec = Math.max(0, endTime - nowChain + 5)
  console.log(`  sleeping ${waitSec}s (chain now=${nowChain}, endTime=${endTime})`)
  await new Promise((r) => setTimeout(r, waitSec * 1000))

  const endTx = await auction.connect(deployer).endAuction(auctionId)
  await endTx.wait()
  console.log('  endAuction tx:', endTx.hash)

  // 7. Decrypt handles via CoFHE oracle (decryptForTx returns signed plaintext).
  console.log('\n[8/9] decryptForTx of winning bid + bidder via CoFHE oracle')
  const endInfo = await auction.getAuction(auctionId)
  const highestBidHandle = endInfo.highestBidHandle as string
  const highestBidderHandle = endInfo.highestBidderHandle as string

  const bidResult = await client.decryptForTx(highestBidHandle).withoutPermit().execute()
  const bidderResult = await client.decryptForTx(highestBidderHandle).withoutPermit().execute()

  const winnerAmount = bidResult.decryptedValue as bigint
  const winnerAddrRaw = bidderResult.decryptedValue as bigint
  const winnerAddr = ethers.getAddress('0x' + winnerAddrRaw.toString(16).padStart(40, '0'))
  console.log('  winnerAmount =', winnerAmount.toString(), ' winnerAddr =', winnerAddr)
  if (winnerAddr.toLowerCase() !== bidder.address.toLowerCase()) {
    throw new Error(`wrong winner — expected ${bidder.address}, got ${winnerAddr}`)
  }
  if (winnerAmount !== bidAmtRaw) {
    throw new Error(`wrong amount — expected ${bidAmtRaw}, got ${winnerAmount}`)
  }

  // 8. finalizeAuction with oracle signatures.
  console.log('\n[9/9] finalizeAuction + revealMyBid + unseal')
  const pubTx = await auction.connect(deployer).finalizeAuction(
    auctionId,
    winnerAddr,
    winnerAmount,
    bidderResult.signature,
    bidResult.signature,
  )
  await pubTx.wait()
  console.log('  finalizeAuction tx:', pubTx.hash)

  const published = await auction.getAuction(auctionId)
  console.log('  winnerPlain =', published.winnerPlain)
  console.log('  winningAmountPlain =', published.winningAmountPlain.toString())

  // Reveal + unseal as the bidder.
  const revealTx = await auction.connect(bidder).revealMyBid(auctionId, 0)
  await revealTx.wait()
  console.log('  revealMyBid tx:', revealTx.hash)

  const [, bidHandle] = await auction.getBid(auctionId, 0)
  const unsealed = await client.decryptForView(bidHandle as string, FheTypes.Uint64).execute()
  console.log('  unsealed own bid =', (unsealed as bigint).toString())
  if ((unsealed as bigint) !== bidAmtRaw) throw new Error('unseal mismatch')

  // Reconcile balances.
  const sellerCUsdcHandle = await cusdc.balanceOf(deployer.address) as string
  console.log('  seller cUSDC handle =', sellerCUsdcHandle)
  const sellerPlain = await client.decryptForView(sellerCUsdcHandle, FheTypes.Uint64).execute()
  console.log('  seller cUSDC plaintext =', (sellerPlain as bigint).toString(), `(expected roughly ${bidAmtRaw} minus fee)`)

  console.log('\n✅ end-to-end on Base Sepolia passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
