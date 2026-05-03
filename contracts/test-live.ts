import { createWalletClient, http, createPublicClient, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node'
import * as chains from '@cofhe/sdk/chains'
import { Encryptable } from '@cofhe/sdk'
import { config } from 'dotenv'

config()

const USDC_ADDR = '0x154DcD5daf8987E5cCdd09EAf01f9DA44C4891cB' as const
const CUSDC_ADDR = '0x89A0d80bA778c79a0158497D2bc78C1C13D583e9' as const

const USDC_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  }
] as const

const CUSDC_ABI = [
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint64" }],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "encAmount", type: "tuple", components: [
        { name: "ctHash", type: "uint256" },
        { name: "securityZone", type: "uint8" },
        { name: "utype", type: "uint8" },
        { name: "signature", type: "bytes" },
      ] },
    ],
    outputs: [{ type: "bytes32" }],
  }
] as const

async function run() {
  const rpc = "https://base-sepolia-rpc.publicnode.com"
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) })

  const sellerKey = process.env.PRIVATE_KEY as `0x${string}`
  const sellerAccount = privateKeyToAccount(sellerKey)
  console.log("Seller:", sellerAccount.address)
  
  const sellerWallet = createWalletClient({ account: sellerAccount, chain: baseSepolia, transport: http(rpc) })
  
  const bal = await publicClient.getBalance({ address: sellerAccount.address })
  console.log("Seller balance:", formatEther(bal), "ETH")
  if (bal < parseEther("0.001")) throw new Error("Insufficient funds for testing")

  console.log("Initializing CoFHE client...")
  const cofheConfig = createCofheConfig({ environment: "node", supportedChains: [chains.baseSepolia] })
  const client = await createCofheClient(cofheConfig)
  await client.connect(publicClient as any, sellerWallet as any)
  
  await client.permits.getOrCreateSelfPermit()
  console.log("Self permit acquired")

  const amt = 1000000n // 1 USDC

  console.log("Minting 1 USDC...")
  const mintHash = await sellerWallet.writeContract({
    address: USDC_ADDR,
    abi: USDC_ABI,
    functionName: "mint",
    args: [sellerAccount.address, amt],
  })
  await publicClient.waitForTransactionReceipt({ hash: mintHash })

  console.log("Approving MockUSDC for cUSDC...")
  const approveUsdcHash = await sellerWallet.writeContract({
    address: USDC_ADDR,
    abi: USDC_ABI,
    functionName: "approve",
    args: [CUSDC_ADDR, amt],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveUsdcHash })

  console.log("Wrapping 1 USDC to cUSDC...")
  const wrapHash = await sellerWallet.writeContract({
    address: CUSDC_ADDR,
    abi: CUSDC_ABI,
    functionName: "wrap",
    args: [amt],
  })
  await publicClient.waitForTransactionReceipt({ hash: wrapHash })
  console.log("Wrap tx confirmed!")

  console.log("Encrypting approve payload...")
  const encrypted = await client.encryptInputs([Encryptable.uint64(amt)]).execute()
  const encAmount = {
    ctHash: encrypted[0].ctHash,
    securityZone: encrypted[0].securityZone,
    utype: encrypted[0].utype,
    signature: encrypted[0].signature as `0x${string}`,
  }
  
  console.log("Approving 1 cUSDC to auction...")
  const approveHash = await sellerWallet.writeContract({
    address: CUSDC_ADDR,
    abi: CUSDC_ABI,
    functionName: "approve",
    args: ['0xa54949c4052B98a9d663cAdEaB2F596b4609f45a', encAmount],
  })
  console.log("Approve tx sent:", approveHash)
  await publicClient.waitForTransactionReceipt({ hash: approveHash })
  console.log("Approve tx confirmed! It works!")
}

run().catch(console.error)
