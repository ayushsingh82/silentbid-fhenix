/**
 * End-to-end test against a live Base Sepolia deployment using @cofhe/sdk
 * directly (not the hardhat plugin) — so it works against the public RPC.
 * Drives: fund bidder → mint/wrap USDC → createAuction → encrypted approve →
 * placeBid → wait for deadline → ping Railway relayer → verify
 * AuctionFinalized event with winner + amount.
 */
import { ethers } from 'hardhat'
import { Wallet } from 'ethers'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node'
import { baseSepolia as cofheBase } from '@cofhe/sdk/chains'
import { Encryptable } from '@cofhe/sdk'
import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const SCALE = 1_000_000n
const USDC_ADDR = '0xA8269A6Dc3f9AE5936A930e5F8Fa9B17937feE94'
const CUSDC_ADDR = '0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d'
const AUCTION_ADDR = '0x2e396E1f8Bba845a6dAF481099452B360b8b26DE'

const RELAYER_URL = 'https://relayer-production-c6ed.up.railway.app'
const CRON_SECRET = process.env.CRON_SECRET || 'silentbid-cron-9f42a1c3e8d7b6f5'

async function pingRelayer(auctionId: bigint): Promise<unknown> {
  const res = await fetch(`${RELAYER_URL}/api/cron/finalize?auctionId=${auctionId}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  return res.json()
}

async function main() {
  const [seller] = await ethers.getSigners()
  const provider = seller.provider!
  console.log('seller =', await seller.getAddress())

  const bidder = Wallet.createRandom().connect(provider)
  console.log('bidder =', bidder.address)

  const usdc = await ethers.getContractAt('MockUSDC', USDC_ADDR)
  const cusdc = await ethers.getContractAt('ConfidentialUSDC', CUSDC_ADDR)
  const auction = await ethers.getContractAt('SilentBidAuction', AUCTION_ADDR)

  console.log('\n[1/8] fund bidder (0.02 ETH)')
  const fundTx = await seller.sendTransaction({ to: bidder.address, value: ethers.parseEther('0.02') })
  await fundTx.wait()
  console.log('  fund tx:', fundTx.hash)

  console.log('\n[2/8] bidder mint 200 USDC')
  const mintAmt = 200n * SCALE
  const mintTx = await usdc.connect(bidder).mint(bidder.address, mintAmt)
  await mintTx.wait()
  console.log('  mint tx:', mintTx.hash)

  console.log('\n[3/8] bidder approve + wrap 200 USDC')
  const approveUsdcTx = await usdc.connect(bidder).approve(CUSDC_ADDR, mintAmt)
  await approveUsdcTx.wait()
  const wrapTx = await cusdc.connect(bidder).wrap(mintAmt)
  await wrapTx.wait()
  console.log('  wrap tx:', wrapTx.hash)

  console.log('\n[4/8] seller createAuction (90s, 0.005 ETH gas deposit)')
  const createTx = await auction
    .connect(seller)
    .createAuction('e2e-test', 'auto-finalized via Railway relayer', 1n * SCALE, 90n, {
      value: ethers.parseEther('0.005'),
    })
  const createRcpt = await createTx.wait()
  const createdLog = createRcpt!.logs
    .map((l) => { try { return auction.interface.parseLog(l) } catch { return null } })
    .find((p) => p?.name === 'AuctionCreated')
  if (!createdLog) throw new Error('AuctionCreated not found')
  const auctionId = createdLog.args.auctionId as bigint
  console.log('  auctionId =', auctionId.toString())

  console.log('\n[5/8] bidder encrypt + approve cUSDC(auction, 125 USDC) via @cofhe/sdk/node')
  const bidderPk = bidder.privateKey as `0x${string}`
  const cofhePublic = createPublicClient({ chain: baseSepolia, transport: http() })
  const cofheWallet = createWalletClient({
    account: privateKeyToAccount(bidderPk),
    chain: baseSepolia,
    transport: http(),
  })
  const cofheConfig = createCofheConfig({ environment: 'node', supportedChains: [cofheBase] })
  const cofheClient = createCofheClient(cofheConfig)
  await cofheClient.connect(cofhePublic as never, cofheWallet as never)

  const bidAmtRaw = 125n * SCALE
  const encryptedResults = await cofheClient.encryptInputs([Encryptable.uint64(bidAmtRaw)]).execute()
  const e = encryptedResults[0]
  const encAmountForContract = {
    ctHash: ('0x' + e.ctHash.toString(16).padStart(64, '0')) as `0x${string}`,
    securityZone: e.securityZone,
    utype: e.utype,
    signature: e.signature as `0x${string}`,
  }
  const approveEncTx = await cusdc.connect(bidder).approve(AUCTION_ADDR, encAmountForContract)
  await approveEncTx.wait()
  console.log('  approve(enc) tx:', approveEncTx.hash)

  console.log('\n[6/8] bidder placeBid (0.0005 ETH gas fee)')
  const bidTx = await auction.connect(bidder).placeBid(auctionId, { value: ethers.parseEther('0.0005') })
  const bidRcpt = await bidTx.wait()
  console.log('  placeBid tx:', bidRcpt!.hash)
  const bidCount = await auction.bidCount(auctionId)
  console.log('  bidCount =', bidCount.toString())

  console.log('\n[7/8] wait for endTime, then ping relayer twice (endAuction → finalize)')
  const info = await auction.getAuction(auctionId)
  const endTime = Number(info.endTime)
  const block = await provider.getBlock('latest')
  const waitSec = Math.max(0, endTime - block!.timestamp + 10)
  console.log(`  sleeping ${waitSec}s (chainNow=${block!.timestamp}, endTime=${endTime})`)
  await new Promise((r) => setTimeout(r, waitSec * 1000))

  console.log('  ping #1 (expect endAuction):')
  console.log('   ', JSON.stringify(await pingRelayer(auctionId)))

  // CoFHE threshold network needs ~30-60s after allowPublic before decryptForTx works.
  console.log('  sleeping 60s for CoFHE oracle indexing…')
  await new Promise((r) => setTimeout(r, 60 * 1000))

  console.log('  ping #2 (expect finalizeAuction):')
  console.log('   ', JSON.stringify(await pingRelayer(auctionId)))

  console.log('\n[8/8] read finalized state from chain')
  const finalInfo = await auction.getAuction(auctionId)
  console.log('  finalized        =', finalInfo.finalized)
  console.log('  winnerPlain      =', finalInfo.winnerPlain)
  console.log('  winningAmount    =', finalInfo.winningAmountPlain.toString())

  if (!finalInfo.finalized) throw new Error('auction not finalized after both pings')
  if (finalInfo.winnerPlain.toLowerCase() !== bidder.address.toLowerCase()) {
    throw new Error(`wrong winner. expected ${bidder.address}, got ${finalInfo.winnerPlain}`)
  }
  if (finalInfo.winningAmountPlain !== bidAmtRaw) {
    throw new Error(`wrong amount. expected ${bidAmtRaw}, got ${finalInfo.winningAmountPlain}`)
  }
  console.log('\nE2E OK — bidder won as expected.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
