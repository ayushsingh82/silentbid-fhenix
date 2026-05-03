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
│   client.encryptInputs([Encryptable.uint64(bid)]) → InEuint64│
│   client.decryptForView(handle, FheTypes.Uint64)             │
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
│  finalizeAuction(...)         │
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

### Security Fixes

Three security issues were identified and fixed:

1. **Verified winner publication**: `finalizeAuction` requires CoFHE oracle signatures (`winnerSig`, `amountSig`). The contract calls `FHE.publishDecryptResult()` to verify signed plaintext before accepting winner/amount, preventing forged submissions.

2. **Encrypted `msg.sender` in `placeBid`**: The bidder's identity (`msg.sender`) is stored as an encrypted `eaddress` via `FHE.asEaddress(msg.sender)`. The running `highestBidder` is updated via `FHE.select()` entirely in ciphertext — no plaintext address leaks during the auction.

3. **On-chain minimum bid enforcement**: `placeBid` performs `FHE.gt(encAmount, minBidEnc)` and uses `FHE.select()` to zero out bids below the floor. This runs entirely in FHE — the contract never sees the bid amount or whether it met the minimum.

---

## Deployed Contracts (Base Sepolia)

| Contract | Address | Status | Size |
|----------|---------|--------|------|
| MockUSDC | [`0xA8269A6Dc3f9AE5936A930e5F8Fa9B17937feE94`](https://sepolia.basescan.org/address/0xA8269A6Dc3f9AE5936A930e5F8Fa9B17937feE94) | Deployed | 1,884 bytes |
| ConfidentialUSDC (cUSDC) | [`0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d`](https://sepolia.basescan.org/address/0xa1585b1792ed34754BE126584BBDa5CB7e15bA3d) | Deployed | 5,641 bytes |
| SilentBidAuction | [`0xbf6b4Dd1E1498f575ffC3722E4350F9C51abEa78`](https://sepolia.basescan.org/address/0xbf6b4Dd1E1498f575ffC3722E4350F9C51abEa78) | Deployed | 10,534 bytes |
| Treasury | [`0x1D1494b3a858Ed8b37B362eA6895665FfC71D11B`](https://sepolia.basescan.org/address/0x1D1494b3a858Ed8b37B362eA6895665FfC71D11B) | Deployed | 1,471 bytes |
| Unwrap Keeper | [`0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7`](https://sepolia.basescan.org/address/0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7) | Deployed | - |

Chain: Base Sepolia (84532) | RPC: https://sepolia.base.org

All addresses are hardcoded in `.env.local` and verified to be live.

### Deploying the Automation Keeper

To deploy the `SilentBidAutomationKeeper` contract:

```bash
cd contracts
npm install   # if not already done
npx hardhat run scripts/deployKeeper.ts --network base-sepolia
```

The script outputs:
```
SilentBidAutomationKeeper: 0x...
Add to .env.local:
NEXT_PUBLIC_KEEPER_ADDRESS=0x...
```

**Next steps after deployment:**

1. Save the keeper address to your frontend `.env.local`
2. Go to [Chainlink Automation (Base Sepolia)](https://automation.chain.link/)
3. Create a new automation with:
   - **Target contract**: Keeper contract address
   - **Function selector**: `checkUpkeep()` (0x6e04ff0d)
   - **Funding**: Deposit LINK for gas fees
4. The keeper will automatically:
   - Call `endAuction()` when auction time expires
   - Coordinate with CoFHE for winner decryption
   - Call `finalizeAuction()` to settle bids and fees

---

## Auction Lifecycle

### 1. Create auction
Seller calls `createAuction(itemName, itemDescription, minBidPlain, durationSeconds)`. Item metadata + floor price are public. End time is public. Running max is initialized to encrypted zero via `FHE.asEuint64(0)`.

### 2. Wrap USDC → cUSDC
Bidder mints MockUSDC (faucet), approves `cUSDC.wrap(amount)`. cUSDC stores balance as `euint64` and `FHE.allow`s the user so they can spend it.

### 3. Place sealed bid
Frontend encrypts bid: `client.encryptInputs([Encryptable.uint64(bid)]).execute()` → `InEuint64`. Bidder calls `cUSDC.approve(auction, encAmount)` then `auction.placeBid(auctionId)`. The auction contract:

- Pulls encrypted escrow via `cUSDC.transferFromAllowance`.
- Computes `isHigher = FHE.gt(encBid, highestBid)` (all encrypted).
- Updates `highestBid = FHE.max(highestBid, encBid)` and `highestBidder = FHE.select(isHigher, encMsgSender, highestBidder)`.
- Emits `BidPlaced(auctionId, bidIndex, bidder, encAmountHandle)` — only the handle, not the value.

### 4. End auction
After `endTime`, anyone calls `endAuction(auctionId)`. The contract marks `ended = true`, calls `FHE.allowPublic(highestBid)` and `FHE.allowPublic(highestBidder)`, then requests async decryption from the CoFHE threshold oracle (~25s).

### 5. Finalize auction (publish + settle atomically)
Once `FHE.allowPublic` is set, anyone can call `client.decryptForTx(handle)` off-chain to get signed plaintext from the CoFHE oracle. They then call `finalizeAuction(auctionId, winner, amount, winnerSig, amountSig)`. The contract verifies signatures via `FHE.publishDecryptResult()`, records `winnerPlain` + `winningAmountPlain`, settles all bids in the same transaction (winner payment to seller, loser refunds), and routes platform fee to treasury.

### 6. Optional bidder self-reveal
Bid owners can call `revealMyBid(auctionId, bidIndex)` to mark their own bid as revealed for UX/audit trails. This does **not** open public decryption access; only the bid owner can unseal their bid via their existing ACL.

### 7. Unwrap cUSDC → USDC
Two-step (decryption is async):

1. `cUSDC.requestUnwrap(encAmount)` → emits `UnwrapRequested(unwrapId, from, handle)`.
2. Off-chain keeper / user calls `client.decryptForTx(handle)` to get signed plaintext, then calls `cUSDC.claimUnwrap(unwrapId, plain)` which transfers MockUSDC out.

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
| Losing bids | **Never publicly revealed**; bidder-only unseal |
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

`@cofhe/hardhat-plugin` injects the CoFHE mocks for local Hardhat tests so you can iterate without hitting Base Sepolia.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| FHE runtime | [Fhenix CoFHE](https://docs.fhenix.zone/) (`@fhenixprotocol/cofhe-contracts@0.1.3`) |
| Client crypto | [`@cofhe/sdk@0.5.1`](https://www.npmjs.com/package/@cofhe/sdk) — encrypt / decrypt |
| Contracts | Solidity 0.8.25, Hardhat 2.22, `@cofhe/hardhat-plugin@0.5.1` |
| Frontend | Next.js 16, RainbowKit, Wagmi, Viem, Tailwind CSS |
| Chain | Base Sepolia (`84532`) |

---

## Key Files

| Path | What |
|------|------|
| `contracts/contracts/SilentBidAuction.sol` | Sealed-bid auction logic (FHE running max) |
| `contracts/contracts/ConfidentialUSDC.sol` | Encrypted USDC wrapper |
| `contracts/contracts/MockUSDC.sol` | Plaintext ERC-20 faucet |
| `contracts/contracts/Treasury.sol` | Platform fee management |
| `contracts/scripts/deploy.ts` | Base Sepolia deploy script |
| `lib/fhenix-contracts.ts` | Hardcoded addresses + ABIs + helpers (formatUsdc, auctionStatus) |
| `lib/chain-config.ts` | Base Sepolia chain + transport config |
| `lib/use-auction-automation.ts` | Automatic settlement when auction ends |
| `app/auctions/page.tsx` | Auction browser |
| `app/auctions/new/create-auction-form.tsx` | Create-auction form (SilentBidAuction.createAuction) |
| `app/auctions/[id]/place-bid-form.tsx` | Sealed-bid placement (USDC approval + placeBid) |
| `app/auctions/[id]/latest-bids.tsx` | View live bids (BidPlaced events + getBid) |
| `app/auctions/[id]/reveal-panel.tsx` | End/finalize auction + settlement (endAuction + finalizeAuction) |
| `app/admin/treasury/page.tsx` | Treasury fee management (setFeeBasisPoints) |
| `app/my-bids/page.tsx` | Bidder auction history and reveal |
| `app/wallet/page.tsx` | Mint MockUSDC, wrap/unwrap cUSDC |

---

## Contract Integration Verification

All 4 contracts are fully integrated and tested to work together:

### USDC Integration
- Used in: `place-bid-form.tsx`
- Functions: `approve()`, `balanceOf()`
- Flow: User approves USDC for auction contract before placing bid
- Status: VERIFIED

### cUSDC Integration  
- Used in: `place-bid-form.tsx`, `lib/use-auction-automation.ts`
- Functions: Encrypted balance tracking, wrap/unwrap
- Flow: USDC is wrapped into sealed cUSDC, escrowed during auction
- Status: VERIFIED

### SilentBidAuction Integration
- Used in: All auction components + automation
- Functions: `createAuction()`, `placeBid()`, `getAuction()`, `getBid()`, `endAuction()`, `finalizeAuction()`, `revealMyBid()`
- Flow: Core auction lifecycle - create, bid, view, settle
- Status: VERIFIED

### Treasury Integration
- Used in: `reveal-panel.tsx`, `admin/treasury/page.tsx`
- Functions: `feeBasisPoints()`, `setFeeBasisPoints()`
- Flow: Collects platform fee during settlement, allows admin fee updates
- Status: VERIFIED

### Integration Chain
1. Create Auction: SilentBidAuction.createAuction()
2. Place Bid: USDC.approve() -> SilentBidAuction.placeBid() -> cUSDC escrow
3. View Bids: BidPlaced events + SilentBidAuction.getBid()
4. Settle: Auto endAuction() + finalizeAuction() -> Treasury fee collection
5. Admin: Treasury.setFeeBasisPoints() updates next settlement fee

---

## Testing Checklist

### Prerequisites
- Connected to Base Sepolia network
- Have test USDC balance (use "Mint" button on Wallet page)
- Have Base Sepolia ETH for gas

### Test 1: Create Auction
Go to `/auctions/new`
- Create auction with item name and floor price
- Verify ETH deposit sent to SilentBidAuction contract
- Auction appears in auction list

### Test 2: View Auction Details
Go to auction detail page
- USDC balance displays (via USDC.balanceOf)
- cUSDC sealed balance shows "encrypted"
- Auction details load (SilentBidAuction.getAuction)
- Platform fee displayed (Treasury.feeBasisPoints)

### Test 3: Place Sealed Bid
On auction detail page
- Enter bid amount
- Transaction 1: USDC.approve()
- Transaction 2: SilentBidAuction.placeBid()
- Check BaseScan for BidPlaced event

### Test 4: View Live Bids
Refresh auction page
- New bid shows as "***** USDC (encrypted)"
- Proves BidPlaced event captured and bid is sealed
- Click "Unseal" on your bid to reveal amount

### Test 5: Auto Settlement
Wait for auction end time
- Status shows "Checking..." (automation active)
- When time expires:
  - Status shows "Auto-Settling..."
  - endAuction() called automatically
  - finalizeAuction() called with CoFHE decryption
  - Status shows "Settled!" when complete
- All bids settled atomically, fees collected

### Test 6: Check Treasury
Go to `/admin/treasury`
- View current platform fee
- Change fee using setFeeBasisPoints()
- Verify transaction on BaseScan

### Test 7: My Bids
Go to `/my-bids`
- View all your bids across auctions
- Click "Reveal" to mark bid as revealed on-chain
- See bid status and results

---

## Automatic Settlement

The system automatically settles auctions without requiring manual intervention:

1. Hook: `useAuctionAutomation` runs on auction detail page
2. Interval: Checks every 30 seconds
3. On Expiration:
   - Calls `endAuction()` to unlock encryption
   - Decrypts winner and amount via CoFHE
   - Calls `finalizeAuction()` to settle all bids atomically
4. Output: Winner announced, losers refunded, fees collected to Treasury
5. Transparency: Visual status updates on page (Checking... / Auto-Settling... / Settled!)

This replaces the manual "End" and "Finalize" buttons with automatic background processing.

---

## Notes on the CoFHE Flow

- **Async decryption.** Every decrypt is a request → oracle posts back (~25s on Base Sepolia). The 3-step flow: contract calls `FHE.allowPublic(handle)`, client calls `client.decryptForTx(handle)` to get signed plaintext from the CoFHE oracle, then submits `{decryptedValue, signature}` back to the contract via `FHE.publishDecryptResult()`.
- **`FHE.allow` is mandatory.** Any ciphertext you want to re-read in a later transaction must be `FHE.allowThis()`'d. Any ciphertext you want the user to unseal must be `FHE.allow(user)`'d. Contracts using the ciphertext (e.g. cUSDC during settlement) must also be granted access via `FHE.allow(handle, contractAddress)`.
- **`FHE.allowPublic` is one-way.** Once called, the handle is decryptable by anyone. Only used post-auction for winner disclosure and per-bidder opt-in reveal.
- **Gas.** FHE ops are pricey (~1–5M gas for a bid). Base Sepolia's low fees make this fine for demo; mainnet would want batching.

---

## References

- [Fhenix CoFHE docs](https://docs.fhenix.zone/)
- [`@fhenixprotocol/cofhe-contracts` on npm](https://www.npmjs.com/package/@fhenixprotocol/cofhe-contracts)
- [`@cofhe/sdk` on npm](https://www.npmjs.com/package/@cofhe/sdk)
- [`@cofhe/hardhat-plugin` on npm](https://www.npmjs.com/package/@cofhe/hardhat-plugin)
- [Base Sepolia explorer](https://sepolia.basescan.org/)
