"use client"

import { useRef, useEffect } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

const workflows = [
  {
    step: "01",
    name: "Bid Ingestion",
    route: "/api/cre/bid",
    offchain: "Verify EIP-712 signature, compute keccak256 commitment, store bid privately. Optional compliance check via Confidential HTTP.",
    onchain: "submitBlindBid(commitment) + msg.value escrow. Only the hash touches the chain.",
    accent: "accent",
  },
  {
    step: "02",
    name: "Finalize",
    route: "/api/cre/finalize",
    offchain: "Load all sealed bids, run uniform-price discovery (sort by maxPrice desc), compute clearing price and winner allocations.",
    onchain: "forwardBidsToCCA(clearingPrice, bids) — one batched transaction forwards all bids into CCA.",
    accent: "amber-500",
  },
  {
    step: "03",
    name: "Settle",
    route: "/api/cre/settle",
    offchain: "Build settlement plan from allocations: winner payouts, excess-escrow refunds, loser full refunds.",
    onchain: "Execute transfers via compliant private calls. Individual payouts stay confidential.",
    accent: "emerald-500",
  },
]

export function CreSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !headerRef.current || !cardsRef.current) return

    const ctx = gsap.context(() => {
      gsap.from(headerRef.current, {
        x: -60,
        opacity: 0,
        duration: 1,
        ease: "power3.out",
        scrollTrigger: {
          trigger: headerRef.current,
          start: "top 85%",
          toggleActions: "play none none reverse",
        },
      })

      const cards = cardsRef.current?.querySelectorAll(":scope > div")
      if (cards) {
        gsap.from(cards, {
          y: 60,
          opacity: 0,
          duration: 0.8,
          stagger: 0.15,
          ease: "power3.out",
          scrollTrigger: {
            trigger: cardsRef.current,
            start: "top 90%",
            toggleActions: "play none none reverse",
          },
        })
      }
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} id="cre" className="relative py-32 pl-6 md:pl-28 pr-6 md:pr-12">
      {/* Section header */}
      <div ref={headerRef} className="mb-16 flex items-end justify-between">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">
            03 / Chainlink CRE
          </span>
          <h2 className="mt-4 font-[var(--font-bebas)] text-5xl md:text-7xl tracking-tight">
            CRE WORKFLOWS
          </h2>
        </div>
        <p className="hidden md:block max-w-xs font-mono text-xs text-muted-foreground text-right leading-relaxed">
          Three offchain workflows keep bid data private. Only commitments and settlement results touch the chain.
        </p>
      </div>

      {/* Workflow cards */}
      <div ref={cardsRef} className="grid gap-6 md:grid-cols-3">
        {workflows.map((wf) => (
          <div
            key={wf.step}
            className="group relative border border-border/40 p-6 md:p-8 flex flex-col gap-6 hover:border-accent/60 transition-all duration-500"
          >
            {/* Step number + name */}
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Step {wf.step}
              </span>
              <h3 className="mt-2 font-[var(--font-bebas)] text-3xl md:text-4xl tracking-tight group-hover:text-accent transition-colors duration-300">
                {wf.name}
              </h3>
              <code className="mt-1 block font-mono text-[11px] text-accent/80">
                {wf.route}
              </code>
            </div>

            {/* Offchain */}
            <div>
              <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground">
                Offchain (CRE)
              </span>
              <p className="mt-2 font-mono text-xs text-muted-foreground leading-relaxed">
                {wf.offchain}
              </p>
            </div>

            {/* Onchain */}
            <div>
              <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground">
                Onchain
              </span>
              <p className="mt-2 font-mono text-xs text-foreground/80 leading-relaxed">
                {wf.onchain}
              </p>
            </div>

            {/* Corner accent */}
            <div className="absolute top-0 right-0 w-10 h-10 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <div className="absolute top-0 right-0 w-full h-[1px] bg-accent" />
              <div className="absolute top-0 right-0 w-[1px] h-full bg-accent" />
            </div>
          </div>
        ))}
      </div>

      {/* Summary bar */}
      <div className="mt-12 border border-border/30 p-6 flex flex-col md:flex-row md:items-center gap-4 md:gap-8">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-accent shrink-0">
          Key point
        </span>
        <p className="font-mono text-xs text-muted-foreground leading-relaxed">
          Sensitive data (bid prices, amounts, identities, payout details) is handled only in CRE workflows.
          The chain sees only commitments and the batched forward / settlement results.
          In production, CRE + Confidential HTTP ensures API keys and bid data never appear onchain or in public logs.
        </p>
      </div>
    </section>
  )
}
