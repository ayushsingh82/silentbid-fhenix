import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()
  const auctionAddress = process.env.NEXT_PUBLIC_AUCTION_ADDRESS || process.argv[2]

  if (!auctionAddress) {
    throw new Error('Auction address not provided. Set NEXT_PUBLIC_AUCTION_ADDRESS env var or pass as argument')
  }

  console.log('Deployer:', deployer.address)
  console.log('Auction Address:', auctionAddress)

  // Deploy SilentBidAutomationKeeper
  const Keeper = await ethers.getContractFactory('SilentBidAutomationKeeper')
  const keeper = await Keeper.deploy(auctionAddress)
  await keeper.waitForDeployment()
  const keeperAddr = await keeper.getAddress()
  console.log('\nSilentBidAutomationKeeper:', keeperAddr)

  console.log('\n✅ Deployment complete!')
  console.log('\nAdd to .env.local:')
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddr}`)

  console.log('\n📋 Next steps:')
  console.log('1. Save keeper address to env: NEXT_PUBLIC_KEEPER_ADDRESS=' + keeperAddr)
  console.log('2. Go to https://automation.chain.link/ (Base Sepolia)')
  console.log('3. Create new "Custom Logic" automation with:')
  console.log('   - Target contract: ' + keeperAddr)
  console.log('   - checkUpkeep() selector: 0x6e04ff0d')
  console.log('   - performUpkeepEndAuction(uint256) if needed')
  console.log('   - performUpkeepFinalize(...) if needed')
  console.log('4. Fund with LINK for gas fees')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
