"use client"

import { useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { cn } from "@/lib/utils"
import { ensureCofheInit, getCofhejs } from "@/lib/cofhe"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  CUSDC_ABI,
  CUSDC_ADDRESS,
  SCALE,
} from "@/lib/fhenix-contracts"

type Step = "idle" | "init" | "encrypt" | "approve" | "bid" | "done" | "error"

const STEP_LABEL: Record<Step, string> = {
  idle: "Place sealed bid",
  init: "Initialising FHE session…",
  encrypt: "Encrypting bid…",
  approve: "Approving encrypted cUSDC…",
  bid: "Submitting sealed bid…",
  done: "Bid submitted",
  error: "Bid failed — retry",
}

export function PlaceBidForm({
  auctionId,
  onBidSuccess,
}: {
  auctionId: bigint
  onBidSuccess?: () => void
}) {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [amount, setAmount] = useState("")
  const [step, setStep] = useState<Step>("idle")
  const [error, setError] = useState<string | null>(null)

  const { data: cUsdcHandle, refetch: refetchCUsdc } = useReadContract({
    address: CUSDC_ADDRESS || undefined,
    abi: CUSDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CUSDC_ADDRESS, refetchInterval: 10_000 },
  })

  const amtNum = parseFloat(amount)
  const amtRaw =
    Number.isFinite(amtNum) && amtNum > 0
      ? BigInt(Math.floor(amtNum * Number(SCALE)))
      : 0n
  const hasSealedBalance =
    (cUsdcHandle as bigint | undefined) !== undefined && (cUsdcHandle as bigint) !== 0n

  const canSubmit =
    isConnected &&
    !!AUCTION_ADDRESS &&
    !!CUSDC_ADDRESS &&
    amtRaw > 0n &&
    hasSealedBalance &&
    (step === "idle" || step === "done" || step === "error")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !publicClient || !walletClient || !address) return
    setError(null)
    try {
      setStep("init")
      await ensureCofheInit(publicClient as never, walletClient)

      setStep("encrypt")
      const { cofhejs, Encryptable } = await getCofhejs()
      const enc = await cofhejs.encrypt([Encryptable.uint64(amtRaw)] as const)
      if (enc.error || !enc.data) throw new Error(`encrypt failed: ${JSON.stringify(enc.error)}`)
      const [encRaw] = enc.data
      const encAmount = { ...encRaw, signature: encRaw.signature as `0x${string}` }

      setStep("approve")
      const approveHash = await walletClient.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "approve",
        args: [AUCTION_ADDRESS, encAmount],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (approveReceipt.status !== "success") throw new Error("cUSDC approve reverted")

      setStep("bid")
      const bidHash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "placeBid",
        args: [auctionId],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const bidReceipt = await publicClient.waitForTransactionReceipt({ hash: bidHash })
      if (bidReceipt.status !== "success") throw new Error("placeBid reverted")

      setStep("done")
      refetchCUsdc()
      onBidSuccess?.()
      setTimeout(() => setStep("idle"), 2500)
      setAmount("")
    } catch (err) {
      setStep("error")
      setError(err instanceof Error ? err.message.slice(0, 200) : "Unknown error")
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-6 max-w-lg">
      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Bid amount (USDC)
        </label>
        <div className="flex items-baseline gap-2 border border-border/40 px-4 py-3">
          <input
            type="text"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            className="flex-1 bg-transparent font-mono text-xl tabular-nums focus:outline-none"
            disabled={step !== "idle" && step !== "done" && step !== "error"}
          />
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            USDC
          </span>
        </div>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          Sealed cUSDC balance:{" "}
          <span className="text-accent">
            {hasSealedBalance ? "encrypted (wrap more if low)" : "0 — wrap USDC first"}
          </span>
        </p>
      </div>

      {!isConnected && (
        <div className="border border-border/40 p-4">
          <p className="font-mono text-xs text-muted-foreground">Connect a wallet to bid.</p>
        </div>
      )}

      {isConnected && !hasSealedBalance && (
        <div className="border border-yellow-500/50 bg-yellow-500/10 p-4">
          <p className="font-mono text-xs text-yellow-300">
            No sealed cUSDC. Mint test USDC and wrap it at{" "}
            <a href="/wallet" className="underline hover:text-yellow-200">/wallet</a> first.
          </p>
        </div>
      )}

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className={cn(
          "w-full py-4 font-mono text-xs uppercase tracking-[0.3em] border transition-all",
          canSubmit
            ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
            : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
        )}
      >
        {STEP_LABEL[step]}
      </button>
    </form>
  )
}
