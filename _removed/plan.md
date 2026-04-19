## SilentBid Privacy Migration Plan (Chainlink CRE Confidential HTTP)

This document outlines how we will move SilentBid away from the previous Zama fhEVM approach and instead use **Chainlink Confidential Compute + CRE Confidential HTTP** and the **Compliant Private Transfer** / Confidential HTTP demos to power private, compliant auctions.

### High‑level goal

Keep the **CCA + sealed‑bid auction UX** exactly the same for users, but:

- All sensitive parts (who bid what, internal transfers, compliance checks) run **offchain in a CRE workflow**.
- Onchain SilentBid / CCA contracts only see the minimum public data needed to enforce settlement and final clearing price.

### Components we will reuse

- **SilentBid / BlindPool‑scripts**
  - Existing CCA deployment + auction scripts (Foundry).
  - SilentBid wrapper contracts that sit on top of Uniswap CCA.
- **Compliant‑Private‑Transfer‑Demo**
  - `api-scripts/src/private-transfer.ts` and related helpers (`common.ts`, `transactions.ts`, etc.) show how to:
    - Sign EIP‑712 payloads for a private transfer.
    - Send them to a backend endpoint (`/private-transfer`) instead of doing a direct onchain transfer.
    - Let the backend / CRE workflow decide how and when to execute the actual onchain movement.
- **Confidential HTTP demo (CRE)**
  - CRE workflow + CLI flow for:
    - Storing API credentials and secrets in CRE.
    - Making HTTPS calls (e.g., to our auction / policy / compliance backend) without exposing keys or payloads onchain.
    - Orchestrating multi‑step workflows (fetch data -> run checks -> trigger onchain transactions).

### Target architecture (auction + CRE)

1. **Bid submission (user → front‑end → CRE)**
   - User connects wallet in the SilentBid app.
   - Instead of sending a raw bid transaction with full parameters onchain:
     - The front‑end creates an EIP‑712 message representing the bid (similar to `private-transfer.ts`):
       - fields: `sender`, `auctionId`, `maxPrice`, `amount`, `timestamp`, `flags` (e.g., KYC tier, jurisdiction tags).
     - User signs this typed data.
     - The app sends the signed message to a **CRE workflow endpoint** exposed via Confidential HTTP (no keys or sensitive fields are onchain).
   - CRE workflow:
     - Verifies the signature, timestamps, flags, and any compliance logic (can call external APIs privately via Confidential HTTP).
     - Stores the bid offchain in its private data store (or an attached database).
     - Optionally sends a minimal onchain transaction:
       - e.g., deposit ETH / tokens into a vault or escrow contract, tagged with a pseudo‑ID that the workflow can map back to the sealed bid.

2. **During the auction**
   - Onchain state:
     - CCA auction contract tracks total committed liquidity and schedule as usual.
     - SilentBid wrapper may only see:
       - A running commitment amount.
       - A count of sealed bids (not per‑bid details).
   - Offchain / CRE state:
     - Full bid book (prices, amounts, identities, compliance status) is **only** in the CRE workflow / private DB.
     - Any intermediate compliance checks, API calls, or scoring are done via Confidential HTTP, invisible onchain.

3. **Auction close and price discovery**

We have two design options (to be decided after prototyping):

- **Option A – Offchain price discovery in CRE**
  - At auction close, the CRE workflow:
    - Reads all sealed bids from its private store.
    - Computes the clearing price and allocations completely offchain.
    - Sends a single onchain transaction to:
      - Update the CCA / SilentBid contracts with:
        - final clearing price,
        - total amount raised,
        - aggregate allocation commitments.
    - Per‑user allocations remain offchain; only aggregates and final price are public.

- **Option B – Hybrid (offchain preprocessing, onchain final check)**
  - CRE workflow:
    - Computes a proposed clearing price and a list of winning bids.
    - Sends a transaction that:
      - Provides the list of winners + allocations to the SilentBid contract.
      - Contract re‑validates a subset or minimal invariants onchain (e.g., totals, monotonicity, bounds) to prevent obvious cheating.

In both options, **no raw per‑bid data is ever public before close**, and even after close we can keep individual bids private while still publishing a verifiable clearing price.

4. **Settlement and private transfers**

