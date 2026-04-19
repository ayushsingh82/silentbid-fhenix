"use client"

import { useEffect, useMemo, useState } from "react"
import { usePublicClient, useWalletClient } from "wagmi"
import { type Address, parseAbiItem } from "viem"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  formatUsdc,
} from "@/lib/fhenix-contracts"
import { chainId, blockExplorerUrl } from "@/lib/chain-config"
import { ensureCofheInit, getCofhejs, unsealWithRetry } from "@/lib/cofhe"

type BidRow = {
  index: bigint
  bidder: Address
  encAmountHandle: bigint
  blockNumber: bigint
  revealed: boolean
}

const BID_PLACED_EVENT = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, uint256 encAmountHandle)",
)

const LOG_CHUNK = 9000n

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
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()
  const [rows, setRows] = useState<BidRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unsealed, setUnsealed] = useState<Record<string, bigint>>({})
  const [unsealingIndex, setUnsealingIndex] = useState<bigint | null>(null)

  useEffect(() => {
    if (!publicClient || !AUCTION_ADDRESS) return
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)

        const latest = await publicClient!.getBlockNumber()
        const logs: Array<{
          bidIndex: bigint
          bidder: Address
          encAmountHandle: bigint
          blockNumber: bigint
        }> = []
        let from = 0n
        while (from <= latest) {
          const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
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
              encAmountHandle: (log.args as { encAmountHandle: bigint }).encAmountHandle,
              blockNumber: log.blockNumber ?? 0n,
            })
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
            })) as [Address, bigint, boolean, boolean]
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
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load bids")
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

  async function handleUnseal(row: BidRow) {
    if (!publicClient || !walletClient) return
    setUnsealingIndex(row.index)
    try {
      await ensureCofheInit(publicClient as never, walletClient)
      const { FheTypes } = await getCofhejs()
      const plain = await unsealWithRetry(row.encAmountHandle, FheTypes.Uint64)
      setUnsealed((u) => ({ ...u, [row.index.toString()]: plain }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unseal failed")
    } finally {
      setUnsealingIndex(null)
    }
  }

  if (loading) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground animate-pulse">
        Loading sealed bids…
      </div>
    )
  }

  if (error) {
    return <p className="font-mono text-xs text-destructive/80 break-all">{error}</p>
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
                </td>
                <td className="py-2 px-3 text-foreground">
                  {plain !== undefined ? (
                    <span>{formatUsdc(plain, 2)} USDC</span>
                  ) : row.revealed ? (
                    <button
                      type="button"
                      disabled={unsealingIndex === row.index}
                      onClick={() => handleUnseal(row)}
                      className="text-accent hover:underline disabled:opacity-50"
                    >
                      {unsealingIndex === row.index ? "unsealing…" : "unseal"}
                    </button>
                  ) : (
                    <span className="text-purple-400 text-[10px] uppercase tracking-widest">
                      encrypted
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
