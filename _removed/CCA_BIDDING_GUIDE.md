# CCA Bidding — Which Contract, Which Function, and Common Errors

Your teammate can **create** the auction (via the Factory) but **cannot place a bid**. This guide explains exactly which contract and function to use, and the most likely errors (found by reading the CCA code).

---

## 1. Which contract to use for bidding

| Action | Contract | Address |
|--------|----------|--------|
| **Create auction** | CCA **Factory** | `0xcca1101C61cF5cb44C968947985300DF945C3565` |
| **Place bid** | **Auction** (the one created by the factory) | **Not** the factory — the **auction** address returned when you called `initializeDistribution` |

**Critical:** Bids go to the **auction contract address**, not the factory. If your teammate is calling the factory to place a bid, it will fail (the factory has no `submitBid`). In the app, the bid form is called with the auction address from the URL: `/auctions/<AUCTION_ADDRESS>`. So they must open the **auction page** (click the auction in the list or go to `/auctions/0x<auction_address>`) and use the “Place bid” form there — that form already calls the correct contract (the auction).

---

## 2. Function to call to place a bid

**Contract:** the **auction** contract (the address of the auction you created).

**Function:**

```text
submitBid(uint256 maxPrice, uint128 amount, address owner, bytes calldata hookData)
```

- **Payable:** yes — send ETH with the call.
- **For ETH auctions:** `msg.value` must **exactly equal** `amount` (both in wei). The contract reverts with `InvalidAmount()` if they differ.

**Parameters:**

| Parameter | Meaning | Example |
|-----------|---------|--------|
| `maxPrice` | Max price per token, **Q96** encoding | Use the same Q96 encoding as floor/clearing (e.g. from `ethToQ96("0.001")` for 0.001 ETH per token) |
| `amount` | ETH to commit, in **wei** (uint128) | e.g. `parseEther("0.01")` → 0.01 ETH |
| `owner` | Bidder address (who gets the bid/tokens) | Usually `msg.sender` / connected wallet |
| `hookData` | Data for validation hook | `0x` or empty bytes if no hook |

**Frontend (already in place):** The app’s “Place bid” form calls this on the auction contract with `value: amountWei`. So the **contract address** in that flow must be the **auction** address (it is, when you open `/auctions/<auction_address>`).

---

## 3. Most likely error: `TokensNotReceived` (auction not activated)

From the CCA contract, bidding is only allowed when the auction is “active”. The modifier `onlyActiveAuction` does:

```solidity
if (_getBlockNumberish() < START_BLOCK) revert AuctionNotStarted();
if (!$_tokensReceived) revert TokensNotReceived();
```

So if **`onTokensReceived()` was never called** on the auction after minting tokens, **every bid reverts with `TokensNotReceived()`**.

**Fix (required after creating an auction):**

1. **Mint** the total supply of your ERC20 to the **auction contract address** (not to the factory).
2. Then call **on the auction contract**:  
   **`onTokensReceived()`**  
   (no arguments, non‑payable).

Until this is done, the auction will not accept bids. Your teammate should:

- Get the **auction address** from the tx that created the auction (return value of `initializeDistribution` or the `AuctionCreated` event).
- Mint tokens to that address.
- Call `auction.onTokensReceived()` (e.g. from the same wallet that created the auction or any account).

---

## 4. Other errors the contract can throw (from the code)

| Revert | Condition | What to do |
|--------|-----------|------------|
| **TokensNotReceived** | `onTokensReceived()` not called yet | Mint tokens to auction, then call `onTokensReceived()` on the **auction** contract. |
| **AuctionNotStarted** | Current block &lt; `startBlock` | Wait until `startBlock` (or increase start block when creating the auction). |
| **AuctionIsOver** | Current block ≥ `endBlock` | Auction has ended; no more bids. |
| **InvalidAmount** | For ETH: `msg.value != amount` | Send exactly `amount` wei as `msg.value` (e.g. in the app, `value: amountWei` with `amountWei = parseEther(amount)`). |
| **BidAmountTooSmall** | `amount == 0` | Use a positive amount (e.g. &gt; 0 ETH). |
| **BidOwnerCannotBeZeroAddress** | `owner == address(0)` | Pass a valid bidder address (e.g. connected wallet). |
| **BidMustBeAboveClearingPrice** | `maxPrice <= current clearing price` | Use a **strictly higher** max price (in Q96) than the current clearing price. |
| **InvalidBidPriceTooHigh** | `maxPrice > MAX_BID_PRICE` | Lower max price (contract enforces a cap). |
| **AuctionSoldOut** | No more tokens to sell in the schedule | Auction is sold out; no more bids. |

So: wrong contract (e.g. factory), wrong time window, or **missing `onTokensReceived()`** are the usual causes. The single most common fix is: **mint to the auction address, then call `onTokensReceived()` on that auction contract.**

---

## 5. Checklist for your teammate

1. **Bid on the auction contract**  
   Use the **auction** address (from create tx or `/auctions/<auction_address>`), not the factory.

2. **Activate the auction**  
   - Mint total supply to the **auction** address.  
   - Call **`onTokensReceived()`** on the **auction** contract (one-time, after first mint).

3. **Bid only when active**  
   Current block must be ≥ `startBlock` and &lt; `endBlock`.

4. **Bid params**  
   - `amount` = ETH in wei; send the same value as `msg.value`.  
   - `maxPrice` = Q96; must be **above** the current clearing price.  
   - `owner` = bidder address; `hookData` = `0x` if no hook.

5. **In the app**  
   Open the auction from the list (so the URL is `/auctions/0x<auction_address>`) and use “Place bid” there — that already calls `submitBid` on the correct (auction) contract.

---

## 6. Summary

- **Create auction:** CCA **Factory** → `initializeDistribution(...)`.
- **Place bid:** **Auction** contract → `submitBid(maxPrice, amount, owner, hookData)` with `msg.value = amount` (for ETH).
- **#1 reason bids fail:** auction not activated → **mint tokens to the auction, then call `onTokensReceived()` on the auction contract.**
