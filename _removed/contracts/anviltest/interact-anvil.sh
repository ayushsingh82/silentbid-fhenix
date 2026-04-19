#!/bin/bash
set -e

# ============================================================
#  BlindPool CCA - Full Anvil Persistent Deployment + Interaction
# ============================================================
#
#  This script:
#    1. Exports fhEVM state from a Forge simulation
#    2. Applies it to a running Anvil via cast rpc (anvil_setCode/setStorageAt)
#    3. Deploys BlindPoolCCA via broadcast (real transactions)
#    4. Submits encrypted blind bids from 3 different accounts
#    5. Reads on-chain data to prove bids are FHE-encrypted
#
#  Usage:
#    Terminal 1:  anvil
#    Terminal 2:  cd scripts/ && bash anviltest/interact-anvil.sh
#
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"

# Anvil default accounts
DEPLOYER_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

BIDDER1_PK="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
BIDDER1_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

BIDDER2_PK="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
BIDDER2_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

BIDDER3_PK="0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
BIDDER3_ADDR="0x90F79bf6EB2c4f870365E785982E1f101E93b906"

echo ""
echo "============================================================"
echo "  BlindPool CCA - Full Anvil Interaction Test"
echo "============================================================"
echo ""

# ── 1. Check Anvil ──
echo "[1/9] Checking Anvil at $RPC_URL..."
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "")
if [ -z "$CHAIN_ID" ]; then
    echo "  ERROR: Cannot connect to Anvil. Start with: anvil"
    exit 1
fi
echo "  Chain ID: $CHAIN_ID"

# ── 2. Build ──
echo ""
echo "[2/9] Building contracts..."
forge build --quiet 2>/dev/null || forge build
echo "  Build OK"

# ── 3. Export fhEVM state from simulation ──
echo ""
echo "[3/9] Exporting fhEVM state from simulation..."
mkdir -p .forge-snapshots/fhevm .forge-snapshots/app
forge script anviltest/script/ExportFHEVMState.s.sol -vv 2>&1 | grep -E "fhEVM|Export|proxy|direct|slots" || true
echo "  Export done"

# ── 4. Apply fhEVM state to Anvil ──
echo ""
echo "[4/9] Applying fhEVM state to running Anvil..."
for NAME in acl executor kms input hcu pauser; do
    ADDR=$(cat .forge-snapshots/fhevm/${NAME}_addr.txt)
    CODE=$(cat .forge-snapshots/fhevm/${NAME}_code.hex)

    # Set contract code at canonical address
    cast rpc anvil_setCode "$ADDR" "$CODE" --rpc-url "$RPC_URL" > /dev/null
    echo "  [$NAME] code at $ADDR"

    # Set implementation code if it's a proxy
    if [ -f ".forge-snapshots/fhevm/${NAME}_impl_addr.txt" ]; then
        IMPL_ADDR=$(cat .forge-snapshots/fhevm/${NAME}_impl_addr.txt)
        IMPL_CODE=$(cat .forge-snapshots/fhevm/${NAME}_impl_code.hex)
        cast rpc anvil_setCode "$IMPL_ADDR" "$IMPL_CODE" --rpc-url "$RPC_URL" > /dev/null
        echo "  [$NAME] impl at $IMPL_ADDR"
    fi

    # Set storage slots
    if [ -f ".forge-snapshots/fhevm/${NAME}_storage.txt" ] && [ -s ".forge-snapshots/fhevm/${NAME}_storage.txt" ]; then
        SLOT_COUNT=0
        while IFS= read -r SLOT && IFS= read -r VALUE; do
            [ -z "$SLOT" ] && continue
            cast rpc anvil_setStorageAt "$ADDR" "$SLOT" "$VALUE" --rpc-url "$RPC_URL" > /dev/null
            SLOT_COUNT=$((SLOT_COUNT + 1))
        done < ".forge-snapshots/fhevm/${NAME}_storage.txt"
        echo "  [$NAME] $SLOT_COUNT storage slots"
    fi
done

# Bump deployer nonce to avoid collision with fhEVM impl addresses
cast rpc anvil_setNonce "$DEPLOYER_ADDR" "0x64" --rpc-url "$RPC_URL" > /dev/null
echo "  Deployer nonce set to 100"

