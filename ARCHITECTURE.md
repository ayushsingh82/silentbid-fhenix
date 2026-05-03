# SilentBid Auction Architecture Guide

## Overview

SilentBid is a sealed-bid auction system built on Fhenix using homomorphic encryption (FHE) for encrypted bid storage and processing. This guide explains how the system works, especially the crucial components around bid sealing, auction settlement, and gas management.

## System Components

### 1. **Smart Contracts**

#### SilentBidAuction.sol
- **Purpose**: Core auction logic with encrypted bid handling
- **Key Features**:
  - Sealed-bid placement with FHE encryption
  - Automatic running-max computation on encrypted data
  - Two-phase finalization (end → finalize)
  - Atomic settlement of all bids
  - Gas deposit and compensation system

#### Treasury.sol
- **Purpose**: Collects platform fees and manages fee settings
- **Features**:
  - Owner-controlled fee basis points (0-1000 bps, i.e., 0-10%)
  - Receives a percentage cut from winning bids
  - Stores collected fees (cUSDC encrypted)
  - Authorized contract management

#### ConfidentialUSDC.sol
- **Purpose**: Encrypted ERC20 token wrapper
- **Features**:
  - Wraps regular USDC into encrypted cUSDC
  - Maintains encrypted balances
  - Supports encrypted transfers
  - FHE-based arithmetic and comparisons

### 2. **Bid Security Model**

**Important**: Only the rightful owner can decrypt their own bid.

- **Bid Placement**: When a bidder places a bid:
  1. Amount is encrypted on-client using FHE
  2. Encrypted amount is locked in the auction contract
  3. Each bidder gets an FHE decryption capability for their own bid
  4. No one else can decrypt individual bids

- **After Auction Ends** (endAuction called):
  1. The highest bid handle becomes publicly decryptable
  2. But decryption still requires the Fhenix CoFHE oracle
  3. Oracle returns a signed plaintext result
  4. finalizeAuction verifies the oracle signature

- **Bidder Reveal** (revealMyBid):
  - Bidders can optionally mark their bid as revealed
  - They can decrypt their own bid via CoFHE oracle
  - Only for transparency; doesn't affect settlement

**Security Summary**: 
- ✅ No unauthorized bid unsealing possible
- ✅ Highest bidder only revealed via oracle with signature verification
- ✅ Individual bids remain encrypted until bidder chooses to reveal

## Auction Flow

### Phase 1: Active Auction

```
1. Seller creates auction
   - Deposits ETH for gas costs
   - Sets floor price (informational)
   - Sets duration

2. Bidders place sealed bids
   - Encrypt bid amount with client-side FHE
   - Approve encrypted amount to auction contract
   - Pay small gas fee in ETH
   - Bid amounts stay encrypted on-chain
```

### Phase 2: Auction Ends (After End Time)

```
1. Anyone calls endAuction(auctionId)
   - Closes bidding
   - Marks highest bid handle as publicly decryptable
   - Emits AuctionEnded event

2. Caller (or any off-chain service) decrypts via CoFHE:
   - Calls CoFHE API: decryptForTx(highestBidHandle)
   - Gets signed plaintext + oracle signature
   - Does same for highestBidder handle
```

### Phase 3: Settlement (Atomic Finalization)

```
3. Anyone calls finalizeAuction(auctionId, winner, amount, winnerSig, amountSig)
   - Verifies oracle signatures
   - Publishes winner publicly on-chain
   - Settles ALL bids atomically:
     * Winner → pays seller (amount - fee)
     * Treasury → receives fee (amount * feeBps / 10000)
     * Losers → refunded their full bid
   - Compensates transaction caller from gas pool
   - Refunds unused gas to seller
```

## Gas Management System

### Gas Deposit (By Auction Creator)

- Seller deposits ETH when creating auction
- Minimum: 0.005 ETH (configurable)
- Covers expected settlement transaction costs
- **Unused portion is refunded to seller after settlement**

### Bid Gas Fee (By Each Bidder)

- Each bidder pays a small ETH amount with their bid
- Default: 0.0005 ETH (configurable)
- Goes into a gas pool
- Compensates whoever finalizes the auction

### Gas Compensation Flow

During `finalizeAuction`:
```
totalGasPool = sellerDeposit + sumOfBidderFees

1. Calculate actual gas used by finalizeAuction
2. gasCompensation = gasUsed * tx.gasprice
3. payout = min(gasCompensation, totalGasPool)
4. Transfer payout to finalizeAuction caller
5. Refund (totalGasPool - payout) to seller
6. If seller refund fails, try treasury
```

**Result**: Finalization is incentivized while protecting sellers from excessive gas costs.

## Fee Management

### Platform Fee (Treasury)

- Set by Treasury owner via `setFeeBasisPoints(bps)`
- Range: 0-1000 basis points (0-10%)
- Example: 250 bps = 2.5% fee
- **Applied only to winning bid**
- Deducted before seller receives payment

### Example Fee Calculation

```
Winning bid: 350 USDC
Fee rate: 2.5% (250 bps)

Fee amount: 350 * 250 / 10000 = 8.75 USDC
Seller receives: 350 - 8.75 = 341.25 USDC
Treasury receives: 8.75 USDC (encrypted cUSDC)
```

## Accessing Admin Functions

