
# CCA (Continuous Clearing Auction) Setup — ETH Sepolia

Quick reference for **where to init the auction**, **whether your form is correct**, **which contract to use for bidding**, and **what is already deployed**. Plain CCA only; CRE private bidding is in `md/CRE_INTEGRATION.md`.

---

## 1. What is already deployed (ETH Sepolia)

| Contract | Address | You deploy? |
|----------|---------|-------------|
| **CCA Factory** | `0xcca1101C61cF5cb44C968947985300DF945C3565` | **No** — use this. |
| **Your auction** | — | **Yes** — create it via the factory (see below). |
| **Your token** | — | **Yes** — deploy and mint to the auction. |

You do **not** deploy the factory. You only deploy your token and then **initialize** your auction through the existing factory.

---

## 2. Where to init the auction

**Init = call the CCA Factory’s `initializeDistribution`.**  
That creates the auction contract (one per token + params).

- **Contract to call:** **CCA Factory**  
  `0xcca1101C61cF5cb44C968947985300DF945C3565` (Sepolia)

- **Function:**  
  `initializeDistribution(address token, uint256 amount, bytes calldata configData, bytes32 salt)`  
  → returns `IDistributionContract` (your **auction** address).

- **Steps (match `cca/script/DeployCCA.s.sol`):**
  1. Deploy your ERC20 (or use a mock).
  2. Build `AuctionParameters` and encode as `configData` (see below).
  3. Call **factory**.`initializeDistribution(token, totalSupply, abi.encode(parameters), bytes32(0))`.
  4. Mint tokens to the **auction** address (the return value).
  5. Call **auction**.`onTokensReceived()` so the auction can start accepting bids.

There is **no separate “init” contract** — the **factory** is the only place you “init” the auction; it deploys the auction contract and you then fund it and call `onTokensReceived()`.

---

## 3. Is your form correct? (Create auction)

Your **create-auction form** (name, description, reserve price, duration) is currently **demo-only**: it does not call any contract. To make it “correct” for CCA:

- **Contract to use for creating the auction:**  
  **CCA Factory** (same address above).
- **Inputs that matter onchain:**  
  - **Token address** (you deploy this separately).  
  - **Total supply** (amount to sell in the auction).  
  - **configData** = `abi.encode(AuctionParameters)`.

**AuctionParameters** (from `IContinuousClearingAuction.sol`):

| Field | Type | Example / note |
|-------|------|-----------------|
| `currency` | address | `address(0)` = ETH |
| `tokensRecipient` | address | Who gets leftover tokens |
| `fundsRecipient` | address | Who gets raised ETH |
| `startBlock` | uint64 | First block auction is active |
| `endBlock` | uint64 | Last block for bids |
| `claimBlock` | uint64 | When claims are allowed (e.g. = endBlock) |
| `tickSpacing` | uint256 | Price granularity (Q96) |
| `validationHook` | address | `address(0)` = none |
| `floorPrice` | uint256 | Min price (Q96), e.g. reserve |
| `requiredCurrencyRaised` | uint128 | 0 = no minimum raise |
| `auctionStepsData` | bytes | Issuance schedule (see deploy script) |

So your **form is correct as a UI** if you eventually map:

- **Name/description** → offchain only (or your own indexer/DB).
- **Reserve price** → `floorPrice` (convert to Q96).
- **Duration** → `startBlock` / `endBlock` (convert from time to block numbers using Sepolia block time ~12s).

The **contract** that “creates” the auction is always the **Factory**; there is no other built-in contract where you “input the auction” — the factory takes token + amount + config and deploys the auction.

---

## 4. Bidding: which contract and which inputs

- **Contract to use for bidding:**  
  The **auction contract** (the address returned by `initializeDistribution`), **not** the factory.

- **Function:**  
  `submitBid(uint256 maxPrice, uint128 amount, address owner, bytes calldata hookData)`  
  (use the 4-arg overload; it uses floor as prev tick.)

- **For ETH:**
  - **amount** = ETH in **wei** (uint128).
  - **msg.value** must equal **amount** (the contract checks this).
  - **maxPrice** = your max price in Q96 (e.g. above `floorPrice`).

So in the UI:

- **Contract address** in the “Place bid” flow = **auction address** (one per auction).
- **Inputs:**  
  - **Amount (ETH)** → convert to wei → use as `amount` and send as `msg.value`.  
  - **Max price** → convert to Q96 and pass as `maxPrice`.  
  - **Owner** = bidder address (e.g. `msg.sender` or connected wallet).  
  - **hookData** = `0x` or empty bytes if no validation hook.

**Summary:**

| Action | Contract | Main input |
|--------|----------|------------|
| **Init / create auction** | CCA **Factory** `0xcca...565` | `initializeDistribution(token, amount, configData, salt)` |
| **Place bid** | **Auction** (address from init) | `submitBid(maxPrice, amountWei, owner, hookData)` with `msg.value = amountWei` |

---

## 5. Deploy checklist (Sepolia)

1. **Factory:** Use existing `0xcca1101C61cF5cb44C968947985300DF945C3565` — do **not** deploy.
2. **Token:** Deploy your ERC20 (or use `ERC20Mock` in script).
3. **Auction:** Call **factory**.`initializeDistribution(...)` → get **auction** address.
4. **Fund auction:** Mint tokens to **auction** address, then call **auction**.`onTokensReceived()`.
5. **Bidding:** Users call **auction**.`submitBid{ value: amountWei }(maxPrice, amountWei, owner, "")`.

---

## 6. Frontend (nextui-starter4) — what to plug in

- **Create auction:**  
  Wire the form to (1) deploy or select token, (2) build `AuctionParameters` from reserve + duration (and optionally name/description for offchain), (3) call **Factory** `initializeDistribution`, (4) mint to auction and call **auction** `onTokensReceived()`.  
  Contract: **Factory**. No built-in CCA contract “where you input the auction” other than this.

- **Place bid:**  
  Contract: **Auction** (from your backend or from the auction list).  
  Inputs: **Auction address**, **amount in wei**, **maxPrice (Q96)**, **owner**.  
  Send ETH = amount in wei with the tx.

- **Chain:** Add **Sepolia** to your wagmi chains so the app targets ETH Sepolia (factory and your deployments live there).

CRE-based sealed bids are in `md/CRE_INTEGRATION.md`; this doc is for plain CCA on Sepolia with the existing factory.
