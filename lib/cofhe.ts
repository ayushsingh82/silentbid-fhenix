"use client"

/**
 * @cofhe/sdk loader + client singleton. The SDK ships a big WASM bundle and
 * its own FHE keys, so we load it lazily — pages that never touch FHE stay lean.
 */

import type { PublicClient, WalletClient } from "viem"

// Lazy-loaded SDK modules
let sdkModule: typeof import("@cofhe/sdk/web") | null = null
let chainsModule: typeof import("@cofhe/sdk/chains") | null = null

async function loadSdk() {
  if (!sdkModule) {
    const [sdk, chains] = await Promise.all([
      import("@cofhe/sdk/web"),
      import("@cofhe/sdk/chains"),
    ])
    sdkModule = sdk
    chainsModule = chains
  }
  return { sdk: sdkModule!, chains: chainsModule! }
}

// Singleton client
let client: Awaited<ReturnType<typeof createClient>> | null = null
let connectedFor: string | null = null

async function createClient() {
  const { sdk, chains } = await loadSdk()
  const config = sdk.createCofheConfig({
    environment: "web",
    supportedChains: [chains.baseSepolia],
  })
  return sdk.createCofheClient(config)
}

async function getClient(): Promise<NonNullable<typeof client>> {
  if (!client) client = await createClient()
  return client
}

/** Initialise the CoFHE client for this wallet (no-op if already done). */
export async function ensureCofheInit(
  publicClient: PublicClient,
  walletClient: WalletClient,
) {
  const address = walletClient.account?.address
  if (!address) throw new Error("wallet not connected")
  if (connectedFor === address) return

  const c = await getClient()
  await c.connect(publicClient as never, walletClient as never)
  // Create (or reuse) a self-permit — required by decryptForView.
  // This prompts the user to sign an EIP-712 permit message the first time.
  await c.permits.getOrCreateSelfPermit()
  connectedFor = address
}

/** Encrypt values client-side. Returns encrypted input structs for contract calls. */
export async function encryptInputs(
  items: Array<ReturnType<typeof import("@cofhe/sdk")["Encryptable"]["uint64"]>>,
) {
  const c = await getClient()
  const results = await c.encryptInputs(items).execute()
  // SDK returns ctHash as bigint, which maps perfectly to the uint256 expected by CoFHE v0.1.3 contracts
  return results.map((r: { ctHash: bigint; securityZone: number; utype: number; signature: string }) => ({
    ctHash: r.ctHash,
    securityZone: r.securityZone,
    utype: r.utype,
    signature: r.signature as `0x${string}`,
  }))
}

/** Decrypt a ciphertext handle for off-chain viewing (no on-chain effect). */
export async function decryptForView(
  ctHash: bigint | string,
  fheType: number,
): Promise<bigint> {
  const c = await getClient()
  return c.decryptForView(ctHash, fheType).withPermit().execute() as unknown as Promise<bigint>
}

/** Decrypt a ciphertext handle for on-chain use (returns signature for publishDecryptResult). */
export async function decryptForTx(ctHash: bigint | string) {
  const c = await getClient()
  return c.decryptForTx(ctHash).withoutPermit().execute()
}

/** Re-export SDK types for convenience. */
export async function getEncryptable() {
  const mod = await import("@cofhe/sdk")
  return mod.Encryptable
}

export async function getFheTypes() {
  const mod = await import("@cofhe/sdk")
  return mod.FheTypes
}
