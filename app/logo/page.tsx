import Link from "next/link"

export default function LogoPage() {
  return (
    <main className="min-h-screen w-full flex flex-col items-center justify-center bg-background text-foreground p-8">
      <div className="flex flex-col items-center justify-center gap-8">
        <span className="flex items-center justify-center w-64 h-64 sm:w-80 sm:h-80 md:w-96 md:h-96 border-2 border-current text-muted-foreground">
          <svg
            width="80%"
            height="80%"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="shrink-0"
            aria-hidden
          >
            <path
              d="M16 4c0 0 10 6 10 14c0 6.5-4.5 10-10 10s-10-3.5-10-10C6 10 16 4 16 4Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="16" cy="14" r="4.5" fill="currentColor" />
            <path
              d="M14 11.5a2.5 2.5 0 0 1 4 0v.8h-1v-.8a1.5 1.5 0 0 0-2 0v.8h-1v-.8zm.5 1.2h3v1.6a1.4 1.4 0 0 1-2.8 0v-1.6h-.2z"
              fill="var(--background)"
            />
          </svg>
        </span>
        <span className="font-[var(--font-bebas)] text-6xl sm:text-7xl md:text-8xl tracking-tight text-foreground">
          SilentBid
        </span>
        <p className="font-mono text-sm text-muted-foreground">Privacy-Focused CCA · Sealed-Bid Launches</p>
      </div>
      <Link
        href="/"
        className="mt-12 font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors"
      >
        ← Home
      </Link>
    </main>
  )
}
