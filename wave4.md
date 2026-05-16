# Wave 4: Full Chainlink Automation Integration

> **Current state:** Backend settlement service (Option A below) is now implemented as a port of the ZAMA approach: cron-job.org one-shots ping `/api/cron/finalize?auctionId=N`, which drives the chain state machine (`endAuction` → CoFHE `decryptForTx` → `finalizeAuction`) without requiring the browser tab to stay open. Frontend automation hook (`useAuctionAutomation`) is retained as a manual/fallback override.
>
> **What ships today (no Chainlink required):**
> - `lib/scheduler.ts` — cron-job.org REST client, registers one-shots at endTime+30s and endTime+90s.
> - `app/api/scheduler/route.ts` — POST endpoint called by the create-auction form; re-reads chain state, never trusts client-supplied timing.
> - `app/api/cron/finalize/route.ts` — GET endpoint that runs one transition per call using `@cofhe/sdk/node` for `decryptForTx` + signed plaintext.
> - Required env: `CRONJOBORGAPIKEY`, `CRON_SECRET`, `KEEPER_PRIVATE_KEY`, `KEEPER_URL` (or auto-resolved on Vercel), `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` (optional).
>
> **Still optional (Wave 4 stretch):** Wrap `SilentBidAutomationKeeper` with `AutomationCompatibleInterface` and register on Chainlink Automation. The cron approach above is the ZAMA-equivalent MVP and removes the "page must stay open" limitation that motivated this wave.
>
> **Wave 4 stretch goal:** Replace the cron-job.org backend with fully managed on-chain settlement via Chainlink Automation.

---

## Current Implementation (Frontend-Based)

### What Works Today
- `useAuctionAutomation` hook runs every 30 seconds on auction detail page
- Automatically calls `endAuction()` when block.timestamp >= endTime
- Calls `client.decryptForTx()` to get signed plaintext from CoFHE oracle
- Calls `finalizeAuction()` with decrypted winner + amount
- Retries on failure (5-second backoff)
- Visual status: "Checking..." → "Auto-Settling..." → "Settled!"

### Limitations
- **Page must stay open** — if user closes tab, settlement pauses
- **No persistence** — if page refreshes mid-settlement, may need manual retry
- **User bears gas cost** — settlement gas comes from user's transaction
- **Timing drift** — 30-second poll interval may miss tight deadlines
- **Mobile-unfriendly** — can't rely on browser on mobile for settlement

---

## Wave 4 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Chainlink Automation Network (Base Sepolia)                 │
│                                                              │
│  Registry monitors: SilentBidAutomationKeeper.checkUpkeep()  │
│       every 12 seconds                                       │
│                                                              │
│  When checkUpkeep() returns true:                            │
│    1. Keeper calls performUpkeepEndAuction(auctionId)       │
│    2. Auction is marked ended, decryption requested         │
│    3. Backend listens for AuctionEnded event                │
│    4. Backend calls CoFHE for decrypted values              │
│    5. Backend calls performUpkeepFinalize(...decrypted...)  │
│    6. Chainlink pays gas fees from LINK deposit             │
│                                                              │
│  Settlement happens **without user involvement**            │
└──────────────────────────────────────────────────────────────┘
```

---

## Components to Build

### 1. Full AutomationCompatible Keeper

Current keeper is simplified. Wave 4 upgrades to:

```solidity
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

contract SilentBidAutomationKeeper is AutomationCompatibleInterface {
    // Returns (upkeepNeeded, performData)
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        // Scan all auctions
        // Return first that needs settlement
    }

    // Called by Chainlink Automation Network
    function performUpkeep(bytes calldata performData)
        external
        override
    {
        // Decode which auction + action
        // Execute settlement
        // Emit event for backend to listen
    }
}
```

**Benefits:**
- Chainlink Registry calls it every 12 seconds (not 30)
- Chainlink pays gas fees directly
- Runs on-chain, not dependent on frontend

---

### 2. Backend Settlement Service

Node.js service that listens to keeper events and handles decryption:

```typescript
// Pseudo-code
keeper.on('AuctionEnded', async (auctionId) => {
  // Wait ~5s for CoFHE to post signature
  const decrypted = await coFheClient.decryptForTx(handle);
  
  // Submit finalization with decrypted values
  await keeper.performUpkeepFinalize(
    auctionId,
    decrypted.winner,
    decrypted.amount,
    decrypted.winnerSig,
    decrypted.amountSig
  );
});
```

**Why separate service?**
- CoFHE decryption is async (~25s) and requires off-chain CoFHE oracle calls
- Keeper can't wait in `checkUpkeep()` (gas limit, no HTTP)
- Backend acts as intermediary: listens → decrypts → submits

---

### 3. Chainlink Functions Integration (Optional)

Alternatively, use Chainlink Functions (if Base Sepolia support available):

```solidity
function performUpkeep(bytes calldata performData) external override {
    // Trigger Chainlink Functions
    // Custom code decrypts from CoFHE
    // Callback calls finalizeAuction()
}
```

**Trade-off:**
- No separate backend service needed
- Higher Chainlink fees
- Need Functions subscription

---

## Decryption Flow Options

### Option A: Backend Service (Recommended for MVP)
```
Keeper.performUpkeepEndAuction()
  → emits AuctionEnded(auctionId)
Backend listens, calls coFheClient.decryptForTx()
  → gets signed plaintext from CoFHE oracle
Backend calls Keeper.performUpkeepFinalize(...decrypted...)
  → settlement complete
