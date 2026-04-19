"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { useAccount, usePublicClient, useWalletClient } from "wagmi"
import { type Address, parseAbiItem } from "viem"
import { ConnectButtonWrapper } from "@/components/connect-button"
import { SilentBidLogo } from "@/components/silentbid-logo"
import { cn } from "@/lib/utils"
import { ensureCofheInit, getCofhejs, unsealWithRetry } from "@/lib/cofhe"
import { chainId, blockExplorerUrl, networkName } from "@/lib/chain-config"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  auctionStatus,
  formatUsdc,
  type AuctionData,
  type AuctionStatus,
} from "@/lib/fhenix-contracts"

const BID_PLACED_EVENT = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, uint256 encAmountHandle)",
)

const LOG_CHUNK = 9000n

type Row = {
  auctionId: bigint
  bidIndex: bigint
  encHandle: bigint
  revealed: boolean
  refunded: boolean
  blockNumber: bigint
  auction: AuctionData
}

function statusLabel(s: AuctionStatus): string {
  return s === "active" ? "Live" : s === "ended" ? "Ended" : "Settled"
}

export default function MyBidsPage() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, bigint>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)

  useEffect(() => {
    if (!publicClient || !address || !AUCTION_ADDRESS) return
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)
        const latest = await publicClient!.getBlockNumber()
        const logs: Array<{
          auctionId: bigint
          bidIndex: bigint
          encHandle: bigint
          blockNumber: bigint
        }> = []
        let from = 0n
        while (from <= latest) {
          const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
          const chunk = await publicClient!.getLogs({
            address: AUCTION_ADDRESS,
            event: BID_PLACED_EVENT,
            args: { bidder: address as Address },
            fromBlock: from,
            toBlock: to,
          })
          for (const log of chunk) {
            const a = log.args as {
              auctionId: bigint
              bidIndex: bigint
              encAmountHandle: bigint
            }
            logs.push({
              auctionId: a.auctionId,
              bidIndex: a.bidIndex,
              encHandle: a.encAmountHandle,
              blockNumber: log.blockNumber ?? 0n,
            })
          }
          from = to + 1n
        }

        const hydrated = await Promise.all(
          logs.map(async (l) => {
            const [bid, auction] = await Promise.all([
              publicClient!.readContract({
                address: AUCTION_ADDRESS,
                abi: AUCTION_ABI,
                functionName: "getBid",
                args: [l.auctionId, l.bidIndex],
              }) as Promise<[Address, bigint, boolean, boolean]>,
              publicClient!.readContract({
                address: AUCTION_ADDRESS,
                abi: AUCTION_ABI,
                functionName: "getAuction",
                args: [l.auctionId],
              }) as Promise<AuctionData>,
            ])
            return {
              auctionId: l.auctionId,
              bidIndex: l.bidIndex,
              encHandle: l.encHandle,
              refunded: bid[2],
              revealed: bid[3],
              blockNumber: l.blockNumber,
              auction: { ...auction, id: l.auctionId },
            } satisfies Row
          }),
        )
        if (cancelled) return
        hydrated.sort((a, b) => Number(b.blockNumber - a.blockNumber))
        setRows(hydrated)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load your bids")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [publicClient, address])

  async function handleReveal(row: Row) {
    if (!publicClient || !walletClient) return
    const key = `${row.auctionId}-${row.bidIndex}`
    setBusyKey(key)
    setError(null)
    try {
      if (!row.revealed) {
        const hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "revealMyBid",
          args: [row.auctionId, row.bidIndex],
          account: walletClient.account!,
          chain: walletClient.chain,
        })
        const rcpt = await publicClient.waitForTransactionReceipt({ hash })
        if (rcpt.status !== "success") throw new Error("revealMyBid reverted")
        setRows((rs) =>
          rs.map((r) =>
            r.auctionId === row.auctionId && r.bidIndex === row.bidIndex
              ? { ...r, revealed: true }
              : r,
          ),
        )
      }
      await ensureCofheInit(publicClient as never, walletClient)
      const { FheTypes } = await getCofhejs()
      const plain = await unsealWithRetry(row.encHandle, FheTypes.Uint64)
      setRevealed((r) => ({ ...r, [key]: plain }))
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 240) : "reveal failed")
    } finally {
      setBusyKey(null)
    }
  }

  const summary = useMemo(() => {
    const total = rows.length
    const open = rows.filter((r) => auctionStatus(r.auction) === "active").length
    const settled = rows.filter((r) => r.auction.winnerPublished).length
    return { total, open, settled }
  }, [rows])

  return (
    <main className="relative min-h-screen">
      <div className="grid-bg fixed inset-0 opacity-30" aria-hidden="true" />
      <header className="relative z-20 border-b border-border/30 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between px-6 md:px-12 py-4 gap-4 flex-wrap">
          <SilentBidLogo />
          <ConnectButtonWrapper />
        </div>
      </header>

      <section className="relative z-10 px-6 md:px-12 py-12 md:py-20">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">your bids</p>
        <h1 className="mt-3 font-[var(--font-bebas)] text-4xl md:text-6xl tracking-tight">
          My Bids
        </h1>
        <p className="mt-3 max-w-xl font-mono text-sm text-muted-foreground">
          Every bid you&apos;ve placed on {networkName}. Amounts stay encrypted unless you choose to
          reveal them.
        </p>

        <div className="mt-10 grid grid-cols-3 gap-4 font-mono max-w-lg">
          <Stat label="total" value={summary.total} />
          <Stat label="active" value={summary.open} />
          <Stat label="settled" value={summary.settled} />
        </div>

        {error && (
          <div className="mt-8 border border-destructive/50 bg-destructive/10 p-4 max-w-2xl">
            <p className="font-mono text-[11px] text-destructive break-all">{error}</p>
          </div>
        )}

        {!isConnected && (
          <div className="mt-10 border border-border/40 p-6 max-w-2xl">
            <p className="font-mono text-sm text-muted-foreground">
              Connect a wallet to see your bids.
            </p>
          </div>
        )}

        {isConnected && loading && (
          <p className="mt-10 font-mono text-sm text-muted-foreground animate-pulse">
            Scanning blocks for your bids…
          </p>
        )}

        {isConnected && !loading && rows.length === 0 && (
          <div className="mt-10 border border-border/40 p-6 max-w-2xl">
            <p className="font-mono text-sm text-muted-foreground">
              No bids yet.{" "}
              <Link href="/auctions" className="text-accent hover:underline">
                Browse auctions
              </Link>
              .
            </p>
          </div>
        )}

        {isConnected && rows.length > 0 && (
          <ul className="mt-10 space-y-3">
            {rows.map((row) => {
              const key = `${row.auctionId}-${row.bidIndex}`
              const plain = revealed[key]
              const status = auctionStatus(row.auction)
              const isWinner =
                row.auction.winnerPublished &&
                address &&
                row.auction.winnerPlain.toLowerCase() === address.toLowerCase()
              return (
                <li
                  key={key}
                  className="border border-border/40 p-5 flex flex-wrap gap-4 items-center justify-between"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/auctions/${row.auctionId.toString()}`}
                      className="font-[var(--font-bebas)] text-2xl tracking-tight hover:text-accent"
                    >
                      {row.auction.itemName || `Auction #${row.auctionId.toString()}`}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      <span
                        className={cn(
                          "border px-2 py-0.5",
                          status === "active" && "border-accent/60 text-accent",
                          status === "ended" && "border-yellow-500/60 text-yellow-500",
                          status === "settled" && "border-muted-foreground/40 text-muted-foreground",
                        )}
                      >
                        {statusLabel(status)}
                      </span>
                      <span>bid #{row.bidIndex.toString()}</span>
                      {isWinner && <span className="text-accent">winner</span>}
                      {row.refunded && <span>refunded</span>}
                      {blockExplorerUrl && (
                        <a
                          href={`${blockExplorerUrl}/block/${row.blockNumber.toString()}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          block {row.blockNumber.toString()}
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 font-mono text-sm">
                    {plain !== undefined ? (
                      <span className="text-accent tabular-nums">
                        {formatUsdc(plain, 2)} USDC
                      </span>
                    ) : (
                      <span className="text-purple-400 text-[10px] uppercase tracking-widest">
                        encrypted
                      </span>
                    )}
                    {status !== "active" && plain === undefined && (
                      <button
                        type="button"
                        disabled={busyKey === key}
                        onClick={() => handleReveal(row)}
                        className="text-[10px] uppercase tracking-widest px-3 py-2 border border-accent/50 text-accent hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40"
                      >
                        {busyKey === key
                          ? "…"
                          : row.revealed
                            ? "unseal"
                            : "reveal"}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border/40 px-4 py-3">
      <p className="text-[9px] uppercase tracking-[0.3em] text-muted-foreground/70">{label}</p>
      <p className="mt-1 text-2xl tabular-nums">{value}</p>
    </div>
  )
}
