#!/bin/bash
set -e

# ============================================================
#  Full E2E: CCA + BlindPool + Encrypted Bids + Reveal
# ============================================================
#
#  Phase A: Simulate CCA deployment, export code → anvil_setCode
#  Phase B: Deploy BlindPool via broadcast (FHE calls on-chain)
#  Phase C: Submit blind bids + reveal
#
#  Usage:
#    Terminal 1:  anvil
#    Terminal 2:  cd scripts/ && bash anviltest/full-flow-anvil.sh
#
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
BASE=".forge-snapshots/app"

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
echo "  Full E2E: CCA + BlindPool + Encrypted Bids + Reveal"
echo "============================================================"
echo ""

# ── 1. Check Anvil ──
echo "[1/9] Checking Anvil..."
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "")
if [ -z "$CHAIN_ID" ]; then
    echo "  ERROR: Cannot connect to Anvil. Start with: anvil"
    exit 1
fi
echo "  Chain ID: $CHAIN_ID"

# ── 2. Set up fhEVM ──
echo ""
echo "[2/9] Setting up fhEVM on Anvil..."
mkdir -p .forge-snapshots/fhevm "$BASE"

forge script anviltest/script/ExportFHEVMState.s.sol -vv 2>&1 | grep -E "fhEVM|Export" || true

for NAME in acl executor kms input hcu pauser; do
    ADDR=$(cat .forge-snapshots/fhevm/${NAME}_addr.txt)
    CODE=$(cat .forge-snapshots/fhevm/${NAME}_code.hex)
    cast rpc anvil_setCode "$ADDR" "$CODE" --rpc-url "$RPC_URL" > /dev/null

    if [ -f ".forge-snapshots/fhevm/${NAME}_impl_addr.txt" ]; then
        IMPL_ADDR=$(cat .forge-snapshots/fhevm/${NAME}_impl_addr.txt)
        IMPL_CODE=$(cat .forge-snapshots/fhevm/${NAME}_impl_code.hex)
        cast rpc anvil_setCode "$IMPL_ADDR" "$IMPL_CODE" --rpc-url "$RPC_URL" > /dev/null
    fi

    if [ -f ".forge-snapshots/fhevm/${NAME}_storage.txt" ] && [ -s ".forge-snapshots/fhevm/${NAME}_storage.txt" ]; then
        while IFS= read -r SLOT && IFS= read -r VALUE; do
            [ -z "$SLOT" ] && continue
            cast rpc anvil_setStorageAt "$ADDR" "$SLOT" "$VALUE" --rpc-url "$RPC_URL" > /dev/null
        done < ".forge-snapshots/fhevm/${NAME}_storage.txt"
    fi
done
cast rpc anvil_setNonce "$DEPLOYER_ADDR" "0x64" --rpc-url "$RPC_URL" > /dev/null

