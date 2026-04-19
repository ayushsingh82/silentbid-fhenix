/**
 * End-to-end smoke test on Base Sepolia. Uses the keystore wallet as seller,
 * spawns a throwaway wallet for the bidder (funded from the seller), and
 * drives the full flow against the live Fhenix threshold network:
 *
 *   mint → wrap → createAuction → encrypted approve → placeBid
 *   → endAuction (dispatches FHE.decrypt) → poll winnerDecryptReady
 *   → publishWinner → settleBid → revealMyBid → unseal.
 *
 * Run:
 *   PRIVATE_KEY=... npx hardhat run scripts/e2e-base-sepolia.ts --network base-sepolia
 */

import hre, { ethers } from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'
import type { AbstractProvider, AbstractSigner } from 'cofhejs/node'
import { Wallet } from 'ethers'

const SCALE = 1_000_000n

const USDC_ADDR = '0xF1235b1782D48EbDf23673b115E51d03703463a1'
const CUSDC_ADDR = '0x651524Af19c2edeb94DE60ECd0B9B361B53AAAFF'
const AUCTION_ADDR = '0x3199d17cfa7027f91504F960DbCd34D44d284434'

function signerAbstract(s: Wallet): { provider: AbstractProvider; signer: AbstractSigner } {
  const provider: AbstractProvider = {
    call: (args) => s.provider!.call(args),
    getChainId: async () => (await s.provider!.getNetwork()).chainId.toString(),
    send: async (method: string, params?: unknown[]) =>
      s.provider!.send(method, (params ?? []) as unknown[]),
  }
  const signer: AbstractSigner = {
    signTypedData: (domain, types, value) => s.signTypedData(domain, types, value),
    getAddress: () => s.getAddress(),
    provider,
    sendTransaction: async (tx) => {
      const sent = await s.sendTransaction(tx as unknown as never)
      return sent.hash
    },
  }
  return { provider, signer }
}

async function initCofheFor(wallet: Wallet) {
  const { provider, signer } = signerAbstract(wallet)
  const res = await cofhejs.initialize({
    provider,
    signer,
    environment: 'TESTNET',
  })
  if (res.error) throw new Error(`cofhejs init for ${await wallet.getAddress()}: ${JSON.stringify(res.error)}`)
}

async function unsealWithRetry(handle: bigint, fheType: unknown, attempts = 30, delayMs = 4000): Promise<bigint> {
  for (let i = 0; i < attempts; i++) {
    const res = (await cofhejs.unseal(handle, fheType as never)) as { data?: bigint | null }
    if (res.data !== undefined && res.data !== null) return res.data as bigint
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error('cofhejs.unseal still pending')
}

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
  console.log('\n[4/9] seller createAuction (60s)')
  const duration = 60n
  const createTx = await auction.connect(deployer).createAuction(
    'Smoke Test Lot',
    'Base Sepolia e2e smoke run',
    10n * SCALE,
    duration,
  )
  const createRcpt = await createTx.wait()
  console.log('  create tx:', createRcpt!.hash)
  // Parse AuctionCreated from logs rather than relying on nextAuctionId, since
  // public RPCs can serve slightly stale state right after a tx lands.
  const createdLog = createRcpt!.logs
    .map((l) => { try { return auction.interface.parseLog(l) } catch { return null } })
    .find((p) => p?.name === 'AuctionCreated')
  if (!createdLog) throw new Error('AuctionCreated event not found in receipt')
  const auctionId = createdLog.args.auctionId as bigint
  console.log('  auctionId =', auctionId.toString())

  // 4. Bidder encrypts approval amount via cofhejs and calls approve.
  console.log('\n[5/9] bidder encrypt + approve cUSDC(auction, 125 USDC)')
  await initCofheFor(bidder)
  const bidAmtRaw = 125n * SCALE
  const enc = await cofhejs.encrypt([Encryptable.uint64(bidAmtRaw)] as const)
  if (enc.error || !enc.data) throw new Error(`encrypt: ${JSON.stringify(enc.error)}`)
  const [encAmount] = enc.data as unknown as Array<{
    ctHash: bigint
    securityZone: number
    utype: number
    signature: string
  }>
  const approveEncTx = await cusdc.connect(bidder).approve(AUCTION_ADDR, encAmount)
  await approveEncTx.wait()
  console.log('  approve tx:', approveEncTx.hash)

  // 5. Bidder placeBid.
  console.log('\n[6/9] bidder placeBid')
  const bidTx = await auction.connect(bidder).placeBid(auctionId)
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

  // 7. Unseal highest bid + bidder handles client-side via cofhejs. endAuction
  //    set FHE.allowGlobal on both, so the seller (or anyone) can unseal.
  console.log('\n[8/9] client-side unseal (cofhejs) of winning bid + bidder')
  const sellerWallet = new Wallet(process.env.PRIVATE_KEY!, provider)
  await initCofheFor(sellerWallet)
  const endInfo = await auction.getAuction(auctionId)
  const winnerAmount = await unsealWithRetry(BigInt(endInfo.highestBidHandle as bigint), FheTypes.Uint64)
  const winnerAddrRaw = await unsealWithRetry(BigInt(endInfo.highestBidderHandle as bigint), FheTypes.Uint256)
  const winnerAddr = ethers.getAddress('0x' + winnerAddrRaw.toString(16).padStart(40, '0'))
  console.log('  winnerAmount =', winnerAmount.toString(), ' winnerAddr =', winnerAddr)
  if (winnerAddr.toLowerCase() !== bidder.address.toLowerCase()) {
    throw new Error(`wrong winner — expected ${bidder.address}, got ${winnerAddr}`)
  }
  if (winnerAmount !== bidAmtRaw) {
    throw new Error(`wrong amount — expected ${bidAmtRaw}, got ${winnerAmount}`)
  }

  // 8. publishWinner(auctionId, winner, amount).
  console.log('\n[9/9] publishWinner + settleBid + revealMyBid + unseal')
  const pubTx = await auction.connect(deployer).publishWinner(auctionId, winnerAddr, winnerAmount)
  await pubTx.wait()
  console.log('  publishWinner tx:', pubTx.hash)

  const published = await auction.getAuction(auctionId)
  console.log('  winnerPlain =', published.winnerPlain)
  console.log('  winningAmountPlain =', published.winningAmountPlain.toString())

  // Settle the single bid (winner, so seller receives).
  const settleTx = await auction.connect(deployer).settleBid(auctionId, 0)
  await settleTx.wait()
  console.log('  settleBid tx:', settleTx.hash)

  // Reveal + unseal as the bidder.
  const revealTx = await auction.connect(bidder).revealMyBid(auctionId, 0)
  await revealTx.wait()
  console.log('  revealMyBid tx:', revealTx.hash)

  const [, bidHandle] = await auction.getBid(auctionId, 0)
  const unsealed = await unsealWithRetry(BigInt(bidHandle), FheTypes.Uint64)
  console.log('  unsealed own bid =', unsealed.toString())
  if (unsealed !== bidAmtRaw) throw new Error('unseal mismatch')

  // Reconcile balances.
  const sellerCUsdcHandle = (await cusdc.balanceOf(deployer.address)) as unknown as bigint
  console.log('  seller cUSDC handle =', sellerCUsdcHandle.toString())
  const sellerPlain = await unsealWithRetry(sellerCUsdcHandle, FheTypes.Uint64)
  console.log('  seller cUSDC plaintext =', sellerPlain.toString(), `(expected at least ${bidAmtRaw})`)

  console.log('\n✅ end-to-end on Base Sepolia passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
