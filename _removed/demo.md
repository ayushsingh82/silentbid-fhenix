# SilentBid Demo Guide

## Network Setup

### Sepolia Testnet (recommended for demo)

| Item | Value |
|------|-------|
| **Network** | Ethereum Sepolia |
| **Chain ID** | 11155111 |
| **CCA Factory** | `0xcca1101C61cF5cb44C968947985300DF945C3565` |
| **RPC** | `https://1rpc.io/sepolia` |
| **Block time** | ~12 seconds |

Get Sepolia ETH from a faucet before starting:
- https://www.alchemy.com/faucets/ethereum-sepolia
- https://cloud.google.com/application/web3/faucet/ethereum/sepolia

### Local Anvil (optional, for offline dev)

```bash
# Terminal 1 — start a local chain
anvil

# Terminal 2 — run the app against it
NEXT_PUBLIC_NETWORK=anvil bun run dev
```

Anvil runs on `http://127.0.0.1:8545` with chain ID 31337.

### Environment

Create `.env.local` in the project root:

```env
NEXT_PUBLIC_NETWORK=sepolia
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id   # optional
NEXT_PUBLIC_SILENTBID_FACTORY_ADDRESS=0x...             # if deploying SilentBid wrappers
```

---

## Running the App

```bash
bun install
bun run dev
# Open http://localhost:3000
```

---

## Demo Walkthrough

### Side A — Auction Creator

1. **Connect wallet** — click the connect button (top-right), pick MetaMask or any injected wallet on Sepolia.

2. **Go to Auctions** — click "Auctions" in the nav or visit `/auctions`.

3. **Create Auction** — click "Create Auction" to open the 5-step wizard at `/auctions/new`:

   | Step | Action |
   |------|--------|
   | **1. Deploy CCA** | Fill in token name, total supply, floor price (ETH per token), and auction duration (in blocks). Confirm the factory tx. |
   | **2. Mint tokens** | Mint your ERC-20 tokens to the newly created auction address. |
   | **3. Activate** | Call `onTokensReceived()` on the auction contract to unlock bidding. |
   | **4. Deploy SilentBid wrapper** *(optional)* | Deploys a privacy wrapper that accepts sealed-bid commitments instead of plaintext bids. |
   | **5. Done** | Auction is live. Copy the auction address and share it with bidders. |

4. **Monitor** — return to `/auctions` and filter by "Active" to see your auction. Click into it to watch incoming bids and the countdown timer.

### Side B — Bidder

1. **Connect wallet** on Sepolia (different account from the creator).

2. **Browse auctions** at `/auctions` → filter "Active".

3. **Open an auction** — click any active auction card to see its details: floor price, supply, time remaining.

4. **Place a bid** — two paths depending on whether the auction has a SilentBid wrapper:

   #### Plain CCA bid (no wrapper)
   - Enter **amount** (ETH to spend) and **max price** (ETH per token).
   - Click "Place Bid" → confirm the on-chain tx.
   - Your bid is publicly visible immediately.

   #### Sealed bid (SilentBid + CRE)
   - Enter **amount** and **max price**.
   - Click "Place Sealed Bid" → wallet prompts an **EIP-712 signature** (no tx yet).
   - The signed bid is sent to the CRE backend (`POST /api/cre/bid`), which:
     - verifies the signature
     - computes a commitment hash
     - stores the bid privately
   - A second tx submits **only the commitment hash** on-chain via `submitSilentBid(bytes32)`.
   - Your actual price and amount stay hidden until the blind deadline passes.

5. **After the auction ends**:
   - CRE finalize (`POST /api/cre/finalize`) computes the uniform clearing price.
   - CRE settle (`POST /api/cre/settle`) generates payouts to winners and refunds to losers.

---

## Full Flow Diagram

```
Creator                              Bidder
───────                              ──────
1. Create CCA (factory tx)
2. Mint tokens → auction
3. Activate auction
4. (optional) Deploy SilentBid
         │
         │    auction goes live
         ▼
                                     5. Sign EIP-712 bid (wallet)
                                     6. POST /api/cre/bid (off-chain)
                                     7. submitSilentBid(commitment) (on-chain)
                                        ... more bidders ...
         │
         │    blind deadline passes
         ▼
8. POST /api/cre/finalize
   → clearing price computed
9. POST /api/cre/settle
   → winners get tokens
   → losers get refunds
```

---

## Build & Push

### Build for production

```bash
bun run build
```

This outputs to `.next/`. TypeScript target is ES2020 (required for BigInt).

### Start production server

```bash
bun run start
```

### Deploy to Vercel (recommended)

```bash
# Install Vercel CLI if needed
bun add -g vercel

# Deploy
vercel

# Or link and deploy to production
vercel --prod
```

Set the same env vars in the Vercel dashboard under **Settings → Environment Variables**.

### Deploy via Git push

```bash
git add -A
git commit -m "ready for demo"
git push origin main
```

If the repo is connected to Vercel / Railway / Render, pushing to `main` triggers an automatic deploy.

### Deploy contracts (Foundry)

Contract source and deployment scripts live in `/Silentbid-scripts`:

```bash
cd Silentbid-scripts
forge build
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --broadcast
```

---

## Quick Reference

| Task | Command / URL |
|------|---------------|
| Dev server | `bun run dev` → `http://localhost:3000` |
| Build | `bun run build` |
| Production | `bun run start` |
| Lint | `bun run lint` |
| Sepolia faucet | alchemy.com/faucets/ethereum-sepolia |
| Simulate CRE workflow | `cd blindpool-cre && cre workflow simulate ...` |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Wallet won't connect | Make sure MetaMask is on Sepolia (chain ID 11155111) |
| "Auction not active" error | Ensure step 3 (activate) was completed |
| Bid tx reverts | Check that bid amount > 0 and auction hasn't ended |
| Wagmi connector warnings | Harmless — coinbase/gemini/porto connectors log warnings in dev |
| Build fails on BigInt | Verify `tsconfig.json` target is `ES2020` |