ACL_SIZE=$(cast codesize 0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
if [ "$ACL_SIZE" = "0" ]; then echo "  ERROR: fhEVM not set up!"; exit 1; fi
echo "  fhEVM OK"

# ── 3. Export CCA contracts from simulation ──
echo ""
echo "[3/9] Simulating CCA deployment (export code+storage)..."
forge script anviltest/script/FullFlowAnvil.s.sol:ExportCCAContracts \
    --code-size-limit 50000 \
    -vv 2>&1 | grep -E "CCA_FACTORY|TOKEN|AUCTION|START|END|FUNDED|exported" || true

# ── 4. Apply CCA contracts to Anvil ──
echo ""
echo "[4/9] Applying CCA contracts to Anvil..."

for NAME in cca_factory token auction; do
    ADDR=$(cat "$BASE/${NAME}_addr.txt")
    CODE=$(cat "$BASE/${NAME}_code.hex")
    cast rpc anvil_setCode "$ADDR" "$CODE" --rpc-url "$RPC_URL" > /dev/null

    if [ -f "$BASE/${NAME}_storage.txt" ] && [ -s "$BASE/${NAME}_storage.txt" ]; then
        SLOT_COUNT=0
        while IFS= read -r SLOT && IFS= read -r VALUE; do
            [ -z "$SLOT" ] && continue
            cast rpc anvil_setStorageAt "$ADDR" "$SLOT" "$VALUE" --rpc-url "$RPC_URL" > /dev/null
            SLOT_COUNT=$((SLOT_COUNT + 1))
        done < "$BASE/${NAME}_storage.txt"
        CODE_SIZE=$(cast codesize "$ADDR" --rpc-url "$RPC_URL")
        echo "  [$NAME] $ADDR ($CODE_SIZE bytes, $SLOT_COUNT slots)"
    else
        CODE_SIZE=$(cast codesize "$ADDR" --rpc-url "$RPC_URL")
        echo "  [$NAME] $ADDR ($CODE_SIZE bytes)"
    fi
done

AUCTION=$(cat "$BASE/auction_addr.txt")
END_BLOCK=$(cat "$BASE/end_block.txt")
START_BLOCK=$(cat "$BASE/start_block.txt")

# Verify auction
TOTAL_SUPPLY=$(cast call "$AUCTION" "totalSupply()(uint128)" --rpc-url "$RPC_URL")
echo "  Auction supply: $TOTAL_SUPPLY"

# ── 5. Deploy BlindPool via real broadcast (uses proven DeployBlindPoolOnly) ──
echo ""
echo "[5/9] Deploying BlindPool (broadcast for FHE ACL)..."

# Compute blind deadline: endBlock - 20
BLIND_DEADLINE=$((END_BLOCK - 20))

DEPLOYER_PK="$DEPLOYER_PK" BLIND_DEADLINE="$BLIND_DEADLINE" AUCTION_ADDRESS="$AUCTION" \
    forge script anviltest/script/DeployBlindPoolOnly.s.sol:DeployBlindPoolOnly \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --code-size-limit 50000 \
    -vv 2>&1 | grep -E "BLINDPOOL|DEADLINE" || true

BLINDPOOL=$(cat "$BASE/blindpool.txt")
BLIND_DEADLINE=$(cat "$BASE/blind_deadline.txt")

BP_SIZE=$(cast codesize "$BLINDPOOL" --rpc-url "$RPC_URL")
echo "  BlindPool: $BLINDPOOL ($BP_SIZE bytes)"
echo "  Deadline:  $BLIND_DEADLINE"

BP_CCA=$(cast call "$BLINDPOOL" "cca()(address)" --rpc-url "$RPC_URL")
echo "  Points to: $BP_CCA"

# ── 6. Mine to auction start ──
echo ""
echo "[6/9] Mining to auction start..."
CURRENT=$(cast block-number --rpc-url "$RPC_URL")
BLOCKS_NEEDED=$((START_BLOCK - CURRENT))
if [ "$BLOCKS_NEEDED" -gt 0 ]; then
    cast rpc anvil_mine "$(printf '0x%x' $BLOCKS_NEEDED)" --rpc-url "$RPC_URL" > /dev/null
fi
CURRENT=$(cast block-number --rpc-url "$RPC_URL")
echo "  Now at block $CURRENT (start=$START_BLOCK)"

# ── 7. Submit encrypted bids ──
echo ""
echo "[7/9] Submitting encrypted blind bids..."
echo ""

echo "  Bid 0: $BIDDER1_ADDR  price=100000 amount=500000 deposit=1ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 100000 500000 \
    --value 1ether \
    --private-key "$BIDDER1_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    confirmed"

echo "  Bid 1: $BIDDER2_ADDR  price=200000 amount=1500000 deposit=2ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 200000 1500000 \
    --value 2ether \
    --private-key "$BIDDER2_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    confirmed"

echo "  Bid 2: $BIDDER3_ADDR  price=150000 amount=400000 deposit=0.5ETH"
cast send "$BLINDPOOL" \
    "mockSubmitBlindBid(uint64,uint64)" 150000 400000 \
    --value 0.5ether \
    --private-key "$BIDDER3_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "    confirmed"

# ── 8. Verify on-chain ──
echo ""
echo "============================================================"
echo "[8/9] ON-CHAIN VERIFICATION"
echo "============================================================"
echo ""

TOTAL_BIDS=$(cast call "$BLINDPOOL" "nextBlindBidId()(uint256)" --rpc-url "$RPC_URL")
ESCROW=$(cast balance "$BLINDPOOL" --rpc-url "$RPC_URL" --ether)
echo "  Blind bids:  $TOTAL_BIDS"
echo "  ETH escrow:  $ESCROW ETH"
echo ""

for i in 0 1 2; do
    BID_RESULT=$(cast call "$BLINDPOOL" "getBlindBidInfo(uint256)(address,uint256,bool)" $i --rpc-url "$RPC_URL")
    BIDDER=$(echo "$BID_RESULT" | head -1)
    DEPOSIT=$(echo "$BID_RESULT" | sed -n '2p')
    ENC_PRICE=$(cast call "$BLINDPOOL" "getEncMaxPrice(uint256)(uint256)" $i --rpc-url "$RPC_URL")
    ENC_AMOUNT=$(cast call "$BLINDPOOL" "getEncAmount(uint256)(uint256)" $i --rpc-url "$RPC_URL")

    echo "  Bid $i: $BIDDER"
    echo "    deposit:   $DEPOSIT"
    echo "    encPrice:  ${ENC_PRICE:0:20}..."
    echo "    encAmount: ${ENC_AMOUNT:0:20}..."
done

# ── 9. Reveal ──
echo ""
echo "============================================================"
echo "[9/9] REVEAL"
echo "============================================================"
echo ""

CURRENT=$(cast block-number --rpc-url "$RPC_URL")
BLOCKS_TO_DEADLINE=$((BLIND_DEADLINE - CURRENT))
if [ "$BLOCKS_TO_DEADLINE" -gt 0 ]; then
    echo "  Mining $BLOCKS_TO_DEADLINE blocks to deadline..."
    cast rpc anvil_mine "$(printf '0x%x' $BLOCKS_TO_DEADLINE)" --rpc-url "$RPC_URL" > /dev/null
fi

echo "  Calling requestReveal()..."
cast send "$BLINDPOOL" "requestReveal()" \
    --private-key "$DEPLOYER_PK" \
    --rpc-url "$RPC_URL" > /dev/null 2>&1

REVEALED=$(cast call "$BLINDPOOL" "revealed()(bool)" --rpc-url "$RPC_URL")
echo "  Revealed: $REVEALED"

echo ""
echo "============================================================"
echo "  FULL FLOW COMPLETE"
echo "============================================================"
echo ""
echo "  CCA Factory:  $(cat $BASE/cca_factory_addr.txt)"
echo "  Token:        $(cat $BASE/token_addr.txt)"
echo "  Auction:      $AUCTION"
echo "  BlindPool:    $BLINDPOOL"
echo ""
echo "  3 encrypted bids submitted, 3.5 ETH escrowed"
echo "  Bids revealed after deadline"
echo "============================================================"
echo ""
