# Wave 5: Off-Chain Keeper + Progressive Settlement UX

Wave 5 replaces the browser-driven `useAuctionAutomation` loop with a
standalone Node keeper service, redeploys the auction contract with a
verified source on BaseScan, and ships a live settlement progress card
in the UI. End result: **bidders never see a wallet signature for
settlement** and auctions self-settle within ~45-90s of `endTime`
without any tab being open.

---

## What shipped

### 1. Standalone keeper service (`relayer/`)

A small Node HTTP service that owns the keeper EOA and runs the
settlement state machine off-chain. Two trigger paths feed into the
same idempotent code path:

- **Chain-poll loop** (primary) — every 5 s the keeper reads
  `nextAuctionId` and each unfinalized auction's state, then fires
  `processAuction` the moment `chainNow >= endTime`. No third-party
  scheduler required, no `endTime + 30 s` slack to wait through.
- **HTTP `GET /api/cron/finalize[?auctionId=N]`** (backstop) — bearer-
  auth'd endpoint that drives a single auction or sweeps all of them.
  cron-job.org still hits this after auction creation as a defence-in-
  depth backup; if the poll loop already settled the auction it returns
  `skip-finalized`.

Layout:

```
relayer/
  package.json         # viem, @cofhe/sdk, tsx; npm start
  tsconfig.json
  src/
    abi.ts             # AUCTION_ABI subset + AuctionData type
    keeper.ts          # state machine: endAuction → decrypt → finalize
    server.ts          # HTTP routes + background poll loop
```

The keeper EOA (`0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7`), auction
address (`0x2e396E1f8Bba845a6dAF481099452B360b8b26DE`), and RPC URL are
hardcoded in `relayer/src/server.ts` — there is no per-environment
config drift.

### 2. State machine (`relayer/src/keeper.ts`)

Single `processAuction(id, ctx, chainNow)` chains both transitions
inside one call, with idempotency rooted in chain state:

```
finalized                                  → skip-finalized
ended && numBids == 0                      → skip-no-bids   (terminal)
ended && numBids  > 0                      → decrypt → finalizeAuction
chainNow < endTime                         → skip-live
chainNow >= endTime && !ended              → endAuction → re-read → decrypt → finalize
```

Optimisations applied in this wave:

- **Parallel CoFHE decrypts.** `decryptForTx(winnerHandle)` and
  `decryptForTx(amountHandle)` run via `Promise.all`. Both handles are
  flagged `allowPublic` in the same `endAuction` tx so the threshold
  network indexes them together — parallelising saves the slower-of-
  the-two's worth of wall time.
- **Fire-and-forget `endAuction`.** Submit the tx and immediately move
  to the decrypt step instead of waiting for the receipt. The CoFHE
  threshold network watches chain events directly, so it sees
  `allowPublic` as soon as the tx mines; the SDK's internal decrypt
  polling overlaps with the tx confirmation. Net: ~5-10 s saved per
  auction.
- **Distinct success / error action labels.** `finalizeAuction` is
  reported only on a confirmed tx hash; non-404 errors return
  `finalize-error`, and CoFHE indexing 404s return
  `skip-pending-oracle`. The poll loop only adds an auction to its
  `settled` set on real success, so transient errors are retried on
  the next tick instead of being silently parked.

### 3. Verified V2 contract deployment

