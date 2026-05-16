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

// Singleton client + last-connected clients so decryptForView can re-issue a
// permit (which needs publicClient + walletClient) without the caller having
// to re-supply them.
let client: Awaited<ReturnType<typeof createClient>> | null = null
let connectedFor: string | null = null
let lastPublicClient: PublicClient | null = null
let lastWalletClient: WalletClient | null = null

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

/** Initialise the CoFHE client for this wallet, and ensure the self-permit
 *  is fresh. The SDK's getOrCreateSelfPermit replays the cached permit
 *  without checking expiry, so we evict expired permits before asking for one
 *  — otherwise decryptForView re-uses a dead permit and the threshold
 *  network rejects it. Safe to call every render. */
export async function ensureCofheInit(
  publicClient: PublicClient,
  walletClient: WalletClient,
) {
  const address = walletClient.account?.address
  if (!address) throw new Error("wallet not connected")

  const c = await getClient()
  if (connectedFor !== address) {
    await c.connect(publicClient as never, walletClient as never)
    connectedFor = address
  }
  lastPublicClient = publicClient
  lastWalletClient = walletClient

  const chainId = await publicClient.getChainId()
  const active = c.permits.getActivePermit(chainId, address) as
    | { expiration: number }
    | undefined
  // The SDK's getOrCreateSelfPermit doesn't check expiry, so we do it here.
  // `expiration` is a unix timestamp in seconds (z.int() in the schema).
  if (active && active.expiration < Math.floor(Date.now() / 1000)) {
    await c.permits.removeActivePermit(chainId, address)
  }
  // Creates + signs (EIP-712) if none active; reuses if still valid.
  // No args — the client wrapper reads publicClient/walletClient/chainId
  // from its internal connect store. Passing positional args here would be
  // interpreted as (chainId?, account?, options?) and corrupt the issuer.
  await c.permits.getOrCreateSelfPermit()
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

/** Decrypt a ciphertext handle for off-chain viewing (no on-chain effect).
 *  If the active permit has expired, evicts it and signs a fresh one before
 *  retrying once — so the user is re-prompted to sign instead of seeing a
 *  cryptic "Permit is expired" error. */
export async function decryptForView(
  ctHash: bigint | string,
  fheType: number,
): Promise<bigint> {
  const c = await getClient()
  try {
    return (await c
      .decryptForView(ctHash, fheType)
      .withPermit()
      .execute()) as unknown as bigint
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/permit.*expired|expired.*permit/i.test(msg)) throw err
    if (!lastPublicClient || !lastWalletClient) throw err
    // Re-run init to evict the expired permit and prompt the user for a
    // fresh EIP-712 signature, then retry once.
    await ensureCofheInit(lastPublicClient, lastWalletClient)
    return (await c
      .decryptForView(ctHash, fheType)
      .withPermit()
      .execute()) as unknown as bigint
  }
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
