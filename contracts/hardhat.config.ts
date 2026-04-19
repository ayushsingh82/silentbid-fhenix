import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@nomicfoundation/hardhat-ethers'
import 'cofhe-hardhat-plugin'
import * as dotenv from 'dotenv'

dotenv.config()

const accounts = [process.env.PRIVATE_KEY, process.env.UNWRAPPER_PRIVATE_KEY].filter(Boolean) as string[]

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.25',
    settings: {
      evmVersion: 'cancun',
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  // @ts-ignore — cofhe field is added by cofhe-hardhat-plugin
  cofhe: { logMocks: true },
  networks: {
    'base-sepolia': {
      url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      accounts,
      chainId: 84532,
      gasMultiplier: 1.2,
      timeout: 60000,
    },
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || '',
  },
}

export default config
