# USDC on Sepolia + Create Auction — CCA Side (Changes & Error)

For teammates: CCA repo changes for “our” factory and USDC on Sepolia, and the create-auction revert the app still hits.

---

## Goal

- Allow **USDC** as auction currency on **Sepolia** (no revert).
- Use **our own** CCA factory (different salt) so we control the deployed bytecode (e.g. `via_ir` for size limit).

---

## What Was Done (cca repo)

### 1. Deploy “our” CCA factory (Sepolia)

- **Script:** `lib/continuous-clearing-auction/script/deploy/DeployOurCCAFactory.s.sol`
- **Salt:** `keccak256("SilentBidCCA-our-factory-sepolia-v2")` (v2 = factory + auction both with `via_ir`).
- **Deployed address:** `0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107` (Sepolia).

Run from the CCA lib:

```bash
cd cca/lib/continuous-clearing-auction
source ../../.env   # or path to .env with PRIVATE_KEY, SEPOLIA_RPC_URL
forge script script/deploy/DeployOurCCAFactory.s.sol:DeployOurCCAFactoryScript \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --code-size-limit 50000
```

Or from `cca` root with full deploy script:

```bash
DEPLOY_OUR_CCA_FACTORY=1 bash script/deploy-sepolia.sh
```

Then set in the **Ethglobal** app `.env.local`:

```bash
NEXT_PUBLIC_CCA_FACTORY=0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107
```

### 2. Factory + auction both with `via_ir` (size limit)

- **File:** `lib/continuous-clearing-auction/foundry.toml`
- **Change:** `ContinuousClearingAuction.sol` added to `compilation_restrictions` with `via_ir = true` (so the auction created by the factory is also compiled with `via_ir` and stays under 24KB).

```toml
compilation_restrictions = [
  { paths = "src/ContinuousClearingAuctionFactory.sol", via_ir = true },
  { paths = "src/ContinuousClearingAuction.sol", via_ir = true }
]
```

### 3. Blocknumberish remapping (CCA lib build)

- **File:** `lib/continuous-clearing-auction/foundry.toml`
- **Change:** Extra remapping so `blocknumberish/src/` resolves and the CCA lib builds when running the deploy script from that directory:

```toml
"blocknumberish=lib/blocknumberish/",
"blocknumberish/src/=lib/blocknumberish/src/",
```

---

## Current Error (Create Auction from app)

When the **Ethglobal** app calls the factory’s `initializeDistribution(token, amount, configData, salt)` on Sepolia with USDC, the tx **reverts** and the wallet shows:

```text
Execution reverted for an unknown reason.
```

- **Factory:** `0x9D472Aaf29c062d602Edd13Ebb5C0F52B3085107`
- **Token:** e.g. `0xc4aAE767E65a18bF381c3159e58b899CA7f8561F`
- **Amount:** e.g. `1000000e18`
- **Config:** USDC as currency, 25-block duration, step data = 8 bytes (one step, blockDelta 25), endBlock = startBlock + 25.

So:

- Step data length and block/duration are now consistent (no `InvalidAuctionDataLength` / `InvalidEndBlockGivenStepData` from our encoding).
- The actual revert reason is **not** returned by the RPC/wallet (unknown reason).

Possible causes on the CCA side:

1. **Contract size limit** — If the auction bytecode is still &gt; 24KB when created by this factory, the creation would revert; the factory we use was built with auction `via_ir`.
2. **Some other CCA constructor check** — e.g. `FloorPriceAndTickSpacingGreaterThanMaxBidPrice`, `FloorPriceTooLow`, token/currency/recipient checks, etc.

To know for sure, someone needs to **simulate the same call** (same `to`, `data`, `from`) against Sepolia and capture the revert (e.g. with `cast call` or a small script that does `eth_call` and decodes the error `data`).

---

## Raw Calldata (for repro / cast)

From the last failing tx:

- **to:** `0x9d472aaf29c062d602edd13ebb5c0f52b3085107`
- **from:** `0x3bc07042670a3720c398da4cd688777b0565fd10`
- **data:** (hex in Ethglobal’s `USDC_SEPOLIA_AND_CREATE_AUCTION.md`)

Example (replace RPC and data as needed):

```bash
cast call 0x9d472aaf29c062d602edd13ebb5c0f52b3085107 \
  "0x03770504..." \
  --rpc-url $SEPOLIA_RPC_URL \
  --from 0x3bc07042670a3720c398da4cd688777b0565fd10
```

Then inspect the reverted error data to decode the CCA custom error.

---

## Files Touched (cca)

- `lib/continuous-clearing-auction/foundry.toml` — via_ir for auction, blocknumberish remapping.
- `lib/continuous-clearing-auction/script/deploy/DeployOurCCAFactory.s.sol` — salt v2.
- `script/deploy-sepolia.sh` — optional `DEPLOY_OUR_CCA_FACTORY=1` step and docs.

---

## Ethglobal doc

Same story from the app’s perspective (env, form, step encoding, block lock, current error, raw calldata, next steps): see **Ethglobal** repo’s `USDC_SEPOLIA_AND_CREATE_AUCTION.md`.
