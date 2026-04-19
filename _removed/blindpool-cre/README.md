# SilentBid CRE Workflows

Chainlink Runtime Environment (CRE) workflows for SilentBid sealed-bid auctions. Aligns with **plan_execution.md** and uses patterns from **conf-http-demo** (Confidential HTTP, triggers) and **Compliant-Private-Transfer-Demo** (EIP-712 signing, API payloads).

## CRE CLI

Ensure CRE CLI is installed and (for deploy) logged in:

```bash
cre --help
cre login   # required for deploy; simulate can run without login with --non-interactive
```

## Project layout

- **project.yaml** — RPC targets (Sepolia).
- **secrets.yaml** — Maps DON secret names to env vars (e.g. `CRE_ETH_PRIVATE_KEY`).
- **workflows/bid-ingestion** — POST /cre/bid: accept EIP-712 signed bid, verify, compute commitment, return for SilentBid `BlindPoolCCA.submitBlindBid(commitment)`.
- **workflows/finalize** — POST /cre/finalize: loads bids, runs uniform-price discovery, computes clearing price, and returns calldata for `forwardBidsToCCA`.

## Bid ingestion workflow

1. **Input (HTTP body)**  
   Same shape as Compliant-Private-Transfer-Demo: `sender`, `auctionId`, `maxPrice`, `amount`, `flags[]`, `timestamp`, `auth` (EIP-712 signature).

2. **Steps**  
   - Decode JSON.  
   - Verify EIP-712 (SilentBid bid type); skip if `auth` is placeholder (simulation).  
   - Compute `commitment = keccak256(encodePacked(auctionId, sender, maxPrice, amount, timestamp))`.  
   - Optional: call compliance API via Confidential HTTP (when `config.complianceApiUrl` set).  
   - Return `{ commitment, sender, auctionId, amount }` so the frontend or relayer can call SilentBid `BlindPoolCCA.submitBlindBid(commitment)` with `value: amount`.

3. **Simulate (from repo root)**  
   From **silentbid-cre** (or blindpool-cre) project root:

   ```bash
   cd blindpool-cre
   bun install   # in workflows/bid-ingestion if needed
   cre workflow simulate ./workflows/bid-ingestion --target=staging-settings \
     --http-payload ./workflows/bid-ingestion/http-payload.example.json \
     --non-interactive --trigger-index 0
   ```

   If CRE prompts for login, run `cre login` once, then re-run the above.

## Finalize workflow

Loads all stored bids for the auction, runs uniform-price discovery (sort by maxPrice desc, clearing price = lowest winning bid), and returns the clearing price, winning bids, and calldata hash for `forwardBidsToCCA`. The Next.js API route (`/api/cre/finalize`) implements this fully; the CRE workflow version calls the same logic via Confidential HTTP.

Simulate:

```bash
cre workflow simulate ./workflows/finalize --target=staging-settings \
  --http-payload '{"auctionId":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"}' \
  --non-interactive --trigger-index 0
```

## Config

- **workflows/bid-ingestion/config.*.json** — `chainId`, EIP-712 domain (`silentBidDomainName`, `verifyingContract`), optional `complianceApiUrl` / `complianceApiKeyOwner` for Confidential HTTP.
- **workflows/finalize/config.*.json** — `silentBidAddress`, `rpcUrl`.

## References

- [CRE docs](https://docs.chain.link/cre)
- **SilentBid/plan_execution.md** — Bid ingestion / finalize / settle specs
- **SilentBid/md/CRE_INTEGRATION.md** — Onchain commitment format and frontend flow
- **Compliant-Private-Transfer-Demo** — EIP-712 + POST /private-transfer
- **conf-http-demo** — Confidential HTTP, Cron/HTTP triggers, project layout
