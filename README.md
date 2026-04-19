# SilentBid

> **Sealed-bid token launches on Uniswap CCA, powered by Chainlink CRE.**
>
> Built for the **Chainlink Hackathon — Privacy Track**.

---

## TL;DR

SilentBid adds sealed-bid privacy to [Uniswap's Continuous Clearing Auction (CCA)](https://docs.uniswap.org/contracts/liquidity-launchpad/CCA). Bids stay private until the auction closes — no front-running, no MEV sniping, no information leakage. We use **Chainlink Runtime Environment (CRE)** and **Confidential HTTP** to handle bid data offchain so only commitments ever touch the chain.

**Live on Sepolia.** Full end-to-end flow: create auction → place sealed bid → CRE finalize → settle.

---

## Problem

Every bid on a standard CCA/LBP is public the moment it hits the mempool:

- **MEV bots** front-run and copy bids before settlement.
- **Last-block snipers** distort clearing prices.
- **Retail bidders** get worse execution; projects get diluted allocations and less trust.

Traditional finance solved this decades ago with sealed-bid auctions. We bring that to onchain token launches without changing the underlying CCA mechanism.

---

## Solution

**SilentBid = Uniswap CCA + sealed bids via Chainlink CRE.**

Only a `keccak256` commitment goes onchain during the auction. Bid prices, amounts, and identities are handled entirely within CRE workflows using Confidential HTTP. After the deadline, CRE runs price discovery and forwards all bids into the CCA in a single batched transaction.

Same clearing. Same pool seeding. Zero bid leakage.

---

## How Chainlink CRE Powers SilentBid

We built three CRE workflows that mirror the auction lifecycle. Each has a corresponding Next.js API route that implements the same logic and can be swapped for the CRE-hosted version in production.

### 1. Bid Ingestion — `POST /api/cre/bid`

User signs an **EIP-712 bid** (sender, auctionId, maxPrice, amount, timestamp) in-wallet. The workflow:

1. Validates payload (addresses, positive amounts, required fields).
2. Verifies the EIP-712 signature against the SilentBid domain.
3. Computes `commitment = keccak256(abi.encodePacked(auctionId, sender, maxPrice, amount, timestamp))`.
4. Stores the bid privately. In production, forwarded to CRE via **Confidential HTTP** so keys and bid data never appear onchain or in logs.
5. Returns the commitment — the frontend calls `BlindPoolCCA.submitBlindBid(commitment)` with `msg.value = amount`.

**CRE workflow:** `blindpool-cre/workflows/bid-ingestion` — same steps, plus optional compliance check via Confidential HTTP.

### 2. Finalize — `POST /api/cre/finalize`

After the blind-bid deadline:

1. Loads all stored bids for the given `auctionId`.
2. Runs **uniform-price discovery**: sort by maxPrice descending, clearing price = lowest winning bid's maxPrice.
3. Builds calldata for `BlindPoolCCA.forwardBidsToCCA(clearingPrice, winningBids)`.
4. An operator or CRE backend submits that single transaction — all sealed bids forwarded into the CCA.

**CRE workflow:** `blindpool-cre/workflows/finalize` — triggered via HTTP, returns calldata for a relayer.

### 3. Settle — `POST /api/cre/settle`

Consumes the allocations from finalize:

1. Validates `auctionId` and the allocations array.
2. Builds settlement plan: winner payouts + excess-escrow refunds; loser full refunds.
3. Returns the plan. In production, a CRE settle workflow executes transfers via compliant private calls.

### Workflow Summary

| Step | Route / CRE Workflow | Offchain (CRE) | Onchain |
|------|----------------------|-----------------|---------|
| **Bid** | `/api/cre/bid` ↔ `workflows/bid-ingestion` | Verify EIP-712, compute commitment, store bid, optional compliance via Confidential HTTP | `submitBlindBid(commitment)` + `msg.value` |
| **Finalize** | `/api/cre/finalize` ↔ `workflows/finalize` | Load bids, uniform-price discovery, build `forwardBidsToCCA` calldata | `forwardBidsToCCA(...)` — one batched tx |
| **Settle** | `/api/cre/settle` ↔ CRE settle workflow | Build payout/refund plan from allocations | Compliant private transfers per the plan |

**Sensitive data (bid prices, amounts, identities, payout details) never appears onchain.** The chain sees only commitments and batched settlement results.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (Next.js)                                     │
│  Browse auctions · Create auction · Place sealed bid    │
│  EIP-712 sign in-wallet → POST /api/cre/bid             │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────▼────────────┐
        │  CRE Workflows          │
        │  (Confidential HTTP)    │
        │                         │
        │  bid-ingestion          │
        │  finalize               │
        │  settle                 │
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────┐
        │  Smart Contracts        │
        │  (Sepolia)              │
        │                         │
        │  BlindPoolCCA           │
        │  BlindPoolFactory       │
        │  Uniswap CCA (base)    │
        └─────────────────────────┘
```

### Repos

| Repo | What |
|------|------|
| **This repo** (frontend) | Next.js app + API routes (`/api/cre/bid`, `/api/cre/finalize`, `/api/cre/settle`) |
| **blindpool-cre/** | CRE workflow definitions (bid-ingestion, finalize). Simulatable with `cre workflow simulate`. |
| **[Silentbid-scripts](https://github.com/ayushsingh82/Silentbid-scripts)** | Solidity contracts (BlindPoolCCA, BlindPoolFactory) + Foundry deploy/test scripts |

---

## Deployed Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| ERC20 Token (mock) | `0x9D3B8A874b173DA351C026132319459C957D1528` |
| CCA Auction | `0x3045F74EBd5d72CEa21118347Dd42e44f89c0eC7` |
| SilentBidCCA | `0xb4B81F8F93171Ab65a9f363c0524b2ED18af3F25` |
| SilentBidFactory | `0xe4d9d1ab7F7d1AbB85b3EF7cDb4505c8D5a74fB5` |

---

## Privacy Model

| Data | Standard CCA | SilentBid |
|------|-------------|-----------|
| Bidder identity | Public (`msg.sender`) | **Private** until auction close |
| Max price | Public (onchain param) | **Private** until close |
| Budget / amount | Public (onchain param) | **Private** until close |
| Per-bid fill state | Public | **Private** until settlement |
| Clearing price | Public | Public **after** close |
| Auction params, end time | Public | Public |
| Settlement & pool seed | Public | Public (after close) |

**Only commitments onchain during the auction.** Everything else stays in CRE until settlement.

---

## Getting Started

```bash
# Install
bun install

# Run dev server (serves UI + API routes)
bun run dev

# Build
bun run build

# Test (vitest — real onchain, zero mocks)
bun run test
```

Open [http://localhost:3000](http://localhost:3000).

### Environment

Copy `.env.local.example` or set these in `.env.local`:

```env
NEXT_PUBLIC_SILENTBID_FACTORY_ADDRESS=0xe4d9d1ab7F7d1AbB85b3EF7cDb4505c8D5a74fB5
NEXT_PUBLIC_DEFAULT_TOKEN=0x9D3B8A874b173DA351C026132319459C957D1528
NEXT_PUBLIC_LATEST_AUCTION=0x3045F74EBd5d72CEa21118347Dd42e44f89c0eC7
NEXT_PUBLIC_LATEST_SILENTBID=0xb4B81F8F93171Ab65a9f363c0524b2ED18af3F25
NEXT_PUBLIC_DEPLOYER=0xE2b39f4cfFA5B17434e47Ab5F54b984155e4b7aD
```

Optional: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for WalletConnect ([cloud.walletconnect.com](https://cloud.walletconnect.com/)).

### CRE Workflow Simulation

```bash
cd blindpool-cre
bun install

# Simulate bid ingestion
cre workflow simulate ./workflows/bid-ingestion \
  --target=staging-settings \
  --http-payload ./workflows/bid-ingestion/http-payload.example.json \
  --non-interactive --trigger-index 0

# Simulate finalize
cre workflow simulate ./workflows/finalize \
  --target=staging-settings \
  --http-payload '{"auctionId":"0x3045F74EBd5d72CEa21118347Dd42e44f89c0eC7"}' \
  --non-interactive --trigger-index 0
```

### Foundry (Contracts)

```bash
cd ../Silentbid-scripts
forge test -vv
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, Tailwind CSS, RainbowKit, Wagmi, viem |
| Privacy / offchain | Chainlink CRE, Confidential HTTP, EIP-712 |
| Contracts | Solidity (BlindPoolCCA, BlindPoolFactory), Foundry |
| Base mechanism | Uniswap CCA (forked, unmodified settlement) |
| Chain | Sepolia testnet (11155111) |

---

## What We Demonstrated

- **End-to-end sealed-bid flow** on Sepolia: create auction → deploy SilentBid wrapper → place EIP-712 signed bid → CRE bid ingestion → finalize (price discovery + `forwardBidsToCCA`) → settle.
- **Three CRE workflows** (bid-ingestion, finalize, settle) that keep all bid data offchain via Confidential HTTP.
- **Real onchain tests** (vitest, 60 tests, zero mocks) covering ABIs, bid commitment, chain config, API routes.
- **Full-stack frontend** — auction creation, sealed bid placement, auction browsing, all connected to live Sepolia contracts.
- **Minimal onchain footprint** — only `keccak256` commitments and one batched `forwardBidsToCCA` call touch the chain.

---

## References

- [Uniswap CCA Documentation](https://docs.uniswap.org/)
- [CCA Contract & Technical Reference](https://github.com/Uniswap/continuous-clearing-auction)
- [Chainlink CRE / Confidential Compute](https://docs.chain.link/cre)
- [Compliant Private Transfer Demo (CRE pattern)](https://github.com/smartcontractkit)
- [EIP-712: Typed Structured Data Hashing and Signing](https://eips.ethereum.org/EIPS/eip-712)
