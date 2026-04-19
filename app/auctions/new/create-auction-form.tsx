"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, usePublicClient, useWalletClient } from "wagmi"
import { decodeEventLog } from "viem"
import { cn } from "@/lib/utils"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  SCALE,
} from "@/lib/fhenix-contracts"

const DURATION_PRESETS = [
  { label: "5 min", seconds: 5 * 60 },
  { label: "15 min", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "6 hours", seconds: 6 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
]

export function CreateAuctionForm() {
  const router = useRouter()
  const { isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [itemName, setItemName] = useState("")
  const [itemDescription, setItemDescription] = useState("")
  const [floor, setFloor] = useState("")
  const [durationSec, setDurationSec] = useState(DURATION_PRESETS[1].seconds)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const minBidRaw = (() => {
    const n = parseFloat(floor)
    if (!Number.isFinite(n) || n < 0) return 0n
    return BigInt(Math.floor(n * Number(SCALE)))
  })()

  const canSubmit =
    isConnected &&
    !!AUCTION_ADDRESS &&
    itemName.trim().length > 0 &&
    durationSec >= 60 &&
    !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !publicClient || !walletClient) return
    setError(null)
    setSubmitting(true)
    try {
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "createAuction",
        args: [itemName.trim(), itemDescription.trim(), minBidRaw, BigInt(durationSec)],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("createAuction reverted")
      const evt = receipt.logs
        .map((l) => {
          try {
            return decodeEventLog({ abi: AUCTION_ABI, data: l.data, topics: l.topics })
          } catch {
            return null
          }
        })
        .find((d) => d?.eventName === "AuctionCreated")
      const newId = (evt?.args as { auctionId?: bigint } | undefined)?.auctionId
      router.push(newId !== undefined ? `/auctions/${newId.toString()}` : "/auctions")
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "Create failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {!AUCTION_ADDRESS && (
        <div className="border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive">
            Auction contract not configured. Set <code>NEXT_PUBLIC_AUCTION_ADDRESS</code> in .env.local.
          </p>
        </div>
      )}

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Item name
        </label>
        <input
          type="text"
          required
          maxLength={80}
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          placeholder="Vintage Lot #42"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
        />
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Description
        </label>
        <textarea
          rows={3}
          maxLength={500}
          value={itemDescription}
          onChange={(e) => setItemDescription(e.target.value)}
          placeholder="What are bidders competing for?"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60 resize-none"
        />
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Floor (USDC, informational)
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={floor}
          onChange={(e) => setFloor(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          Shown on the auction page for bidders — not enforced on-chain (bids are encrypted).
        </p>
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Duration
        </label>
        <div className="flex flex-wrap gap-2">
          {DURATION_PRESETS.map((p) => (
            <button
              key={p.seconds}
              type="button"
              onClick={() => setDurationSec(p.seconds)}
              className={cn(
                "px-4 py-2.5 font-mono text-xs uppercase tracking-widest border transition-colors",
                durationSec === p.seconds
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border/40 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

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
        {!isConnected ? "Connect wallet" : submitting ? "Creating…" : "+ Create auction"}
      </button>
    </form>
  )
}
