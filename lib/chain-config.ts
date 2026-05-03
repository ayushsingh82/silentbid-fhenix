import { baseSepolia, type Chain } from "viem/chains"
import { fallback, http } from "wagmi"

export const IS_LOCAL = false

const localChain: Chain = {
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
}

export const activeChain = IS_LOCAL ? localChain : baseSepolia

export const chainId = activeChain.id

export const activeTransport = IS_LOCAL
  ? http("http://127.0.0.1:8545")
  : fallback([
      http("https://base-sepolia-rpc.publicnode.com"),
      http("https://sepolia.base.org"),
    ])

export const blockExplorerUrl = IS_LOCAL ? null : "https://sepolia.basescan.org"

export const networkName = IS_LOCAL ? "Hardhat" : "Base Sepolia"
