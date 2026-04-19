# SilentBid Scripts — Sepolia

**Foundry scripts and contracts for SilentBid:** a privacy-focused layer on Uniswap's Continuous Clearing Auction (CCA). Bid prices and amounts stay offchain in **Chainlink CRE** until the auction closes; only commitments go onchain. This repo deploys CCA auctions, SilentBid (BlindPool) wrappers, and supports bid submission, status checks, and reveal/finalize via CRE.

---

## Overview

SilentBid adds **sealed-bid privacy** to CCA: participants submit bids through CRE workflows so validators, MEV bots, and other bidders cannot see prices or amounts until the auction ends. Clearing and settlement then follow standard CCA.

### Benefits

- **Fair price discovery** — Continuous clearing without timing games.
- **Deep liquidity** — Smooth transition into Uniswap V4 trading.
- **Permissionless** — Anyone can deploy or participate.
- **Sealed bids** — Prices and amounts handled in CRE; only aggregated results revealed after close.
- **MEV-resistant** — No front-running or sniping on bid data.

### What's Private vs Public

| Data            | During auction | After reveal      |
|-----------------|----------------|-------------------|
| Bid maxPrice    | Offchain (CRE) | Used for CCA      |
| Bid amount      | Offchain (CRE) | Used for CCA      |
| Bidder address  | Visible        | Visible           |
| ETH deposit     | Visible        | Visible           |
| Number of bids  | Visible        | Visible           |
| Clearing price  | —              | Public (CCA)      |

---

## Sepolia Addresses

### Uniswap CCA (pre-deployed)

| Contract                    | Address                                         |
|----------------------------|--------------------------------------------------|
| CCA Factory v1.1.0         | `0xcca1101C61cF5cb44C968947985300DF945C3565`     |
| Liquidity Launcher         | `0x00000008412db3394C91A5CbD01635c6d140637C`     |
| FullRangeLBPStrategyFactory| `0x89Dd5691e53Ea95d19ED2AbdEdCf4cBbE50da1ff`    |
| AdvancedLBPStrategyFactory | `0xdC3553B7Cea1ad3DAB35cBE9d40728C4198BCBb6`    |
| UERC20Factory              | `0x0cde87c11b959e5eb0924c1abf5250ee3f9bd1b5`    |

---

## Prerequisites

