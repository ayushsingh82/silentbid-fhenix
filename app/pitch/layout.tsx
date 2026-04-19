import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Pitch — SilentBid",
  description: "SilentBid pitch: commitment, problem, solution, and how we're building privacy-first sealed-bid token launches on Chainlink CRE.",
}

export default function PitchLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