```

**Pros:** Simple, no new dependencies, MVP-ready
**Cons:** Requires 24/7 backend service

---

### Option B: Chainlink Functions
```
Keeper.performUpkeep()
  → calls Chainlink Functions
Functions runs custom code to decrypt
Functions callback invokes finalizeAuction()
```

**Pros:** Fully decentralized, no backend
**Cons:** Higher fees, requires Chainlink Functions availability

---

### Option C: Hybrid (Long-term)
```
Keeper.performUpkeepEndAuction()
  → emits AuctionEnded(auctionId)
Multiple backends compete to submit finalization
  → first one wins, earns gas subsidy
```

**Pros:** Decentralized + incentivized
**Cons:** Complex, need slashing if bad submissions

---

## Integration Checklist

- [ ] Deploy full `AutomationCompatibleInterface` keeper
- [ ] Register keeper with Chainlink Automation Registry (Base Sepolia)
- [ ] Fund keeper with LINK (estimate: 0.1–1 LINK per auction)
- [ ] Implement backend service (listen → decrypt → submit)
- [ ] Test end-to-end: auction creation → auto-settlement
- [ ] Monitor Chainlink automation logs
- [ ] Remove `useAuctionAutomation` from frontend (but keep for manual override)
- [ ] Deploy backend as systemd/docker service
- [ ] Set up alerts if settlements fail

---

## Migration Plan

### Phase 1: Deploy & Test
1. Deploy keeper with `AutomationCompatibleInterface`
2. Deploy backend service to staging
3. Test with dummy auctions (no real bids)
4. Monitor for 1 week

### Phase 2: Parallel Run
1. Keep frontend automation running
2. Enable Chainlink automation in parallel
3. Observe both settle same auction (redundancy)
4. Monitor gas costs

### Phase 3: Cutover
1. Disable frontend automation on auctions created after timestamp X
2. Keep manual "End" / "Finalize" buttons for emergency
3. Monitor for 2 weeks
4. Remove button if stable

---

## Gas Cost Estimates (Base Sepolia)

| Operation | Gas | Est. Cost (LINK @ $20/LINK) |
|-----------|-----|---------------------------|
| `checkUpkeep()` scan | 50k–100k | $0.10–$0.20 |
| `endAuction()` | 200k–400k | $0.40–$0.80 |
| `finalizeAuction()` | 300k–600k | $0.60–$1.20 |
| **Total per auction** | **550k–1.1M** | **$1.10–$2.20** |

**Chainlink automation fee:** 0.2 LINK per upkeep (Base Sepolia)

**Recommendation:** Keeper deposit = 5 LINK (~$100) to handle 20–50 auctions

---

## Frontend Changes (Minimal)

### Keep
- `useAuctionAutomation` hook (manual override)
- Manual "End Auction" button (emergency)
- Manual "Finalize" button (emergency)
- Status display ("Settled!", "Waiting for Chainlink...", etc.)

### Remove/Deprecate
- Auto-trigger of settlement on page load
- 30-second polling (Chainlink does this better)
- Frontend gas cost warnings (Chainlink covers fees)

### New
- "Chainlink Status: Active / Pending / Failed" indicator
- Link to Chainlink automation dashboard
- Backend status page (optional)

---

## Testing (Wave 4)

### Unit Tests
```solidity
// Test checkUpkeep returns correct auction
// Test performUpkeep changes state correctly
// Test event emissions for backend to catch
```

### Integration Tests
```typescript
// Keeper detects expired auction
// Backend listens and decrypts
// finalizeAuction() succeeds atomically
// All bids settled, treasury gets fee
```

### E2E (Staging)
```
1. Create auction with 1 hour duration
2. Wait for expiry
3. Observe Chainlink call endAuction()
4. Observe backend submit decrypted values
5. Confirm settlement on-chain
6. Verify winner/loser balances
```

---

## Success Criteria

- [ ] Auction settles automatically within 2 minutes of `endTime`
- [ ] No frontend page open required
- [ ] No manual user intervention needed
- [ ] All bids settled atomically
- [ ] Platform fee collected to Treasury
- [ ] Chainlink automation shows "Performed" in logs
- [ ] Zero failed settlements in 1-week test period
- [ ] Gas cost under $2.50 per auction

---

## Open Questions for Wave 4

1. **Decryption latency:** CoFHE oracle takes ~25s to post signed plaintext. How to handle this?
   - Option A: Backend polls until available (simple)
   - Option B: Backend subscribes to oracle event (complex)

2. **Multiple backends:** What if 2 backends both submit `finalizeAuction()`?
   - Option A: First wins, second reverts (current logic)
   - Option B: All-pay auction (incentive design)

3. **Mainnet readiness:** Current keeper is Base Sepolia-only. Mainnet needs:
   - Different LINK token
   - Different Automation Registry address
   - Higher gas requirements
   - Should we abstract this into factory?

4. **Auction batching:** Can we settle multiple auctions in one Chainlink call?
   - Pro: Lower Chainlink fee per auction
   - Con: Complex dependency tracking

5. **Emergency shutdown:** How to pause Chainlink if critical bug found?
   - Option A: Admin function to pause keeper
   - Option B: Manual disable in Chainlink Registry UI

---

## References

- [Chainlink Automation Docs](https://docs.chain.link/chainlink-automation/introduction)
- [AutomationCompatibleInterface](https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/automation/AutomationCompatible.sol)
- [Chainlink Base Sepolia Addresses](https://docs.chain.link/chainlink-automation/supported-networks)
- [Keeper Network Pricing](https://docs.chain.link/chainlink-automation/overview/supported-networks#base)