- [Foundry](https://getfoundry.sh/) installed
- Sepolia ETH for gas ([faucet](https://sepoliafaucet.com/))
- Sepolia RPC URL (e.g. [Alchemy](https://alchemy.com/), [Infura](https://infura.io/))

---

## Setup

1. **Clone and install**

```bash
git clone https://github.com/ayushsingh82/Silentbid-scripts.git
cd Silentbid-scripts
forge install
```

2. **Configure environment**

```bash
cp .env.example .env
```

Edit `.env`:

- `SEPOLIA_RPC_URL` — Sepolia RPC endpoint  
- `PRIVATE_KEY` — Wallet private key (no `0x` prefix)  
- `DEPLOYER` — Your wallet address  
- `ETHERSCAN_API_KEY` — Optional, for verification  

3. **Build**

```bash
forge build
```

Use a wallet with Sepolia ETH (~0.005 ETH for deploys).

---

## Scripts

### SilentBid wrapper

**Deploy SilentBid on an existing CCA auction**

```bash
# With Make (uses PRIVATE_KEY from .env)
make deploy-silentbid AUCTION_ADDRESS=0xYourCCAAuctionAddress

# Or with forge
export AUCTION_ADDRESS=0xYourCCAAuctionAddress
forge script script/DeploySilentBid.s.sol --rpc-url https://1rpc.io/sepolia --broadcast --private-key $PRIVATE_KEY
```

**Deploy SilentBidFactory (for UI “Deploy SilentBid” button)**

Deploy once; then the app can create SilentBid wrappers from the UI (user signs with wallet, pays gas).

```bash
forge script script/DeploySilentBidFactory.s.sol --rpc-url https://1rpc.io/sepolia --broadcast --private-key $PRIVATE_KEY
```

Set in the app’s `.env.local`: `NEXT_PUBLIC_BLIND_POOL_FACTORY_ADDRESS=0x<FactoryAddress>`.

**Check SilentBid status**

```bash
make check SILENTBID_ADDRESS=0x...
```

**Reveal / finalize bids**

After the blind-bid deadline, CRE aggregates sealed bids and finalizes onchain. Use the reveal script when the workflow is wired:

```bash
make reveal SILENTBID_ADDRESS=0x...
```

---

### CCA auction (base layer)

**Deploy a new CCA auction** (mock token + auction)

```bash
source .env
forge script script/DeployCCA.s.sol:DeployCCA --rpc-url $SEPOLIA_RPC_URL --broadcast -vvvv
```

**Submit a bid**

```bash
AUCTION_ADDRESS=0x... forge script script/SubmitBid.s.sol:SubmitBid --rpc-url $SEPOLIA_RPC_URL --broadcast -vvvv
```

**Check auction status**

```bash
AUCTION_ADDRESS=0x... forge script script/CheckAuction.s.sol:CheckAuction --rpc-url $SEPOLIA_RPC_URL -vvvv
```

**Exit bid and claim tokens** (after auction ends)

```bash
AUCTION_ADDRESS=0x... BID_ID=0 forge script script/ExitAndClaim.s.sol:ExitAndClaim --rpc-url $SEPOLIA_RPC_URL --broadcast -vvvv
```

**Sweep unsold tokens and raised funds**

```bash
AUCTION_ADDRESS=0x... forge script script/SweepAuction.s.sol:SweepAuction --rpc-url $SEPOLIA_RPC_URL --broadcast -vvvv
```

---

## Auction parameters

| Parameter                   | Description                              |
|----------------------------|------------------------------------------|
| `currency`                 | Token for payment; `address(0)` = ETH   |
| `tokensRecipient`          | Receives leftover tokens                |
| `fundsRecipient`           | Receives raised funds                   |
| `startBlock` / `endBlock`  | Auction window                          |
| `claimBlock`               | When tokens can be claimed              |
| `tickSpacing`              | Min price increment                     |
| `floorPrice`               | Starting price (Q96)                     |
| `requiredCurrencyRaised`   | Min raise for graduation                |
| `auctionStepsData`         | Token issuance schedule                 |

### Price format (Q96)

Prices are Q96 fixed-point: ratio of currency to token, shifted left 96 bits.

Example: `79228162514264334008320` ≈ 1 ETH per 1,000,000 tokens.

```solidity
uint256 priceQ96 = (1 << 96) / 1_000_000; // 1 ETH per 1M tokens
```

---

## CRE / frontend integration

- **Frontend:** EIP-712 signed bid messages.
- **CRE:** Confidential HTTP endpoint verifies signatures, applies compliance, stores sealed bids offchain, and returns data for `submitBlindBid` / finalize.

Details and endpoints will be documented when the CRE workflow and HTTP bridge are finalized.

---

## Hackathon note (Privacy track)

This project uses **Chainlink Confidential Compute** and **CRE Confidential HTTP** for sealed-bid flows. Bid data and value flows are protected offchain; only commitments and settlement results are onchain. See the main [SilentBid app repo](https://github.com/ayushsingh82/BlindPool) for the UI and CRE workflow code.

---

## Resources

- [Uniswap CCA docs](https://docs.uniswap.org/contracts/liquidity-launchpad)
- [CCA whitepaper](https://docs.uniswap.org/concepts/liquidity-launchpad/whitepaper)
- [Uniswap CCA repo](https://github.com/Uniswap/continuous-clearing-auction)
- [Chainlink CRE](https://docs.chain.link/cre)
- [Compliant private transfer demo](https://github.com/smartcontractkit/compliant-private-transfer-demo)

---

**License:** MIT
