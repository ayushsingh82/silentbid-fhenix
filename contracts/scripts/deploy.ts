import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()
  const unwrapper = process.env.UNWRAPPER_ADDRESS ?? deployer.address
  console.log('Deployer:', deployer.address)
  console.log('Unwrapper:', unwrapper)

  const MockUSDC = await ethers.getContractFactory('MockUSDC')
  const usdc = await MockUSDC.deploy()
  await usdc.waitForDeployment()
  const usdcAddr = await usdc.getAddress()
  console.log('MockUSDC:', usdcAddr)

  const CUSDC = await ethers.getContractFactory('ConfidentialUSDC')
  const cusdc = await CUSDC.deploy(usdcAddr, unwrapper)
  await cusdc.waitForDeployment()
  const cusdcAddr = await cusdc.getAddress()
  console.log('ConfidentialUSDC:', cusdcAddr)

  const Auction = await ethers.getContractFactory('SilentBidAuction')
  const auction = await Auction.deploy(cusdcAddr)
  await auction.waitForDeployment()
  const auctionAddr = await auction.getAddress()
  console.log('SilentBidAuction:', auctionAddr)

  console.log('\nAdd to app .env.local:')
  console.log(`NEXT_PUBLIC_USDC_ADDRESS=${usdcAddr}`)
  console.log(`NEXT_PUBLIC_CUSDC_ADDRESS=${cusdcAddr}`)
  console.log(`NEXT_PUBLIC_AUCTION_ADDRESS=${auctionAddr}`)
  console.log(`NEXT_PUBLIC_UNWRAPPER_ADDRESS=${unwrapper}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
