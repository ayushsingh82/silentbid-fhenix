# SilentBid — Fhenix CoFHE Edition

> **Sealed-bid auctions on Base Sepolia, powered by [Fhenix CoFHE](https://docs.fhenix.zone/).**
>
> Bids stay encrypted end-to-end using Fully Homomorphic Encryption. The running max is computed inside FHE — the contract never sees a plaintext bid.

---

## TL;DR

SilentBid is a sealed-bid auction where every bid amount is an `euint64` (encrypted 64-bit int) stored directly on-chain. Escrow is held in **cUSDC**, a confidential wrapper around MockUSDC. At auction close the winning bid + bidder are decrypted asynchronously via the CoFHE threshold network; losers get their encrypted escrow refunded without anyone ever learning the amounts.

No commit-reveal scheme. No relayer. No off-chain aggregator. The chain holds ciphertexts; CoFHE handles the math.

**Live on Base Sepolia** (`chainId 84532`).

---

## Why Fhenix CoFHE

Traditional sealed-bid designs on Ethereum need one of:

- **Commit-reveal** — two transactions, reveal step can be skipped to grief, leaks via timing.
- **MPC / threshold networks** — complex, bespoke trust assumptions.
- **Confidential compute** (TEE, CRE) — off-chain trust anchor, extra infra.

CoFHE gives us native EVM FHE: ciphertexts are first-class Solidity types, the co-processor evaluates `FHE.max`, `FHE.select`, `FHE.gt` on-chain, and decryption is a permissioned async call. We get sealed bids in a **single contract** with no extra services.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Next.js 16 + RainbowKit + Wagmi + Viem)          │
│                                                             │
│   cofhejs.encrypt([Encryptable.uint64(bid)]) → InEuint64    │
│   cofhejs.unseal(handle, FheTypes.Uint64)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │  InEuint64 struct (ctHash + sig)
           ┌───────────────▼───────────────┐
           │  SilentBidAuction.sol         │
           │                               │
           │  placeBid(auctionId)          │
           │   ├─ cUSDC.transferFromAllow  │  (encrypted escrow)
           │   ├─ FHE.gt(bid, highestBid)  │
           │   ├─ highestBid = FHE.max(..) │
           │   └─ highestBidder = select() │
           │                               │
           │  endAuction()                 │
           │   └─ FHE.decrypt(highestBid)  │  (async oracle)
           │                               │
           │  publishWinner(winner, amt)   │
           │  settleBid(idx)  ← refunds    │
           │  revealMyBid(idx)             │
           └───────────────┬───────────────┘
                           │
           ┌───────────────▼───────────────┐
           │  ConfidentialUSDC.sol         │
           │                               │
           │  wrap(uint64) plaintext in    │
           │  approve(spender, encAmount)  │
           │  requestUnwrap(encAmount)     │  (two-step async)
           │  claimUnwrap(id, plain)       │
           └───────────────────────────────┘
```

### Contracts

| File | Purpose |
|------|---------|
| `SilentBidAuction.sol` | Sealed-bid auction with FHE running max; encrypted escrow via cUSDC |
| `ConfidentialUSDC.sol` | `euint64` wrapper around MockUSDC (wrap / requestUnwrap / claimUnwrap) |
| `MockUSDC.sol` | 6-decimal ERC-20 mint faucet for Base Sepolia testing |

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| MockUSDC | [`0xF1235b1782D48EbDf23673b115E51d03703463a1`](https://sepolia.basescan.org/address/0xF1235b1782D48EbDf23673b115E51d03703463a1) |
| ConfidentialUSDC (cUSDC) | [`0x651524Af19c2edeb94DE60ECd0B9B361B53AAAFF`](https://sepolia.basescan.org/address/0x651524Af19c2edeb94DE60ECd0B9B361B53AAAFF) |
| SilentBidAuction | [`0x3199d17cfa7027f91504F960DbCd34D44d284434`](https://sepolia.basescan.org/address/0x3199d17cfa7027f91504F960DbCd34D44d284434) |
| Unwrap Keeper | [`0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7`](https://sepolia.basescan.org/address/0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7) |

Chain: **Base Sepolia** (`84532`) · RPC: `https://sepolia.base.org`

Addresses are hardcoded in `lib/fhenix-contracts.ts` and `lib/chain-config.ts` — no env file needed to run the UI against the live deployment.

---

## Auction Lifecycle

### 1. Create auction
Seller calls `createAuction(itemName, itemDescription, minBidPlain, durationSeconds)`. Item metadata + floor price are public. End time is public. Running max is initialized to encrypted zero via `FHE.asEuint64(0)`.

### 2. Wrap USDC → cUSDC
Bidder mints MockUSDC (faucet), approves `cUSDC.wrap(amount)`. cUSDC stores balance as `euint64` and `FHE.allow`s the user so they can spend it.

### 3. Place sealed bid
Frontend encrypts bid: `cofhejs.encrypt([Encryptable.uint64(bid)])` → `InEuint64`. Bidder calls `cUSDC.approve(auction, encAmount)` then `auction.placeBid(auctionId)`. The auction contract:

- Pulls encrypted escrow via `cUSDC.transferFromAllowance`.
- Computes `isHigher = FHE.gt(encBid, highestBid)` (all encrypted).
- Updates `highestBid = FHE.max(highestBid, encBid)` and `highestBidder = FHE.select(isHigher, encMsgSender, highestBidder)`.
- Emits `BidPlaced(auctionId, bidIndex, bidder, encAmountHandle)` — only the handle, not the value.

