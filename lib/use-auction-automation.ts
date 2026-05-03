"use client"

import { useCallback, useEffect, useState } from "react"
import { usePublicClient, useWalletClient } from "wagmi"
import { type Address } from "viem"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  type AuctionData,
} from "@/lib/fhenix-contracts"
import { chainId } from "@/lib/chain-config"
import { ensureCofheInit, decryptForTx, getFheTypes } from "@/lib/cofhe"

interface AutomationStatus {
  status: "idle" | "checking" | "settling" | "error"
  message: string
  lastCheck?: number
}

/**
 * Hook to automatically end and settle auctions when:
 * 1. Current time >= auction end time
 * 2. Auction has bids
 * 3. Auction is not yet finalized
 */
export function useAuctionAutomation(auctionId: bigint | null) {
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()
  const [automationStatus, setAutomationStatus] = useState<AutomationStatus>({
    status: "idle",
    message: "Waiting for auction end...",
  })

  const checkAndSettle = useCallback(async () => {
    if (!publicClient || !walletClient || !auctionId || !AUCTION_ADDRESS) return

    try {
      setAutomationStatus({ status: "checking", message: "Checking auction status..." })

      // Get current auction state
      const auction = (await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "getAuction",
        args: [auctionId],
      })) as AuctionData

      const now = Math.floor(Date.now() / 1000)
      const timeUntilEnd = Number(auction.endTime) - now

      // Not ended yet
      if (timeUntilEnd > 0) {
        setAutomationStatus({
          status: "idle",
          message: `Auction ends in ~${Math.round(timeUntilEnd / 60)}m`,
          lastCheck: now,
        })
        return
      }

      // Already finalized
      if (auction.finalized) {
        setAutomationStatus({
          status: "idle",
          message: "Auction finalized ✓",
          lastCheck: now,
        })
        return
      }

      // End the auction if not already ended
      if (!auction.ended) {
        setAutomationStatus({ status: "settling", message: "Ending auction..." })
        try {
          await walletClient.writeContract({
            address: AUCTION_ADDRESS,
            abi: AUCTION_ABI,
            functionName: "endAuction",
            args: [auctionId],
          })
          setAutomationStatus({ status: "settling", message: "Waiting for endAuction confirmation..." })
          await new Promise((r) => setTimeout(r, 2000)) // Wait for confirmation
        } catch (err) {
          console.log("EndAuction already called or failed:", err)
        }
      }

      // Now finalize
      setAutomationStatus({ status: "settling", message: "Finalizing auction and settling bids..." })

      await ensureCofheInit(publicClient as never, walletClient)

      // Decrypt the winner address
      const winnerResult = await decryptForTx(
        `0x${auction.highestBidderHandle.slice(2)}`
      )
      const winnerDecrypted = (typeof winnerResult === "string" ? winnerResult : winnerResult?.toString?.() || "") as Address
      
      // Decrypt the winning amount
      const amountResult = await decryptForTx(
        `0x${auction.highestBidHandle.slice(2)}`
      )
      
      // Extract numeric value from result
      let amountValue: bigint
      if (typeof amountResult === "bigint") {
        amountValue = amountResult
      } else if (typeof amountResult === "number") {
        amountValue = BigInt(amountResult)
      } else if (typeof amountResult === "string") {
        amountValue = BigInt(amountResult)
      } else if (amountResult && typeof amountResult === "object") {
        // Handle CoFHE SDK return object - try common property names
        const numValue = (amountResult as any).value ?? (amountResult as any).amount ?? (amountResult as any).result ?? amountResult
        amountValue = typeof numValue === "bigint" ? numValue : BigInt(String(numValue))
      } else {
        amountValue = BigInt(String(amountResult))
      }

      // Call finalizeAuction
      await walletClient.writeContract({
        address: AUCTION_ADDRESS || ("0x" as Address),
        abi: AUCTION_ABI,
        functionName: "finalizeAuction",
        args: [
          auctionId,
          winnerDecrypted,
          amountValue,
          "0x",// winnerSig
          "0x", // amountSig
        ],
      })

      setAutomationStatus({
        status: "idle",
        message: "Auction settled automatically",
        lastCheck: now,
      })
    } catch (err) {
      console.error("Automation error:", err)
      const errorMsg = err instanceof Error ? err.message : "Automation error"
      
      setAutomationStatus({
        status: "error",
        message: `Settlement failed: ${errorMsg}. Retrying...`,
        lastCheck: Math.floor(Date.now() / 1000),
      })
      
      // Retry in 5 seconds on error
      setTimeout(() => {
        checkAndSettle()
      }, 5000)
    }
  }, [publicClient, walletClient, auctionId])

  // Check every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      checkAndSettle()
    }, 30_000)

    // Also check immediately
    checkAndSettle()

    return () => clearInterval(interval)
  }, [checkAndSettle])

  return automationStatus
}
