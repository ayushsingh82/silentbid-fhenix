"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"

const SLIDES = [
  {
    title: "What is SilentBid?",
    content: (
      <ul className="list-disc list-inside space-y-3 text-left max-w-2xl mx-auto">
        <li><strong>SilentBid</strong> = Uniswap's <strong>Continuous Clearing Auction (CCA)</strong> + <strong>sealed-bid / private bidding</strong>.</li>
        <li><strong>CCA</strong> gives fair, continuous price discovery and liquidity bootstrapping for a new token; bids are time-weighted and clear to a single price.</li>
        <li><strong>SilentBid</strong> keeps <strong>bid prices and amounts private</strong> until the auction closes — no front-running or MEV sniping. (Bidder addresses remain visible on-chain.)</li>
        <li><strong>Why it matters:</strong> Fairer launches, no strategic bid leakage, better UX for participants.</li>
      </ul>
    ),
  },
  {
    title: "The Problem We Solve",
    content: (
      <div className="max-w-3xl mx-auto space-y-4">
        <p className="text-sm text-muted-foreground text-center">
          On standard Uniswap CCA, <strong className="text-foreground">bids are public</strong>: everyone sees prices and amounts → front-running and MEV.
        </p>
        <div className="border border-border overflow-hidden bg-muted/20">
          <img
            src="/public-bid.png"
            alt="Public bid on Uniswap CCA — the problem: visible bids, MEV, sniping"
            className="w-full h-auto object-contain max-h-[340px] object-center"
          />
        </div>
        <p className="text-sm text-center">
          <strong className="text-accent">SilentBid</strong> wraps CCA with <strong>sealed bids</strong> (Chainlink CRE): only a commitment is onchain; price and amount stay private until the CRE workflow finalizes the auction.
        </p>
      </div>
    ),
  },
  {
    title: "How We Add Privacy (Chainlink CRE)",
    content: (
      <ul className="list-disc list-inside space-y-3 text-left max-w-2xl mx-auto">
        <li><strong>Chainlink CRE</strong> (Confidential HTTP + Confidential Compute) keeps bid details offchain; only a <strong>commitment</strong> is stored onchain.</li>
        <li><strong>Flow:</strong> User signs bid (EIP-712) → frontend sends to CRE workflow → CRE stores bid privately and optionally triggers <strong>submitBlindBid(commitment)</strong> with escrow; after the blind-bid deadline CRE computes clearing and calls <strong>forwardBidsToCCA</strong>.</li>
        <li>Credentials and sensitive data stay in CRE; compliant private transfers follow the same pattern as the Chainlink private transfer demo.</li>
      </ul>
    ),
  },
  {
    title: "Architecture (High Level)",
    content: (
      <div className="max-w-2xl mx-auto text-left">
        <table className="w-full border border-border text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="p-3 text-left font-mono">Layer</th>
              <th className="p-3 text-left">What it does</th>
            </tr>
          </thead>
          <tbody className="[&_tr]:border-b [&_tr]:border-border">
            <tr><td className="p-3 font-mono">Uniswap CCA</td><td className="p-3">Auction mechanics: create, place bids, clearing price, settlement, pool seed.</td></tr>
            <tr><td className="p-3 font-mono">Our CCA factory</td><td className="p-3">We deploy our own factory (Sepolia) for USDC auctions.</td></tr>
            <tr><td className="p-3 font-mono">SilentBid contract</td><td className="p-3">Wraps CCA: submitBlindBid(commitment), admin-only forwardBidToCCA / forwardBidsToCCA (called by CRE).</td></tr>
            <tr><td className="p-3 font-mono">App (Next.js)</td><td className="p-3">Create auction (ETH/USDC), deploy SilentBid, place sealed bid (commitment → submitBlindBid).</td></tr>
          </tbody>
        </table>
      </div>
    ),
  },
  {
    title: "How We Build It",
    content: (
      <div className="max-w-3xl mx-auto">
        <p className="text-[11px] text-muted-foreground text-center mb-6">
          End-to-end flow: sealed bid (commitment) → CRE finalizes → forward to CCA
        </p>
        <div className="space-y-4">
          <div className="border border-accent/40 rounded-lg bg-accent/5 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-accent mb-3">Phase 1 — Blind bidding</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">User (price + amount)</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">Commitment (browser)</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-accent/20 border border-accent/50 font-mono">submitBlindBid(commitment)</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-muted border border-border font-mono">SilentBid (commitment + escrow onchain)</span>
            </div>
          </div>
          <div className="border border-amber-500/40 rounded-lg bg-amber-500/5 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-amber-600 mb-3">Phase 2 — After deadline (CRE)</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">CRE workflow</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">Price discovery + compliance</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-amber-500/20 border border-amber-500/50 font-mono">forwardBidsToCCA</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-muted border border-border font-mono">Uniswap CCA (real bids)</span>
            </div>
          </div>
          <div className="border border-border rounded-lg bg-muted/20 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Phase 3 — Settlement</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">CCA clearing price</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">exitBid / claimTokens</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1.5 rounded bg-background border border-border font-mono">Pool seed</span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: "Challenges & Next Steps",
    content: (
      <ul className="list-disc list-inside space-y-2 text-left max-w-2xl mx-auto text-sm">
        <li><strong>USDC create on Sepolia:</strong> Step encoding and block/duration fixed; create still reverts "unknown reason" — need to simulate and decode CCA revert.</li>
        <li><strong>Reveal/forward:</strong> Not in UI yet; via scripts or backend (md/ZAMA_ENCRYPTED_BIDDING.md).</li>
        <li><strong>WalletConnect:</strong> Init warnings in dev; fix with single init or setMaxListeners.</li>
      </ul>
    ),
  },
  {
    title: "Thank you",
    content: (
      <div className="max-w-xl mx-auto text-center py-8">
        <p className="font-[var(--font-bebas)] text-4xl sm:text-5xl tracking-tight text-accent">
          Thank you
        </p>
        <p className="mt-4 font-mono text-sm text-muted-foreground">
          SilentBid — Privacy-focused CCA · Sealed-bid token launches
        </p>
      </div>
    ),
  },
]

export default function PptPage() {
  const [index, setIndex] = useState(0)
  const slide = SLIDES[index]
  const isFirst = index === 0

  const goNext = useCallback(() => {
    setIndex((i) => (i + 1) % SLIDES.length)
  }, [])

  const goPrev = useCallback(() => {
    setIndex((i) => (i - 1 + SLIDES.length) % SLIDES.length)
  }, [])

  return (
    <main className="min-h-screen w-full flex flex-col bg-background text-foreground">
      <div className="flex-1 flex flex-col items-center justify-center p-8 md:p-12">
        <div className="w-full max-w-4xl">
          <h1 className="font-[var(--font-bebas)] text-3xl sm:text-4xl tracking-tight text-accent mb-2">
            SilentBid
          </h1>
          <p className="font-mono text-xs text-muted-foreground mb-8">EthGlobal · Slide {index + 1} of {SLIDES.length}</p>

          <div className="border border-border bg-card p-6 md:p-10 min-h-[320px] flex flex-col justify-center">
            <h2 className="font-mono text-lg uppercase tracking-widest text-muted-foreground mb-6">
              {slide.title}
            </h2>
            <div className="text-foreground">
              {slide.content}
            </div>
          </div>

          <div className="flex items-center justify-between mt-8">
            <button
              type="button"
              onClick={goPrev}
              className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
              disabled={isFirst}
              aria-label="Previous slide"
            >
              <span aria-hidden>←</span> Prev
            </button>

            <div className="flex gap-2">
              {SLIDES.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={cn(
                    "w-2 h-2 rounded-full transition-colors",
                    i === index ? "bg-accent" : "bg-muted-foreground/40 hover:bg-muted-foreground/60"
                  )}
                  aria-label={`Go to slide ${i + 1}`}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={goNext}
              className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors"
              aria-label="Next slide"
            >
              Next <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-border flex justify-center">
        <Link href="/" className="font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">
          ← Home
        </Link>
      </div>
    </main>
  )
}