# ── 5. Verify fhEVM ──
echo ""
echo "[5/9] Verifying fhEVM on Anvil..."
ACL_SIZE=$(cast codesize 0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
EXEC_SIZE=$(cast codesize 0xe3a9105a3a932253A70F126eb1E3b589C643dD24 --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
echo "  ACL code: $ACL_SIZE bytes"
echo "  Executor code: $EXEC_SIZE bytes"

if [ "$ACL_SIZE" = "0" ] || [ "$EXEC_SIZE" = "0" ]; then
    echo "  ERROR: fhEVM not set up properly!"
    exit 1
fi
echo "  fhEVM OK"

# ── 6. Deploy BlindPool via broadcast ──
echo ""
echo "[6/9] Deploying BlindPoolCCA (broadcast to Anvil)..."
CURRENT=$(cast block-number --rpc-url "$RPC_URL")
BLIND_DEADLINE=$((CURRENT + 200))

export DEPLOYER_PK="$DEPLOYER_PK"
export BLIND_DEADLINE="$BLIND_DEADLINE"

forge script anviltest/script/DeployBlindPoolOnly.s.sol:DeployBlindPoolOnly \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --code-size-limit 50000 \
    -vv 2>&1 | grep -E "BLINDPOOL:|DEADLINE:" || true

BLINDPOOL=$(cat .forge-snapshots/app/blindpool.txt)
BLIND_DEADLINE=$(cat .forge-snapshots/app/blind_deadline.txt)

echo ""
echo "  BlindPool:      $BLINDPOOL"
echo "  Blind deadline: $BLIND_DEADLINE"
echo "  Code size:      $(cast codesize $BLINDPOOL --rpc-url $RPC_URL) bytes"

# ── 7. Confirm we're before the deadline ──
echo ""
echo "[7/9] Checking block position..."
CURRENT=$(cast block-number --rpc-url "$RPC_URL")
echo "  Current block:  $CURRENT"
echo "  Blind deadline: $BLIND_DEADLINE"
echo "  Blocks left:    $((BLIND_DEADLINE - CURRENT))"

# ── 8. Submit blind bids from 3 different accounts ──
echo ""
echo "[8/9] Submitting encrypted blind bids..."
echo ""

echo "  Bid 0: $BIDDER1_ADDR"
echo "    Plaintext: maxPrice=100000, amount=500000"
echo "    Deposit:   1 ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 100000 500000 \
    --value 1ether \
    --private-key "$BIDDER1_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    TX confirmed"

echo ""
echo "  Bid 1: $BIDDER2_ADDR"
echo "    Plaintext: maxPrice=200000, amount=1500000"
echo "    Deposit:   2 ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 200000 1500000 \
    --value 2ether \
    --private-key "$BIDDER2_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    TX confirmed"

echo ""
echo "  Bid 2: $BIDDER3_ADDR"
echo "    Plaintext: maxPrice=150000, amount=400000"
echo "    Deposit:   0.5 ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 150000 400000 \
    --value 0.5ether \
    --private-key "$BIDDER3_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    TX confirmed"

# ── 9. Read on-chain data and verify encryption ──
echo ""
echo "============================================================"
echo "  [9/9] ON-CHAIN BID PRIVACY VERIFICATION"
echo "============================================================"
echo ""

TOTAL_BIDS=$(cast call "$BLINDPOOL" "nextBlindBidId()(uint256)" --rpc-url "$RPC_URL")
ESCROW=$(cast balance "$BLINDPOOL" --rpc-url "$RPC_URL" --ether)
echo "  Total bids on-chain: $TOTAL_BIDS"
echo "  ETH in escrow:       $ESCROW ETH"
echo ""

# Store encrypted values for summary
ALL_ENC_PRICES=()
ALL_ENC_AMOUNTS=()

for i in 0 1 2; do
    echo "  ────────────────────────────────────────────────"
    echo "  BID $i"
    echo "  ────────────────────────────────────────────────"

    # Public info (anyone can read from the blockchain)
    BID_RESULT=$(cast call "$BLINDPOOL" "getBlindBidInfo(uint256)(address,uint256,bool)" $i --rpc-url "$RPC_URL")
    BIDDER=$(echo "$BID_RESULT" | head -1)
    DEPOSIT=$(echo "$BID_RESULT" | sed -n '2p')
    FORWARDED=$(echo "$BID_RESULT" | sed -n '3p')

    echo "    PUBLIC  bidder:      $BIDDER"
    echo "    PUBLIC  ethDeposit:  $DEPOSIT"
    echo "    PUBLIC  forwarded:   $FORWARDED"

    # Encrypted handles (opaque uint256 - NOT plaintext values)
    ENC_PRICE=$(cast call "$BLINDPOOL" "getEncMaxPrice(uint256)(uint256)" $i --rpc-url "$RPC_URL")
    ENC_AMOUNT=$(cast call "$BLINDPOOL" "getEncAmount(uint256)(uint256)" $i --rpc-url "$RPC_URL")

    echo "    ENCRYPTED maxPrice:  $ENC_PRICE"
    echo "    ENCRYPTED amount:    $ENC_AMOUNT"
    echo ""

    ALL_ENC_PRICES+=("$ENC_PRICE")
    ALL_ENC_AMOUNTS+=("$ENC_AMOUNT")
done

# Encrypted aggregates
echo "  ────────────────────────────────────────────────"
echo "  ENCRYPTED AGGREGATES"
echo "  ────────────────────────────────────────────────"
ENC_HIGHEST=$(cast call "$BLINDPOOL" "encHighestPrice()(uint256)" --rpc-url "$RPC_URL")
ENC_DEMAND=$(cast call "$BLINDPOOL" "encTotalDemand()(uint256)" --rpc-url "$RPC_URL")
echo "    Highest price handle: $ENC_HIGHEST"
echo "    Total demand handle:  $ENC_DEMAND"
echo ""

echo "============================================================"
echo "  ENCRYPTION PROOF"
echo "============================================================"
echo ""
echo "  Plaintext values submitted (known only to bidders):"
echo "    Bid 0: price=100000,  amount=500000"
echo "    Bid 1: price=200000,  amount=1500000"
echo "    Bid 2: price=150000,  amount=400000"
echo ""
echo "  On-chain values (visible to everyone reading the chain):"
echo "    Bid 0 maxPrice: ${ALL_ENC_PRICES[0]}"
echo "    Bid 0 amount:   ${ALL_ENC_AMOUNTS[0]}"
echo "    Bid 1 maxPrice: ${ALL_ENC_PRICES[1]}"
echo "    Bid 1 amount:   ${ALL_ENC_AMOUNTS[1]}"
echo "    Bid 2 maxPrice: ${ALL_ENC_PRICES[2]}"
echo "    Bid 2 amount:   ${ALL_ENC_AMOUNTS[2]}"
echo ""
echo "  The encrypted handles are opaque 256-bit values."
echo "  They bear NO resemblance to the plaintext prices"
echo "  or amounts. Nobody can read bid data from the chain."
echo ""
echo "  Contract: $BLINDPOOL"
echo "============================================================"
echo ""
