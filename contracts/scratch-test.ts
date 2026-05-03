import { createWalletClient, http, createPublicClient, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { createCofheClient, createCofheConfig, Encryptable, FheTypes } from '@cofhe/sdk/node'
import * as chains from '@cofhe/sdk/chains'
import { config } from 'dotenv'

config()

async function run() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as any)
  console.log("Account:", account.address)
  
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() })
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() })

  const cofheConfig = createCofheConfig({ environment: "node", supportedChains: [chains.baseSepolia] })
  const client = await createCofheClient(cofheConfig)
  await client.connect(publicClient as any, walletClient as any)
  
  await client.permits.getOrCreateSelfPermit()
  console.log("Permit created")

  const amt = 125n * 1000000n
  const encrypted = await client.encryptInputs([Encryptable.uint64(amt)]).execute()
  console.log("Encrypted payload:", encrypted[0])
}

run().catch(console.error)
