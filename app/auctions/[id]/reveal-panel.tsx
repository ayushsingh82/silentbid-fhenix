"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { getAddress, formatEther, type Address } from "viem"
import { cn } from "@/lib/utils"
import { ensureCofheInit, decryptForView, decryptForTx, getFheTypes } from "@/lib/cofhe"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  TREASURY_ABI,
  TREASURY_ADDRESS,
  formatUsdc,
  type AuctionData,
} from "@/lib/fhenix-contracts"
import { chainId } from "@/lib/chain-config"

interface AutomationStatus {
  status: "idle" | "checking" | "settling" | "error"
  message: string
  lastCheck?: number
}

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
  automationStatus,
}: {
  auction: AuctionData
  onUpdate?: () => void
  automationStatus?: AutomationStatus
}) {
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()

  const [endingAuction, setEndingAuction] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
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


  async function handleEndAuction() {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setEndingAuction(true)
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "endAuction",
        args: [auction.id],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("endAuction reverted")
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "endAuction failed")
    } finally {
      setEndingAuction(false)
    }
  }

  async function handleFinalizeAuction() {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setFinalizing(true)
      await ensureCofheInit(publicClient as never, walletClient)

      // Decrypt both handles via the CoFHE oracle (returns signed plaintext).
      const amountResult = await decryptForTx(auction.highestBidHandle)
      const bidderResult = await decryptForTx(auction.highestBidderHandle)

      const winnerAmount = amountResult.decryptedValue as bigint
      const winnerAddrRaw = bidderResult.decryptedValue as bigint
      const winner = getAddress("0x" + winnerAddrRaw.toString(16).padStart(40, "0"))

      // Single finalizeAuction call: publishes winner + settles ALL bids + collects fee
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "finalizeAuction",
        args: [auction.id, winner, winnerAmount, bidderResult.signature, amountResult.signature],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("finalizeAuction reverted")
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "finalizeAuction failed")
    } finally {
      setFinalizing(false)
    }
  }

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

      {/* Show automation status or manual buttons */}
      {automationStatus && automationStatus.status === "error" ? (
        // Automation failed - show manual buttons as fallback
        <>
          <div className="mt-4 border border-destructive/50 bg-destructive/10 p-4">
            <p className="font-mono text-xs text-destructive">
              ⚠️ Automation encountered an error. Use manual buttons below to settle the auction:
            </p>
            <p className="font-mono text-xs text-destructive/80 mt-2">{automationStatus.message}</p>
          </div>
          
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <button
              onClick={handleEndAuction}
              disabled={!needsEnd || endingAuction}
              className={cn(
                "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border transition-colors",
                needsEnd
                  ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
                  : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
              )}
            >
              {auction.ended ? "✓ Auction ended" : endingAuction ? "Ending…" : "1. End auction"}
            </button>
            <button
              onClick={handleFinalizeAuction}
              disabled={needsEnd || !needsFinalize || finalizing}
              className={cn(
                "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border transition-colors",
                needsFinalize && !needsEnd
                  ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
                  : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
              )}
            >
              {auction.finalized
                ? "✓ Finalized (all settled)"
                : finalizing
                  ? "Unsealing + settling all…"
                  : "2. Finalize (auto-settle all)"}
            </button>
          </div>
        </>
      ) : automationStatus && (automationStatus.status === "checking" || automationStatus.status === "settling") ? (
        // Automation is working
        <div className={cn(
          "mt-6 border p-4 rounded font-mono text-xs",
          "border-accent/40 bg-accent/5 text-accent",
        )}>
          <p className="uppercase tracking-widest mb-2">
            ⚙️ Automatic Settlement Active
          </p>
          <p>{automationStatus.message}</p>
          <p className="text-accent/70 mt-2">No manual action needed. This will complete automatically.</p>
        </div>
      ) : auction.finalized ? (
        // Already settled
        <div className="mt-6 border border-accent/40 bg-accent/5 p-4 font-mono text-xs">
          <p className="uppercase tracking-widest text-accent">✓ Settled</p>
          <p className="mt-2">Auction has been settled automatically.</p>
        </div>
      ) : needsFinalize || needsEnd ? (
        // Auction expired but not settled - automation should be working
        <div className={cn(
          "mt-6 border p-4 rounded font-mono text-xs",
          "border-blue-500/40 bg-blue-500/5 text-blue-500",
        )}>
          <p className="uppercase tracking-widest mb-2">
            ⏳ Waiting for Settlement
          </p>
          <p>Automatic settlement is in progress. Please keep this page open or check back shortly.</p>
        </div>
      ) : null}

      {/* Manual buttons hidden - only show on error */}

      {gasPool > 0n && !auction.finalized && (
        <p className="mt-3 font-mono text-[10px] text-muted-foreground/70">
          Gas pool: {formatEther(gasPool)} ETH — caller of finalize gets compensated, remainder refunded to seller.
        </p>
      )}

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
