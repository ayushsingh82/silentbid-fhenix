import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()
  const unwrapper = process.env.UNWRAPPER_ADDRESS ?? deployer.address
  console.log('Deployer:', deployer.address)
  console.log('Unwrapper:', unwrapper)

  // 1. Deploy MockUSDC
  const MockUSDC = await ethers.getContractFactory('MockUSDC')
  const usdc = await MockUSDC.deploy()
  await usdc.waitForDeployment()
  const usdcAddr = await usdc.getAddress()
  console.log('MockUSDC:', usdcAddr)

  // 2. Deploy ConfidentialUSDC
  const CUSDC = await ethers.getContractFactory('ConfidentialUSDC')
  const cusdc = await CUSDC.deploy(usdcAddr, unwrapper)
  await cusdc.waitForDeployment()
  const cusdcAddr = await cusdc.getAddress()
  console.log('ConfidentialUSDC:', cusdcAddr)

  // 3. Deploy Treasury (2.5% default fee)
  const Treasury = await ethers.getContractFactory('Treasury')
  const treasury = await Treasury.deploy(250) // 250 bps = 2.5%
  await treasury.waitForDeployment()
  const treasuryAddr = await treasury.getAddress()
  console.log('Treasury:', treasuryAddr)

  // 4. Deploy SilentBidAuction V2 (with cUSDC + treasury)
  const Auction = await ethers.getContractFactory('SilentBidAuction')
  const auction = await Auction.deploy(cusdcAddr, treasuryAddr)
  await auction.waitForDeployment()
  const auctionAddr = await auction.getAddress()
  console.log('SilentBidAuction:', auctionAddr)

  // 5. Authorize auction contract in treasury
  const authTx = await treasury.authorizeContract(auctionAddr)
  await authTx.wait()
  console.log('Treasury authorized auction contract')

  console.log('\nAdd to app .env.local:')
  console.log(`NEXT_PUBLIC_USDC_ADDRESS=${usdcAddr}`)
  console.log(`NEXT_PUBLIC_CUSDC_ADDRESS=${cusdcAddr}`)
  console.log(`NEXT_PUBLIC_AUCTION_ADDRESS=${auctionAddr}`)
  console.log(`NEXT_PUBLIC_UNWRAPPER_ADDRESS=${unwrapper}`)
  console.log(`NEXT_PUBLIC_TREASURY_ADDRESS=${treasuryAddr}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