For users, settlement should look like standard CCA:

- Winners can claim tokens; issuers receive proceeds.
- Losers can withdraw unused funds.

Implementation sketch:

- Use the **Compliant‑Private‑Transfer‑Demo** style flow for:
  - Moving funds from a compliant private vault / treasury to the issuer or to users.
  - Executing payouts via an API / CRE workflow that holds keys and rules, not via user‑managed direct transfers.
- CRE workflow:
  - Coordinates:
    - Transfers from a policy‑controlled vault contract (e.g., using a Policy Engine pattern).
    - Onchain interactions with the CCA / SilentBid contracts.
  - Ensures all movements are:
    - Logged privately,
    - Compliant with configured rules (jurisdictions, limits, sanctions checks, etc.),
    - Executed via Confidential HTTP, with API credentials hidden from chain and logs.

### Changes we will make in SilentBid repos

#### 1. Documentation cleanup (this step)

- Remove references to **Zama fhEVM**, fhEVM contracts, and the Zama relayer SDK from:
  - `BlindPool-scripts/README.md` (done in this iteration).
  - Any other docs mentioning FHE‑specific build steps or addresses.
- Update descriptions to say:
  - Privacy is provided via **Chainlink Confidential Compute** and **CRE Confidential HTTP**,
  - Sealed bids and private transfers are orchestrated offchain by CRE workflows.

#### 2. Contract surface review (next step)

- Audit the existing SilentBid / CCA‑wrapper contracts to identify:
  - Where bids are currently assumed to be onchain public structs.
  - Which pieces must remain onchain for fairness and verification.
- Introduce minimal hooks for CRE:
  - e.g., functions for:
    - Committing aggregate bid data.
    - Finalizing an auction with an externally‑computed clearing price.
    - Linking onchain deposits / withdrawals to offchain bid IDs.

#### 3. CRE workflow design

- Define one or more **CRE Workflow** specs:
  - **Bid Ingestion Workflow**
    - Input: signed EIP‑712 bid.
    - External calls: KYC / compliance APIs, databases.
    - Output: stored sealed bid + optional onchain deposit transaction.
  - **Auction Finalization Workflow**
    - Input: auction ID, close signal (time or manual).
    - External calls: DB / bid store, optional analytics.
    - Output: onchain transaction to SilentBid / CCA with clearing price and totals.
  - **Settlement / Payout Workflow**
    - Input: settlement event, list of allocations.
    - External calls: vault / treasury contracts, compliance checks, payout APIs.
    - Output: private transfers or onchain claims, depending on design.
- Ensure each workflow:
  - Integrates at least **one blockchain + one external API** (per hackathon requirement).
  - Can be **simulated via the CRE CLI** and/or **deployed to the CRE network**.

#### 4. Frontend + API integration

- Replace fhEVM / Zama relayer SDK usage with:
  - EIP‑712 signing + HTTP calls into our CRE‑backed API (pattern from `private-transfer.ts`).
  - Configuration for:
    - CRE workflow endpoints (via Confidential HTTP),
    - Any API keys needed by downstream services (stored in CRE, not in app env).
- Add a thin backend / “API gateway” layer if needed:
  - To translate between public endpoints and CRE internal workflow invocations.

#### 5. Hardening and testing

- Unit‑test:
  - Auction lifecycle (deploy, bid, close, settle) with mocked CRE callbacks.
  - Edge cases (late bids, failed compliance, partial fills).
- CRE tests:
  - Workflow simulations via CRE CLI for:
    - Successful bid ingestion and settlement.
    - Rejected bids (compliance failure).
    - End‑to‑end run matching onchain CCA results.

### Summary

- We are **deprecating fhEVM‑based encryption and Zama‑specific tooling** in favor of **Chainlink Confidential Compute + CRE Confidential HTTP**.
- All sensitive auction logic (sealed bids, compliance, treasury flows) will be orchestrated in **CRE workflows**, while **Uniswap CCA + SilentBid** remain the onchain settlement and price discovery backbone.
- The **Compliant‑Private‑Transfer‑Demo** and the **Confidential HTTP demo** provide concrete building blocks for:
  - EIP‑712 signed messages,
  - Private API calls,
  - Policy‑controlled onchain transfers.

