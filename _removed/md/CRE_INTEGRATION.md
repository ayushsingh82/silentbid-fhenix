# Chainlink CRE Integration — SilentBid Privacy

SilentBid uses **Chainlink Confidential Compute** and **CRE (Chainlink Runtime Environment) Confidential HTTP** to keep bid details and settlement flows private. This replaces the previous onchain encryption approach with offchain orchestration and onchain commitments.

## Overview

- **Sealed bids:** Users submit a **commitment** (hash of bid params) onchain and send the full signed bid to a CRE workflow via Confidential HTTP. Bid price, amount, and identity stay offchain until the workflow finalizes the auction.
- **CRE workflows:** Run offchain (CRE network). They verify EIP-712 signatures, call compliance/KYC APIs privately, store bids, compute clearing price, and call back onchain to SilentBid (`SilentBidCCA.forwardBidToCCA` / `forwardBidsToCCA`).
- **Compliant private transfers:** Settlement and payouts can follow the [Compliant Private Transfer Demo](https://github.com/smartcontractkit/compliant-private-transfer-demo) pattern: signed requests to a private API, policy engine, and onchain vault/withdrawals.

## References (extra repos)

- **Compliant-Private-Transfer-Demo** — EIP-712 signing, private transfer API, policy engine, vault. Use for: signing patterns, API auth, and private payout flows.
- **Confidential HTTP demo (CRE)** — Store API credentials in CRE, call external APIs without exposing keys onchain, orchestrate workflows that trigger onchain txs.

## Onchain: SilentBid (SilentBidCCA)

- **`submitBlindBid(bytes32 bidCommitment)`**  
  User (or a CRE-controlled relayer) sends ETH as escrow and a single commitment hash. No plaintext price/amount onchain.
- **`forwardBidToCCA(blindBidId, clearMaxPrice, clearAmount, owner, hookData)`**  
  Admin-only (CRE backend key). Called by the CRE workflow after it has validated the bid and decided the final amount/price.
- **`forwardBidsToCCA(...)`**  
  Batch version for multiple bids.

Commitment format (must match what CRE expects):

```text
bidCommitment = keccak256(abi.encodePacked(auctionId, sender, maxPrice, amount, flags, timestamp))
```

The CRE **Bid Ingestion Workflow** receives the full EIP-712 signed bid, verifies it, runs compliance, then either:
- Calls `submitBlindBid(bidCommitment)` from a relayer wallet with `msg.value = amount`, or
- Returns a signed payload so the frontend can call `submitBlindBid(bidCommitment)` with the user’s wallet (user pays gas and escrow).

## Frontend flow

1. User enters max price and amount in the SilentBid UI.
2. Frontend builds an EIP-712 message (e.g. `SilentBidBid`: sender, auctionId, maxPrice, amount, flags, timestamp) and asks the user to sign.
3. **Option A (CRE-first):** Send the signed message to your CRE endpoint (e.g. `POST /cre/bid` via Confidential HTTP). CRE stores the bid and, if configured, submits the onchain `submitBlindBid(bidCommitment)` with escrow.
4. **Option B (direct commit):** Frontend computes `bidCommitment = keccak256(abi.encodePacked(...))` and calls `SilentBidCCA.submitSilentBid(bidCommitment)` with `msg.value = amount`. The same signed message can be sent to CRE for compliance and storage so the workflow has the plaintext for finalization.

After the blind bid deadline, the CRE **Auction Finalization Workflow** runs: it reads stored bids, computes clearing price and allocations, then calls `forwardBidsToCCA` with the chosen amounts and owners.

## CRE workflow endpoints (design)

| Endpoint        | Purpose |
|----------------|--------|
| `POST /cre/bid` | Accept EIP-712 signed bid; verify; optional compliance; store; optionally submit onchain `submitBlindBid`. |
| `POST /cre/finalize` | Input: auctionId. Load bids, run price discovery, call `forwardBidsToCCA`. |
| `POST /cre/settle` | Handle payouts / private transfers (e.g. compliant private transfer API). |

Credentials and sensitive API keys stay in CRE; only signed requests and onchain calls are used at the boundaries.

## Docs and links

- [Chainlink Confidential Compute / CRE](https://docs.chain.link/)
- [Compliant Private Transfer Demo](https://github.com/smartcontractkit/compliant-private-transfer-demo)
- SilentBid contracts (SilentBidCCA, SilentBidFactory) and scripts: **BlindPool-scripts** repo; see README for deploy and forward flows.