### 4. End auction
After `endTime`, anyone calls `endAuction(auctionId)`. The contract marks `ended = true`, calls `FHE.allowPublic(highestBid)` and `FHE.allowPublic(highestBidder)`, then requests async decryption from the CoFHE threshold oracle (~25s).

### 5. Publish winner
Once the oracle posts the plaintext, a keeper (or anyone) calls `publishWinner(auctionId, winner, amount)`. The contract verifies against the decrypted handles and records `winnerPlain` + `winningAmountPlain`.

### 6. Settle & refund
Each losing bidder calls `settleBid(auctionId, bidIndex)` — the contract transfers their encrypted escrow back via `cUSDC.transferEncrypted`. The winner's escrow routes to the seller. Optionally, any bidder can call `revealMyBid(auctionId, bidIndex)` to `FHE.allowPublic` their own bid for post-auction transparency.

### 7. Unwrap cUSDC → USDC
Two-step (decryption is async):

1. `cUSDC.requestUnwrap(encAmount)` → emits `UnwrapRequested(unwrapId, from, handle)`.
2. Off-chain keeper / user `cofhejs.unseal`s the handle, then calls `cUSDC.claimUnwrap(unwrapId, plain)` which transfers MockUSDC out.

---

## Privacy Model

| Data | Visibility |
|------|------------|
| Bid amount | **Encrypted on-chain** (`euint64`) — never decrypted for losers |
| Bidder identity (best-so-far) | **Encrypted on-chain** (`eaddress`) until auction close |
| Per-bidder escrow balance (cUSDC) | **Encrypted on-chain** (`euint64`) |
| `msg.sender` of each `placeBid` | Public (unavoidable) |
| Running highest bid post-close | Public (via `FHE.allowPublic` + async decrypt) |
| Winner address post-close | Public (via `FHE.allowPublic` + async decrypt) |
| Losing bids | **Never revealed** unless the bidder opts in via `revealMyBid` |
| Auction params, duration, floor | Public |

**Trust model:** CoFHE threshold network holds the FHE decryption key shares. The contract controls *when* decryption is authorized (only after `endAuction`, and only for the aggregate winner). Individual losing bids are never decrypted.

---

## Getting Started

### Frontend

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The UI is wired to the live Base Sepolia deployment — connect a wallet with Base Sepolia ETH + MockUSDC and you can create auctions or bid immediately.

Faucets:
- Base Sepolia ETH: https://www.alchemy.com/faucets/base-sepolia
- MockUSDC: click **"Mint"** on the Wallet page (calls `MockUSDC.mint` directly)

### Contracts

```bash
cd contracts
npm install
cp .env.example .env   # set DEPLOYER_PRIVATE_KEY + BASE_SEPOLIA_RPC_URL
npm run compile
npm run deploy          # hardhat run scripts/deploy.ts --network base-sepolia
```

`cofhe-hardhat-plugin` injects the CoFHE mocks for local Hardhat tests so you can iterate without hitting Base Sepolia.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| FHE runtime | [Fhenix CoFHE](https://docs.fhenix.zone/) (`@fhenixprotocol/cofhe-contracts@0.0.13`) |
| Client crypto | [`cofhejs@0.3.1`](https://github.com/FhenixProtocol/cofhejs) — encrypt / unseal |
| Contracts | Solidity 0.8.25, Hardhat 2.22, `cofhe-hardhat-plugin@0.3.1` |
| Frontend | Next.js 16, RainbowKit, Wagmi, Viem, Tailwind CSS |
| Chain | Base Sepolia (`84532`) |

---

## Key Files

| Path | What |
|------|------|
| `contracts/contracts/SilentBidAuction.sol` | Sealed-bid auction logic (FHE running max) |
| `contracts/contracts/ConfidentialUSDC.sol` | Encrypted USDC wrapper |
| `contracts/contracts/MockUSDC.sol` | Plaintext ERC-20 faucet |
| `contracts/scripts/deploy.ts` | Base Sepolia deploy script |
| `lib/fhenix-contracts.ts` | Hardcoded addresses + ABIs + helpers (`formatUsdc`, `auctionStatus`) |
| `lib/chain-config.ts` | Base Sepolia chain + transport config |
| `app/auctions/page.tsx` | Auction browser |
| `app/auctions/new/create-auction-form.tsx` | Create-auction form |
| `app/auctions/[id]/place-bid-form.tsx` | Sealed-bid placement (cofhejs encrypt) |
| `app/wallet/page.tsx` | Mint MockUSDC, wrap/unwrap cUSDC |

---

## Notes on the CoFHE Flow

- **Async decryption.** Every decrypt is a request → oracle posts back (~25s on Base Sepolia). The UI polls with a retry loop; contracts split into two functions (`endAuction` / `publishWinner`, `requestUnwrap` / `claimUnwrap`) to match.
- **`FHE.allow` is mandatory.** Any ciphertext you want to re-read in a later transaction must be `FHE.allowThis()`'d. Any ciphertext you want the user to unseal must be `FHE.allow(user)`'d.
- **`FHE.allowPublic` is one-way.** Once called, the handle is decryptable by anyone. Only used post-auction for winner disclosure and per-bidder opt-in reveal.
- **Gas.** FHE ops are pricey (~1–5M gas for a bid). Base Sepolia's low fees make this fine for demo; mainnet would want batching.

---

## References

- [Fhenix CoFHE docs](https://docs.fhenix.zone/)
- [`cofhe-contracts` on npm](https://www.npmjs.com/package/@fhenixprotocol/cofhe-contracts)
- [`cofhejs` on npm](https://www.npmjs.com/package/cofhejs)
- [Base Sepolia explorer](https://sepolia.basescan.org/)
