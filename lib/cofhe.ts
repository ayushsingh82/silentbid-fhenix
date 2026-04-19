"use client"

/**
 * cofhejs loader + viem→cofhejs adapter. The SDK ships a big WASM bundle and
 * its own FHE keys, so we load it lazily — pages that never touch FHE stay
 * lean. Ported from fhe-giftcards/packages/app/src/lib/cofhe.ts.
 */

import type { AbstractProvider, AbstractSigner } from "cofhejs/web"
import type { PublicClient, WalletClient } from "viem"

type CofhejsNs = typeof import("cofhejs/web")

let lazy: Promise<CofhejsNs> | null = null
function loadCofhejs(): Promise<CofhejsNs> {
  if (!lazy) lazy = import("cofhejs/web")
  return lazy
}

function wrap(
  publicClient: PublicClient,
  walletClient: WalletClient,
): { provider: AbstractProvider; signer: AbstractSigner } {
  const provider: AbstractProvider = {
    call: async ({ to, data }) => {
      const result = await publicClient.call({
        to: to as `0x${string}`,
        data: data as `0x${string}`,
      })
      return result.data ?? "0x"
    },
    getChainId: async () => String(await publicClient.getChainId()),
    send: async (method: string, params?: unknown[]) =>
      publicClient.request({
        method: method as never,
        params: params as never,
      }) as unknown as Promise<unknown>,
  }

  const signer: AbstractSigner = {
    signTypedData: async (domain, types, value) =>
      (walletClient as unknown as {
        signTypedData: (args: {
          account: unknown
          domain: unknown
          types: unknown
          primaryType: string
          message: unknown
        }) => Promise<`0x${string}`>
      }).signTypedData({
        account: walletClient.account!,
        domain,
        types,
        primaryType: Object.keys(types as Record<string, unknown>)[0] ?? "",
        message: value,
      }),
    getAddress: async () => walletClient.account!.address,
    provider,
    sendTransaction: async (tx) => {
      const loose = tx as Record<string, unknown>
      const hash = await walletClient.sendTransaction({
        account: walletClient.account!,
        to: loose.to as `0x${string}`,
        data: loose.data as `0x${string}` | undefined,
        value: loose.value ? BigInt(String(loose.value)) : undefined,
        chain: null,
      })
      return hash
    },
  }

  return { provider, signer }
}

let initializedFor: string | null = null

/** Initialise cofhejs for this wallet (no-op if already done for this address). */
export async function ensureCofheInit(
  publicClient: PublicClient,
  walletClient: WalletClient,
) {
  const address = walletClient.account?.address
  if (!address) throw new Error("wallet not connected")
  if (initializedFor === address) return

  const { cofhejs } = await loadCofhejs()
  const { provider, signer } = wrap(publicClient, walletClient)
  const result = await cofhejs.initialize({ provider, signer, environment: "TESTNET" })
  if (result.error) {
    const err = result.error as { code?: string; message?: string; cause?: unknown }
    const inner = err.cause instanceof Error ? ` — ${err.cause.message}` : ""
    console.error("[cofhejs init error]", err)
    throw new Error(`cofhejs init failed [${err.code ?? "?"}]: ${err.message ?? "unknown"}${inner}`)
  }
  initializedFor = address
}

export async function getCofhejs(): Promise<CofhejsNs> {
  return loadCofhejs()
}

/** Retry cofhejs.unseal up to 10× (2.5s each) to survive the async oracle delay. */
export async function unsealWithRetry(
  handle: bigint,
  fheType: unknown,
  attempts = 10,
  delayMs = 2500,
): Promise<bigint> {
  const { cofhejs } = await getCofhejs()
  for (let i = 0; i < attempts; i++) {
    const res = (await cofhejs.unseal(handle, fheType as never)) as {
      data?: bigint | null
    }
    if (res.data !== undefined && res.data !== null) return res.data as bigint
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error("Decryption still pending — try again in a moment")
}