`SilentBidAuction` was redeployed at
[`0x2e396E1f8Bba845a6dAF481099452B360b8b26DE`](https://sepolia.basescan.org/address/0x2e396E1f8Bba845a6dAF481099452B360b8b26DE#code)
reusing the existing `cUSDC` and `Treasury` (one `treasury.authorizeContract(newAuction)` call).
Verified on BaseScan + Sourcify with the source committed in
`contracts/contracts/SilentBidAuction.sol`, so the BaseScan "Contract"
tab now shows the full ABI and source.

A one-shot helper script (`contracts/scripts/redeploy-auction.ts`) does
the deploy + Treasury authorisation in one step; `e2e-no-batteries.ts`
runs a full create → bid → auto-settle → assert-winner end-to-end check
against the live deployment without depending on the hardhat-cofhe
plugin's mock infrastructure.

### 4. Frontend changes

- **`lib/use-auction-automation.ts` deleted.** All in-browser
  endAuction / decrypt / finalize logic is gone. Bidders place bids
  and never see a settlement signature prompt.
- **`app/auctions/[id]/page.tsx`** no longer renders the
  `⚙️ Auto-Settling` banner or passes `automationStatus` to the reveal
  panel.
- **`app/auctions/[id]/reveal-panel.tsx`** drops the manual "End
  auction" / "Finalize" buttons and the gas-pool hint. The settlement
  region now renders a `<SettlementProgress>` card that mirrors the
  keeper's actual phases:

  ```
  AUTOMATIC SETTLEMENT IN PROGRESS         45s elapsed · ~15s left

  ✓  End auction
  ⟳  CoFHE oracle decrypting winner
     Threshold network running MPC + signing plaintext (~30-45s)
  ○  Publish winner + settle bids

  Keeper EOA: 0xf43F…4Cf7 · no wallet signature required.
  ```

  Step states are derived from `auction.ended`, `auction.finalized`,
  and `auction.numBids` and refresh once per second. No-bid auctions
  render a distinct "auction void" terminal card instead of being
  stuck in "settling" forever. The active step animates so the wait
  visually reads as work-in-progress rather than a hang.

### 5. CoFHE permit auto-refresh (`lib/cofhe.ts`)

The CoFHE SDK's `getOrCreateSelfPermit()` replays a cached self-permit
without checking expiry; once the permit expires (default ~24 h) every
`decryptForView` call ships the dead permit and the threshold network
rejects it. Two changes fix this transparently:

- `ensureCofheInit` reads the active permit and, if
  `permit.expiration < now`, calls `removeActivePermit(...)` before
  `getOrCreateSelfPermit()`. Re-prompts the wallet for a fresh EIP-712
  signature without the user having to know why.
- `decryptForView` catches the SDK's `"Permit is expired"` throw, runs
  `ensureCofheInit` again with the cached `publicClient` /
  `walletClient`, and retries the decrypt once. So clicking **Unseal**
  on a stale permit pops a signature prompt, the user signs, and the
  unseal completes — no second click required.

### 6. Scheduler hardcoded for zero-config deploy

`app/api/scheduler/route.ts` no longer reads `CRONJOBORGAPIKEY`,
`CRON_SECRET`, or `RELAYER_URL` from `process.env`. All three are
constants in the route source, so the production deploy works without
per-environment configuration.

---

## End-to-end timing

| Step | Time | Notes |
|------|------|-------|
| Keeper detects expiry | ~5 s | 5 s chain-poll interval |
| `endAuction` tx submitted | ~2-5 s | fire-and-forget, no receipt wait |
| CoFHE threshold network: index `allowPublic` + MPC + sign plaintext | **~30-60 s** | hard floor, off-chain MPC work |
| `finalizeAuction` tx mined | ~5 s | verified threshold signatures |
| Total wall time from `endTime` | **~45-90 s** | dominated by CoFHE oracle |

The CoFHE oracle's MPC + signing step is the hard floor: no relayer-
side optimisation can make the threshold network sign faster.

---

## Files touched

```
app/api/scheduler/route.ts                  # hardcoded RELAYER_URL + CRONJOB_API_KEY + CRON_SECRET
app/auctions/[id]/page.tsx                  # removed useAuctionAutomation + status banner
app/auctions/[id]/reveal-panel.tsx          # dropped manual buttons, added SettlementProgress
lib/cofhe.ts                                # permit expiry eviction + decryptForView retry
lib/fhenix-contracts.ts                     # AUCTION_ADDRESS bumped to V2 redeploy
lib/scheduler.ts                            # single cron job per auction
lib/use-auction-automation.ts               # DELETED
contracts/hardhat.config.ts                 # BaseScan API key
contracts/scripts/redeploy-auction.ts       # NEW — auction-only redeploy + treasury auth
contracts/scripts/e2e-no-batteries.ts       # NEW — live-network e2e using @cofhe/sdk directly
relayer/                                    # NEW — standalone keeper service
.env.local                                  # AUCTION address bumped to V2
README.md                                   # auction address + verified link
```