### Treasury Fee Management

**Path**: `/admin/treasury`

**Admin Functions**:
- View current fee basis points
- View treasury cUSDC balance (encrypted)
- Update fee percentage (only owner)

**Requirements**:
- Must be connected with Treasury owner address
- NEXT_PUBLIC_TREASURY_ADDRESS must be set

### Manual Auction Settlement

**Path**: `/auctions/[id]` → "Results" section

**Two-Step Process**:
1. **End Auction** button: Calls `endAuction()`
   - Marks as ended
   - Makes highest handles decryptable

2. **Finalize (auto-settle all)** button:
   - Decrypts winner via CoFHE oracle
   - Calls `finalizeAuction()` with signatures
   - Settles everyone atomically
   - Shows winner and winning amount
   - Displays gas compensation info

## Environment Configuration

### Required .env.local Variables

```env
NEXT_PUBLIC_NETWORK=base-sepolia
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Contract Addresses
NEXT_PUBLIC_USDC_ADDRESS=0x...
NEXT_PUBLIC_CUSDC_ADDRESS=0x...
NEXT_PUBLIC_AUCTION_ADDRESS=0x...
NEXT_PUBLIC_UNWRAPPER_ADDRESS=0x...
NEXT_PUBLIC_TREASURY_ADDRESS=0x...
```

## Testing

### Run All Tests

```bash
cd contracts
npx hardhat test
```

### Test Coverage

14 comprehensive tests covering:
- ✅ E2E auction flow (bid → finalization)
- ✅ Seller bidding rejection
- ✅ Duplicate bid prevention
- ✅ Bid reveal restrictions
- ✅ Multi-bid atomic settlement
- ✅ Fee calculation accuracy
- ✅ Zero-fee handling
- ✅ Fee cap enforcement (max 10%)
- ✅ Owner-only fee updates
- ✅ Gas compensation to finalizer
- ✅ Unused gas refunds to seller
- ✅ Treasury fee collection

## Future Enhancements

### Automated Finalization (Optional)

For fully automatic settlement without manual calls:

**Option 1: Chainlink Automation**
```solidity
// Would call finalizeAuction automatically after auction.endTime
// Requires integration with Chainlink upkeep registry
```

**Option 2: Gelato Tasks**
```solidity
// Similar to Chainlink but with Gelato's task automation
// Can use conditional triggers based on block time
```

**Option 3: Off-Chain Relayer**
```typescript
// Dedicated backend service:
// 1. Polls for ended auctions
// 2. Decrypts via CoFHE oracle
// 3. Calls finalizeAuction
// 4. Keeps earned compensation
```

### Current Approach
- Manual finalization (anyone can call)
- Incentivized by gas compensation
- Gives flexibility for custom automation layers

## Security Considerations

### ✅ Implemented Security

1. **Bid Encryption**: All bids are FHE-encrypted end-to-end
2. **Atomic Settlement**: All bids settle in single transaction (all-or-nothing)
3. **Access Control**: FHE ACL ensures only appropriate parties can decrypt
4. **Fee Enforcement**: Fee cap prevents excessive treasury cuts
5. **Gas Refunds**: Sellers protected from excessive gas costs
6. **Oracle Signature Verification**: Only valid CoFHE results accepted
7. **Seller Bid Prevention**: Sellers cannot participate as bidders

### ⚠️ Trust Assumptions

1. **Fhenix Network**: Relies on Fhenix's FHE implementation
2. **CoFHE Oracle**: Trusts oracle for correct decryption (verified via signatures)
3. **Block Timestamp**: Auction end time based on block.timestamp
4. **Network Liveness**: Requires at least one account to call finalize

### ⚠️ Known Limitations

1. **No Automatic Finalization**: Currently requires manual call to finalizeAuction
2. **Encrypted Treasury Balance**: Cannot view plaintext balance on-chain
3. **One Bid Per Bidder**: Cannot bid multiple times in same auction
4. **Fixed Sealed-Bid Model**: No dutch auction or English auction variants

## Common Issues & Solutions

### Issue: "Insufficient gas deposit"
**Solution**: Increase gas deposit when creating auction (minimum 0.005 ETH)

### Issue: "Treasury not configured"
**Solution**: Set NEXT_PUBLIC_TREASURY_ADDRESS in .env.local

### Issue: "Only owner can manage treasury"
**Solution**: Connect wallet with Treasury owner address

### Issue: "Finalize button disabled"
**Solution**: 
1. Ensure auction time has passed
2. Click "End auction" first
3. Wait for CoFHE oracle decryption
4. Then click "Finalize"

## Deployment Checklist

- [ ] Deploy MockUSDC (for testing) or use existing USDC
- [ ] Deploy ConfidentialUSDC with USDC address
- [ ] Deploy Treasury with initial fee (e.g., 250 bps)
- [ ] Deploy SilentBidAuction with cUSDC and Treasury addresses
- [ ] Authorize SilentBidAuction in Treasury (call `authorizeContract`)
- [ ] Set contract addresses in .env.local
- [ ] Deploy frontend
- [ ] Verify on-chain if needed
- [ ] Create test auction to verify flow
- [ ] Document for users

## Support & Feedback

For issues or suggestions:
- GitHub: https://github.com/anomalyco/opencode
- Documentation: https://opencode.ai/docs
