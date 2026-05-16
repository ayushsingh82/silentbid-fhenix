"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { type Address } from "viem"
import { cn } from "@/lib/utils"
import { ensureCofheInit, decryptForView, getFheTypes } from "@/lib/cofhe"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  TREASURY_ABI,
  TREASURY_ADDRESS,
  formatUsdc,
  type AuctionData,
} from "@/lib/fhenix-contracts"
import { chainId } from "@/lib/chain-config"

type BidRow = {
  index: number
  bidder: Address
  handle: string  // bytes32 hex
  settled: boolean
  revealed: boolean
  /** unsealed plain value once we've decrypted */
  plain?: bigint
}

export function RevealPanel({
  auction,
  onUpdate,
}: {
  auction: AuctionData
  onUpdate?: () => void
}) {
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()

  const [busyReveal, setBusyReveal] = useState<number | null>(null)
  const [bids, setBids] = useState<BidRow[]>([])
  const [loadingBids, setLoadingBids] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Read treasury fee
  const { data: feeBps } = useReadContract({
    address: TREASURY_ADDRESS || undefined,
    abi: TREASURY_ABI,
    functionName: "feeBasisPoints",
    query: { enabled: !!TREASURY_ADDRESS && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" },
  })

  const feePercent = feeBps ? (Number(feeBps) / 100).toFixed(1) : "2.5"

  const fetchBids = useCallback(async () => {
    if (!publicClient || !AUCTION_ADDRESS) return
    try {
      const n = Number(auction.numBids)
      if (n === 0) {
        setBids([])
        return
      }
      const contracts = Array.from({ length: n }, (_, i) => ({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "getBid" as const,
        args: [auction.id, BigInt(i)] as const,
      }))
      const results = await publicClient.multicall({ contracts })
      const rows: BidRow[] = results
        .map((r, i): BidRow | null => {
          if (r.status !== "success") return null
          const [bidder, handle, settled, revealed] = r.result as [
            Address, string, boolean, boolean,
          ]
          const existing = bids.find((b) => b.index === i)
          return {
            index: i,
            bidder,
            handle,
            settled,
            revealed,
            plain: existing?.plain,
          }
        })
        .filter((x): x is BidRow => x !== null)
      setBids(rows)
    } finally {
      setLoadingBids(false)
    }
  }, [publicClient, auction.id, auction.numBids]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchBids()
  }, [fetchBids])


  async function handleRevealMyBid(bidIndex: number) {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setBusyReveal(bidIndex)
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "revealMyBid",
        args: [auction.id, BigInt(bidIndex)],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("revealMyBid reverted")
      await fetchBids()
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "reveal failed")
    } finally {
      setBusyReveal(null)
    }
  }

  async function handleUnsealMyBid(bidIndex: number) {
    if (!publicClient || !walletClient) return
    setError(null)
    try {
      setBusyReveal(bidIndex)
      await ensureCofheInit(publicClient as never, walletClient)
      const FheTypes = await getFheTypes()
      const target = bids.find((b) => b.index === bidIndex)
      if (!target) throw new Error("bid not found")
      const plain = (await decryptForView(target.handle, FheTypes.Uint64)) as bigint
      setBids((curr) => curr.map((b) => (b.index === bidIndex ? { ...b, plain: plain as bigint } : b)))
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "unseal failed")
    } finally {
      setBusyReveal(null)
    }
  }

  const needsEnd = !auction.ended
  const needsFinalize = auction.ended && !auction.finalized
  const gasPool = (auction.gasDeposit ?? 0n) + (auction.bidGasPool ?? 0n)

  return (
    <div>
      <h2 className="font-[var(--font-bebas)] text-2xl md:text-3xl tracking-tight">Results</h2>
      <p className="mt-2 font-mono text-xs text-muted-foreground max-w-2xl">
        The auction deadline has passed. Automatic settlement is handling the winner disclosure,
        bid settlement, and {feePercent}% platform fee collection. Bid owners can unseal their own bids
        once finalized.
      </p>

      {error && (
        <div className="mt-4 border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      {auction.finalized ? (
        <div className="mt-6 border border-accent/40 bg-accent/5 p-4 font-mono text-xs">
          <p className="uppercase tracking-widest text-accent">✓ Settled</p>
          <p className="mt-2">Auction has been settled automatically.</p>
        </div>
      ) : (needsEnd || needsFinalize) ? (
        <SettlementProgress auction={auction} />
      ) : null}

      {auction.finalized && (
        <div className="mt-6 border border-accent/40 bg-accent/5 p-5 font-mono">
          <p className="text-[10px] uppercase tracking-[0.3em] text-accent">Winner</p>
          <p className="mt-2 text-lg text-foreground break-all">{auction.winnerPlain}</p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-accent">Winning bid</p>
          <p className="mt-2 text-2xl tabular-nums text-foreground">
            {formatUsdc(auction.winningAmountPlain, 2)} USDC
          </p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
            Platform fee: {feePercent}% → Treasury
          </p>
        </div>
      )}

      <div className="mt-10">
        <h3 className="font-[var(--font-bebas)] text-xl tracking-tight">Bid ledger</h3>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
          Your bids show as •••• (sealed). Click "Unseal" to view your bid amount. All bids settle when finalized.
        </p>
        {loadingBids ? (
          <div className="mt-4 space-y-2">
            <p className="font-mono text-xs text-muted-foreground/60">Loading sealed bids…</p>
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 bg-muted/20 animate-pulse border border-border/20 rounded" />
              ))}
            </div>
          </div>
        ) : bids.length === 0 ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground/60">No bids were placed.</p>
        ) : (
          <ul className="mt-4 space-y-2 font-mono text-[12px]">
            {bids.map((b) => {
              const isMyBid = myAddr && b.bidder.toLowerCase() === myAddr.toLowerCase()
              const isWinner = auction.finalized && b.bidder.toLowerCase() === auction.winnerPlain.toLowerCase()
              const showPlain = b.plain !== undefined
                ? `${formatUsdc(b.plain, 2)} USDC`
                : isWinner
                  ? `${formatUsdc(auction.winningAmountPlain, 2)} USDC`
                  : b.revealed
                    ? "revealed (unseal →)"
                    : isMyBid && auction.ended
                      ? "••••• USDC (tap unseal →)"
                      : "sealed"
              return (
                <li
                  key={b.index}
                  className="flex items-center gap-3 justify-between border-b border-border/20 pb-2 flex-wrap"
                >
                  <div className="min-w-0">
                    <span className="text-muted-foreground/80">
                      #{b.index} {b.bidder.slice(0, 6)}…{b.bidder.slice(-4)}
                    </span>
                    {isWinner && (
                      <span className="ml-2 text-accent uppercase tracking-widest text-[9px]">winner</span>
                    )}
                    {isMyBid && (
                      <span className="ml-2 text-purple-400 uppercase tracking-widest text-[9px]">you</span>
                    )}
                    {b.settled && (
                      <span className="ml-2 text-muted-foreground/60 uppercase tracking-widest text-[9px]">
                        {isWinner ? "paid to seller" : "refunded"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "tabular-nums",
                        showPlain.includes("USDC") ? "text-accent" : "text-purple-400",
                      )}
                    >
                      {showPlain}
                    </span>
                    {/* Only the bid owner can unseal their own sealed bid (even without revealing) */}
                    {isMyBid && b.plain === undefined && auction.ended && (
                      <button
                        onClick={() => handleUnsealMyBid(b.index)}
                        disabled={busyReveal === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-accent/40 text-accent hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                      >
                        {busyReveal === b.index ? "…" : "Unseal"}
                      </button>
                    )}
                    {/* Only the bid owner can reveal their own bid (optional for transparency) */}
                    {isMyBid && !b.revealed && auction.ended && b.plain === undefined && (
                      <button
                        onClick={() => handleRevealMyBid(b.index)}
                        disabled={busyReveal === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-muted-foreground/40 text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-50"
                        title="Optional: Mark bid as publicly revealed on-chain"
                      >
                        {busyReveal === b.index ? "…" : "Reveal"}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Reads the auction's chain state and renders a 3-step progress card.
 * Each step shows ✓ (done), ⟳ (in flight), or ○ (pending). The phase is
 * derived from `auction.ended` + `auction.finalized` + `auction.numBids`.
 *
 *   live  → endAuction in flight   → CoFHE decrypting   → finalize
 *           (relayer poll loop will             (~30-60s, MPC on
 *            fire at chainNow >= endTime)        threshold network)
 */
function SettlementProgress({ auction }: { auction: AuctionData }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const elapsedSinceEnd = Math.max(0, now - Number(auction.endTime))
  const noBids = auction.ended && auction.numBids === 0n

  // Phase derivation
  const step1Done = auction.ended
  const step2Done = auction.finalized || noBids
  const step3Done = auction.finalized

  // Rough remaining estimate for the active step
  // step 1 (endAuction): poll loop fires within ~5s of endTime + ~5s tx confirm
  // step 2 (oracle decrypt): ~30-45s of MPC + sig from CoFHE threshold network
  // step 3 (finalize tx): ~5s
  let estRemaining: number | null = null
  if (!step1Done) {
    estRemaining = Math.max(0, 10 - elapsedSinceEnd)
  } else if (!step2Done) {
    // CoFHE timer starts at endAuction time, which we approximate as endTime + ~10s
    estRemaining = Math.max(0, 50 - elapsedSinceEnd)
  } else if (!step3Done) {
    estRemaining = 5
  }

  const Step = ({ n, label, done, active, sublabel }: {
    n: number
    label: string
    done: boolean
    active: boolean
    sublabel?: string
  }) => (
    <li className="flex items-start gap-3">
      <span className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold",
        done ? "border-accent bg-accent text-accent-foreground" :
        active ? "border-accent text-accent animate-pulse" :
        "border-border/50 text-muted-foreground/50",
      )}>
        {done ? "✓" : active ? "⟳" : n}
      </span>
      <div className="min-w-0">
        <p className={cn(
          "uppercase tracking-widest",
          done ? "text-accent" : active ? "text-foreground" : "text-muted-foreground/60",
        )}>{label}</p>
        {sublabel && (
          <p className="mt-0.5 text-[10px] normal-case tracking-normal text-muted-foreground/70">{sublabel}</p>
        )}
      </div>
    </li>
  )

  if (noBids) {
    return (
      <div className="mt-6 border border-muted-foreground/30 bg-muted/5 p-4 font-mono text-xs">
        <p className="uppercase tracking-widest text-muted-foreground">No bids — auction void</p>
        <p className="mt-2 text-muted-foreground/70">
          Nothing to finalize. Seller's gas deposit is locked on chain.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6 border border-accent/30 bg-accent/5 p-4 font-mono text-xs">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="uppercase tracking-widest text-accent">Automatic settlement in progress</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">
          {elapsedSinceEnd}s elapsed{estRemaining !== null && estRemaining > 0 ? ` · ~${estRemaining}s left` : ""}
        </p>
      </div>
      <ul className="mt-4 space-y-3">
        <Step
          n={1}
          label="End auction"
          done={step1Done}
          active={!step1Done}
          sublabel={!step1Done ? "Railway keeper detected expiry, submitting endAuction tx…" : undefined}
        />
        <Step
          n={2}
          label="CoFHE oracle decrypting winner"
          done={step2Done}
          active={step1Done && !step2Done}
          sublabel={
            step1Done && !step2Done
              ? "Threshold network running MPC + signing plaintext (~30-45s)"
              : undefined
          }
        />
        <Step
          n={3}
          label="Publish winner + settle bids"
          done={step3Done}
          active={step2Done && !step3Done}
          sublabel={
            step2Done && !step3Done
              ? "Submitting finalizeAuction(winner, amount, sigs)…"
              : undefined
          }
        />
      </ul>
      <p className="mt-4 pt-3 border-t border-border/30 text-[10px] text-muted-foreground/60">
        Keeper EOA: <span className="text-muted-foreground">0xf43F…4Cf7</span>
        {" · "}
        Polls chain every 5s — no wallet signature required.
      </p>
    </div>
  )
}
