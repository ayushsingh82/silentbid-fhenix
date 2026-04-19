# USDC on Sepolia + Create Auction — Changes & Current Error

For teammates: summary of what was done and the error we still hit when creating a USDC auction on Sepolia.

---

## Goal

- Use **USDC** as bid currency on **Sepolia** (for CRE private / compliant bidding).
- The official Uniswap CCA factory on Sepolia can revert for USDC; we use **our own** CCA factory.

---

## What Was Done (Ethglobal app)

1. **CCA factory override**  
   - `lib/auction-contracts.ts`: `CCA_FACTORY` is read from `NEXT_PUBLIC_CCA_FACTORY` (if set), else the official Uniswap factory.  
   - For Sepolia USDC we set `NEXT_PUBLIC_CCA_FACTORY=0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107` in `.env.local`.

2. **USDC enabled on Sepolia**  
   - Create form: currency dropdown allows USDC on Sepolia (no longer forced to ETH).  
   - Place-bid form: 3-step USDC flow (approve USDC → Permit2 → submitBid).

3. **Token decimals**  
   - Create form reads the auction token’s `decimals()` and uses it for total supply amount (no longer assumes 18 decimals).

4. **Auction step encoding (8 bytes per step)**  
   - CCA expects exactly **8 bytes per step** in `auctionStepsData`.  
   - We were emitting 17 hex chars (9 bytes) for a single step → `InvalidAuctionDataLength`.  
   - **Fix:** `toHex64()` formats each step as exactly 8 bytes (16 hex chars); `buildAuctionSteps()` uses it so length is always a multiple of 8.

5. **Block / duration consistency**  
   - To avoid `InvalidEndBlockGivenStepData`, we lock **one** `currentBlock` and **one** `durationBlocks` per submit:  
     `block = currentBlock ?? 0n`, `durationBlocks = durationOpt.blocks`, then `startBlock = block + 5n`, `endBlock = startBlock + BigInt(durationBlocks)`, and `buildAuctionSteps(durationBlocks)`.  
   - So step data total blocks and `endBlock - startBlock` always match.

6. **Simulation error handling**  
   - When simulation fails we try to decode CCA custom errors.  
   - If the RPC only returns an address, we do a raw `eth_call` to try to get the real revert data.  
   - “Submit anyway” button skips simulation and sends the tx (same params).

---

## Current Error (Create Auction — USDC on Sepolia)

When clicking **Create auction** (or **Submit anyway**), the wallet may report:

```text
Execution reverted for an unknown reason.
```

**Most common cause:** The CCA factory pulls the auction token from you via `transferFrom`. If you haven’t approved the factory to spend the token, the ERC20 transfer reverts and the wallet shows “unknown reason”. **Fix:** On the create form, use **“Approve auction token”** (after entering token and total supply). Then click **Create auction**. The app shows balance and factory allowance so you can confirm approval before creating.

- **From:** `0x3bc07042670a3720c398da4cd688777b0565fd10`
- **To (factory):** `0x9d472aaf29c062d602edd13ebb5c0f52b3085107`
- **Function:** `initializeDistribution(token, amount, configData, salt)`
- **Token:** `0xc4aAE767E65a18bF381c3159e58b899CA7f8561F`
- **Amount:** `1000000e18` (`0xd3c21bcecceda0000000` in calldata)
- **Currency (in config):** USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- **Recipients:** `0x3BC07042670a3720c398da4cd688777b0565Fd10`
- **Blocks (from last run):** startBlock `0x09bd04c` (10,211,404), endBlock `0x09bd065` (10,211,429) → **25 blocks** (matches step data).
- **Step data:** `0x08` + `061a800000000019` = 8 bytes, one step (mps 400000, blockDelta 25).

So block/duration and step length are now consistent; the revert reason is still not surfaced by the wallet/RPC.

---

## Raw Calldata (for debugging)

Full `data` from the failing tx (hex):

```text
0x03770504000000000000000000000000c4aae767e65a18bf381c3159e58b899ca7f8561f00000000000000000000000000000000000000000000d3c21bcecceda00000000000000000000000000000000000000000000000000000000000000000000080d053d6058fa2cea4dc7e508253dba81adf3e51ca1d3d05d33661f3701023f80e00000000000000000000000000000000000000000000000000000000000001a00000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000003bc07042670a3720c398da4cd688777b0565fd100000000000000000000000003bc07042670a3720c398da4cd688777b0565fd1000000000000000000000000000000000000000000000000000000000009bd04c00000000000000000000000000000000000000000000000000000000009bd06500000000000000000000000000000000000000000000000000000000009bd065000000000000000000000000000000000000000019999999999999999999999900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000199999999999999999999999000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000008061a800000000019000000000000000000000000000000000000000000000000
```

- Selector: `0x03770504` (`initializeDistribution(address,uint256,bytes,bytes32)`).
- Config’s `auctionStepsData`: length `0x08`, payload `061a800000000019` (8 bytes).

---

## Terminal Warnings (dev server)

When running the app you may see:

```text
WalletConnect Core is already initialized. This is probably a mistake and can lead to unexpected behavior. Init() was called 11 times.
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 pairing_create listeners added to [EventEmitter]. MaxListeners is 10.
```

- These point to WalletConnect / wagmi being initialized or subscribed to multiple times (e.g. in React strict mode or provider setup).
- They are separate from the on-chain revert; fixing them is optional (single init, or `emitter.setMaxListeners(n)` if intentional).

---

## Next Steps for Teammate

1. **Get the real revert reason**  
   - Simulate the same call (same `to`, `data`, `from`) with `cast call` or Foundry against Sepolia and capture the revert string / custom error.  
   - Or add a small script that does `eth_call` and parses the error `data` (e.g. decode CCA custom errors).

2. **Confirm factory and auction bytecode**  
   - Our Sepolia factory is `0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107` (deployed from `cca` with both factory and auction compiled with `via_ir` to stay under contract size limit).  
   - If the revert is “contract size limit”, the deployed factory may need to be redeployed from the same `via_ir` build.

3. **Try with ETH first**  
   - Create the same auction with “Bid currency: ETH” to see if the revert is USDC-specific (e.g. token/currency checks or Permit2 path).

4. **Docs in cca repo**  
   - See `USDC_SEPOLIA_AND_CREATE_AUCTION.md` in the **cca** repo for our factory deploy steps and CCA lib changes (via_ir, step encoding, salt).

---

## Files Touched (Ethglobal)

- `lib/auction-contracts.ts` — CCA_FACTORY from env, OFFICIAL_CCA_FACTORY, CCA_REVERT_ABI.
- `app/auctions/new/create-auction-form.tsx` — USDC on Sepolia, decimals, `toHex64`/`buildAuctionSteps`, block/duration lock, simulation + “Submit anyway”, error decoding.
- `app/auctions/[id]/place-bid-form.tsx` — USDC 3-step flow.
- `.env.local` — `NEXT_PUBLIC_CCA_FACTORY=0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107`.
