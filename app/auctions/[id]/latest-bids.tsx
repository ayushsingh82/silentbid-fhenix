"use client"

import { useEffect, useMemo, useState } from "react"
import { useAccount, usePublicClient, useWalletClient } from "wagmi"
import { type Address, parseAbiItem } from "viem"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  formatUsdc,
} from "@/lib/fhenix-contracts"
import { chainId, blockExplorerUrl } from "@/lib/chain-config"
import { ensureCofheInit, decryptForView, getFheTypes } from "@/lib/cofhe"

type BidRow = {
  index: bigint
  bidder: Address
  encAmountHandle: string  // bytes32 hex
  blockNumber: bigint
  revealed: boolean
}

const BID_PLACED_EVENT = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, bytes32 encAmountHandle)",
)

const LOG_CHUNK = 1000n

function shortAddress(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function LatestBids({
  auctionId,
  refreshKey,
}: {
  auctionId: bigint
  refreshKey: number
}) {
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()
  const [rows, setRows] = useState<BidRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unsealed, setUnsealed] = useState<Record<string, bigint>>({})
  const [unsealingIndex, setUnsealingIndex] = useState<bigint | null>(null)
  const [loadTimeout, setLoadTimeout] = useState(false)

  // Timeout for stuck loading
  useEffect(() => {
    if (!loading || loadTimeout) return
    const timeout = setTimeout(() => setLoadTimeout(true), 8000)
    return () => clearTimeout(timeout)
  }, [loading, loadTimeout])

  useEffect(() => {
    if (!publicClient || !AUCTION_ADDRESS) {
      if (loading && !AUCTION_ADDRESS) {
        setError("Auction contract address not configured")
        setLoading(false)
      }
      return
    }
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)
        setLoadTimeout(false)

        const latest = await publicClient!.getBlockNumber()
        const logs: Array<{
          bidIndex: bigint
          bidder: Address
          encAmountHandle: string
          blockNumber: bigint
        }> = []
        
        // Start from a recent block to avoid scanning entire chain history
        // Going back ~7 days of blocks (estimate: ~50k blocks per week on Base Sepolia)
        const startBlock = Math.max(0, Number(latest) - 100000)
        let from = BigInt(startBlock)
        
        while (from <= latest) {
          const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
          try {
            const chunk = await publicClient!.getLogs({
              address: AUCTION_ADDRESS,
              event: BID_PLACED_EVENT,
              args: { auctionId },
              fromBlock: from,
              toBlock: to,
            })
            for (const log of chunk) {
              logs.push({
                bidIndex: (log.args as { bidIndex: bigint }).bidIndex,
                bidder: (log.args as { bidder: Address }).bidder,
                encAmountHandle: (log.args as { encAmountHandle: string }).encAmountHandle,
                blockNumber: log.blockNumber ?? 0n,
              })
            }
          } catch (err) {
            console.warn(`Failed to fetch logs from ${from} to ${to}:`, err)
            // Continue with next chunk despite errors
          }
          from = to + 1n
        }

        // Check the `revealed` flag per bid (opt-in reveal sets it on-chain).
        const hydrated = await Promise.all(
          logs.map(async (l) => {
            const bid = (await publicClient!.readContract({
              address: AUCTION_ADDRESS,
              abi: AUCTION_ABI,
              functionName: "getBid",
              args: [auctionId, l.bidIndex],
            })) as [Address, string, boolean, boolean]
            return {
              index: l.bidIndex,
              bidder: l.bidder,
              encAmountHandle: l.encAmountHandle,
              blockNumber: l.blockNumber,
              revealed: bid[3],
            }
          }),
        )
        if (cancelled) return
        hydrated.sort((a, b) => Number(a.index - b.index))
        setRows(hydrated)
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load bids"
        console.error("LatestBids error:", err)
        if (!cancelled) {
          setError(
            message.includes("getLogs") || message.includes("timeout")
              ? "Network timeout loading bids. Try refreshing the page."
              : message
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [publicClient, auctionId, refreshKey])

  const revealedRows = useMemo(() => rows.filter((r) => r.revealed), [rows])

  // Only allow unsealing your own revealed bids
  async function handleUnseal(row: BidRow) {
    if (!publicClient || !walletClient) return
    setUnsealingIndex(row.index)
    try {
      await ensureCofheInit(publicClient as never, walletClient)
      const FheTypes = await getFheTypes()
      const plain = (await decryptForView(row.encAmountHandle, FheTypes.Uint64)) as bigint
      setUnsealed((u) => ({ ...u, [row.index.toString()]: plain as bigint }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unseal failed")
    } finally {
      setUnsealingIndex(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground animate-pulse">
          Loading sealed bids…
        </div>
        <div className="space-y-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-8 bg-muted/20 animate-pulse border border-border/20 rounded" />
          ))}
        </div>
        {loadTimeout && (
          <div className="mt-3 border border-yellow-500/40 bg-yellow-500/10 p-3 rounded">
            <p className="font-mono text-[10px] text-yellow-600 dark:text-yellow-500">
              Taking longer than expected. Check your connection.
            </p>
          </div>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-destructive/50 bg-destructive/10 p-3 rounded">
        <p className="font-mono text-xs text-destructive/80 break-all">{error}</p>
        <p className="font-mono text-[10px] text-destructive/60 mt-2">Make sure you're connected to Base Sepolia.</p>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        No bids yet. Be the first to place a sealed bid.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-xs border border-border/40">
        <thead>
          <tr className="border-b border-border/40 text-[10px] uppercase tracking-widest text-muted-foreground text-left">
            <th className="py-2 px-3">#</th>
            <th className="py-2 px-3">Wallet</th>
            <th className="py-2 px-3">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = row.index.toString()
            const plain = unsealed[key]
            const isMyBid = myAddr && row.bidder.toLowerCase() === myAddr.toLowerCase()
            return (
              <tr key={key} className="border-b border-border/30 hover:bg-muted/20">
                <td className="py-2 px-3 text-muted-foreground">{key}</td>
                <td className="py-2 px-3">
                  {blockExplorerUrl ? (
                    <a
                      href={`${blockExplorerUrl}/address/${row.bidder}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      {shortAddress(row.bidder)}
                    </a>
                  ) : (
                    <span className="text-accent">{shortAddress(row.bidder)}</span>
                  )}
                  {isMyBid && (
                    <span className="ml-1 text-purple-400 text-[9px] uppercase tracking-widest">you</span>
                  )}
                </td>
                <td className="py-2 px-3 text-foreground">
                  {plain !== undefined ? (
                    <span>{formatUsdc(plain, 2)} USDC</span>
                  ) : row.revealed && isMyBid ? (
                    <button
                      type="button"
                      disabled={unsealingIndex === row.index}
                      onClick={() => handleUnseal(row)}
                      className="text-accent hover:underline disabled:opacity-50"
                    >
                      {unsealingIndex === row.index ? "unsealing…" : "unseal"}
                    </button>
                  ) : row.revealed ? (
                    <span className="text-muted-foreground/60 text-[10px] uppercase tracking-widest">
                      revealed
                    </span>
                  ) : (
                    <span className="text-purple-400 text-[10px] uppercase tracking-widest">
                      ••••• USDC (encrypted)
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {revealedRows.length > 0 && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          {revealedRows.length} of {rows.length} bidders opted to reveal.
        </p>
      )}
    </div>
  )
}
