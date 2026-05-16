/**
 * Redeploy ONLY SilentBidAuction, reusing existing cUSDC + Treasury.
 * Authorises the new auction in the existing Treasury (requires deployer
 * == Treasury owner).
 */
import { ethers } from 'hardhat'

const CUSDC_ADDR = '0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d'
const TREASURY_ADDR = '0x1D1494b3a858Ed8b37B362eA6895665FfC71D11B'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('deployer =', await deployer.getAddress())

  const Auction = await ethers.getContractFactory('SilentBidAuction')
  const auction = await Auction.deploy(CUSDC_ADDR, TREASURY_ADDR)
  await auction.waitForDeployment()
  const auctionAddr = await auction.getAddress()
  console.log('SilentBidAuction:', auctionAddr)

  const treasury = await ethers.getContractAt('Treasury', TREASURY_ADDR)
  const authTx = await treasury.authorizeContract(auctionAddr)
  await authTx.wait()
  console.log('Treasury authorised', auctionAddr)

  console.log('\nNEXT_PUBLIC_AUCTION_ADDRESS=' + auctionAddr)
  console.log('\nVerify with:\n  npx hardhat verify --network base-sepolia ' + auctionAddr + ' ' + CUSDC_ADDR + ' ' + TREASURY_ADDR)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
