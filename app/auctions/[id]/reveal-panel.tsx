"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount, usePublicClient, useWalletClient } from "wagmi"
import { getAddress, type Address } from "viem"
import { cn } from "@/lib/utils"
import { ensureCofheInit, getCofhejs, unsealWithRetry } from "@/lib/cofhe"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  formatUsdc,
  type AuctionData,
} from "@/lib/fhenix-contracts"
import { chainId } from "@/lib/chain-config"

type BidRow = {
  index: number
  bidder: Address
  handle: bigint
  refunded: boolean
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

  const [endingAuction, setEndingAuction] = useState(false)
  const [publishingWinner, setPublishingWinner] = useState(false)
  const [busyReveal, setBusyReveal] = useState<number | null>(null)
  const [busySettle, setBusySettle] = useState<number | null>(null)
  const [bids, setBids] = useState<BidRow[]>([])
  const [loadingBids, setLoadingBids] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
          const [bidder, handle, refunded, revealed] = r.result as [
            Address, bigint, boolean, boolean,
          ]
          const existing = bids.find((b) => b.index === i)
          return {
            index: i,
            bidder,
            handle,
            refunded,
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

  async function handlePublishWinner() {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setPublishingWinner(true)
      // FHE.decrypt was sunset on base-sepolia, so we unseal the running-max
      // handles client-side via cofhejs. `endAuction` set FHE.allowGlobal,
      // so anyone with cofhejs can reproduce this.
      await ensureCofheInit(publicClient as never, walletClient)
      const { FheTypes } = await getCofhejs()
      const winnerAmount = await unsealWithRetry(auction.highestBidHandle, FheTypes.Uint64)
      const winnerAddrRaw = await unsealWithRetry(auction.highestBidderHandle, FheTypes.Uint256)
      const winner = getAddress("0x" + winnerAddrRaw.toString(16).padStart(40, "0"))

      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "publishWinner",
        args: [auction.id, winner, winnerAmount],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("publishWinner reverted")
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "publishWinner failed")
    } finally {
      setPublishingWinner(false)
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

  async function handleUnsealRevealed(bidIndex: number) {
    if (!publicClient || !walletClient) return
    setError(null)
    try {
      setBusyReveal(bidIndex)
      await ensureCofheInit(publicClient as never, walletClient)
      const { FheTypes } = await getCofhejs()
      const target = bids.find((b) => b.index === bidIndex)
      if (!target) throw new Error("bid not found")
      const plain = await unsealWithRetry(target.handle, FheTypes.Uint64)
      setBids((curr) => curr.map((b) => (b.index === bidIndex ? { ...b, plain } : b)))
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "unseal failed")
    } finally {
      setBusyReveal(null)
    }
  }

  async function handleSettleBid(bidIndex: number) {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setBusySettle(bidIndex)
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "settleBid",
        args: [auction.id, BigInt(bidIndex)],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("settleBid reverted")
      await fetchBids()
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "settle failed")
    } finally {
      setBusySettle(null)
    }
  }

  const needsEnd = !auction.ended
  const needsPublish = auction.ended && !auction.winnerPublished

  return (
    <div>
      <h2 className="font-[var(--font-bebas)] text-2xl md:text-3xl tracking-tight">Results</h2>
      <p className="mt-2 font-mono text-xs text-muted-foreground max-w-2xl">
        The auction deadline has passed. End the auction to publish the winner ACL, then anyone
        can unseal the winning bid and publish it on-chain. Bidders may opt in to reveal their
        own bid so it appears here with its plaintext amount.
      </p>

      {error && (
        <div className="mt-4 border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      <div className="mt-6 grid gap-3 md:grid-cols-3">
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
          onClick={handlePublishWinner}
          disabled={needsEnd || !needsPublish || publishingWinner}
          className={cn(
            "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border transition-colors",
            needsPublish && !needsEnd
              ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
              : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
          )}
        >
          {auction.winnerPublished
            ? "✓ Winner published"
            : publishingWinner
              ? "Unsealing + publishing…"
              : "2. Unseal + publish winner"}
        </button>
        <div
          className={cn(
            "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border text-center",
            auction.winnerPublished
              ? "border-accent/60 text-accent"
              : "border-border/40 text-muted-foreground/50",
          )}
        >
          3. Settle bids below
        </div>
      </div>

      {auction.winnerPublished && (
        <div className="mt-6 border border-accent/40 bg-accent/5 p-5 font-mono">
          <p className="text-[10px] uppercase tracking-[0.3em] text-accent">Winner</p>
          <p className="mt-2 text-lg text-foreground break-all">{auction.winnerPlain}</p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-accent">Winning bid</p>
          <p className="mt-2 text-2xl tabular-nums text-foreground">
            {formatUsdc(auction.winningAmountPlain, 2)} USDC
          </p>
        </div>
      )}

      <div className="mt-10">
        <h3 className="font-[var(--font-bebas)] text-xl tracking-tight">Bid ledger</h3>
        {loadingBids ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground/60">Loading bids…</p>
        ) : bids.length === 0 ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground/60">No bids were placed.</p>
        ) : (
          <ul className="mt-4 space-y-2 font-mono text-[12px]">
            {bids.map((b) => {
              const isMyBid = myAddr && b.bidder.toLowerCase() === myAddr.toLowerCase()
              const isWinner = auction.winnerPublished && b.bidder.toLowerCase() === auction.winnerPlain.toLowerCase()
              const canSettle = auction.winnerPublished && !b.refunded
              const showPlain = b.plain !== undefined
                ? `${formatUsdc(b.plain, 2)} USDC`
                : isWinner
                  ? `${formatUsdc(auction.winningAmountPlain, 2)} USDC`
                  : b.revealed
                    ? "revealed (unseal →)"
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
                    {isMyBid && !b.revealed && (
                      <button
                        onClick={() => handleRevealMyBid(b.index)}
                        disabled={busyReveal === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-accent/40 text-accent hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                      >
                        {busyReveal === b.index ? "…" : "Reveal"}
                      </button>
                    )}
                    {b.revealed && b.plain === undefined && (
                      <button
                        onClick={() => handleUnsealRevealed(b.index)}
                        disabled={busyReveal === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-accent/40 text-accent hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                      >
                        {busyReveal === b.index ? "…" : "Unseal"}
                      </button>
                    )}
                    {canSettle && (
                      <button
                        onClick={() => handleSettleBid(b.index)}
                        disabled={busySettle === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-border/40 text-muted-foreground hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
                      >
                        {busySettle === b.index ? "…" : isWinner ? "Pay seller" : "Refund"}
                      </button>
                    )}
                    {b.refunded && (
                      <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
                        settled
                      </span>
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
