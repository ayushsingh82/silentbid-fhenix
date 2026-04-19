#!/bin/bash
set -e

# ============================================================
#  SilentBid CCA - Deploy to Sepolia (Chainlink CRE)
# ============================================================
#
#  Deploys:
#    1. ERC20Mock token
#    2. CCA auction (via Uniswap CCA Factory on Sepolia)
#    3. SilentBidCCA privacy wrapper (CRE sealed bids)
#
#  fhEVM contracts are ALREADY live on Sepolia:
#    ACL:           0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D
#    KMSVerifier:   0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A
#    InputVerifier: 0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0
#    Executor:      0x92C920834Ec8941d2C77D188936E1f7A6f49c127
#
#  Prerequisites:
#    - .env file with SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY
#    - Deployer wallet funded with Sepolia ETH
#
#  USDC on Sepolia (no revert): deploy our CCA factory, then point app to it:
#    DEPLOY_OUR_CCA_FACTORY=1 bash script/deploy-sepolia.sh
#    Then set NEXT_PUBLIC_CCA_FACTORY=<printed-address> in Ethglobal .env
#
#  Usage:
#    cd scripts/
#    bash script/deploy-sepolia.sh
#
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "============================================================"
echo "  SilentBid CCA - Sepolia Deployment"
echo "============================================================"
echo ""

# ── 1. Check .env ──
echo -e "${CYAN}[1/7]${NC} Checking environment..."

if [ ! -f ".env" ]; then
    echo ""
    echo -e "${YELLOW}No .env file found. Creating template...${NC}"
    cat > .env << 'ENVEOF'
# Sepolia RPC (Alchemy, Infura, or public)
SEPOLIA_RPC_URL=https://1rpc.io/sepolia

# Deployer private key (WITH 0x prefix)
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Etherscan API key (for contract verification)
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY_HERE
ENVEOF
    echo ""
    echo "  Created .env template. Please fill in:"
    echo "    - PRIVATE_KEY (your Sepolia wallet, needs ETH)"
    echo "    - SEPOLIA_RPC_URL (Alchemy/Infura recommended)"
    echo "    - ETHERSCAN_API_KEY (for verification)"
    echo ""
    echo "  Then re-run: bash script/deploy-sepolia.sh"
    exit 1
fi

source .env

# Validate required vars
if [ -z "$SEPOLIA_RPC_URL" ] || [[ "$SEPOLIA_RPC_URL" == *"1rpc.io"* ]] || [[ "$SEPOLIA_RPC_URL" == *"publicnode"* ]]; then
    echo -e "  ${YELLOW}Using public Sepolia RPC (may be rate-limited)${NC}"
fi

if [ -z "$PRIVATE_KEY" ] || [ "$PRIVATE_KEY" = "0xYOUR_PRIVATE_KEY_HERE" ]; then
    echo -e "  ${RED}ERROR: Set PRIVATE_KEY in .env${NC}"
    exit 1
fi

DEPLOYER=$(cast wallet address "$PRIVATE_KEY" 2>/dev/null)
if [ -z "$DEPLOYER" ]; then
    echo -e "  ${RED}ERROR: Invalid PRIVATE_KEY${NC}"
    exit 1
fi

BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$SEPOLIA_RPC_URL" --ether 2>/dev/null || echo "0")
echo "  Deployer:  $DEPLOYER"
echo "  Balance:   $BALANCE ETH"
echo "  Chain:     Sepolia (11155111)"

if [ "$BALANCE" = "0" ] || [ "$BALANCE" = "0.000000000000000000" ]; then
    echo -e "  ${RED}ERROR: Deployer has no Sepolia ETH${NC}"
    echo "  Get testnet ETH from: https://www.alchemy.com/faucets/ethereum-sepolia"
    exit 1
fi

# ── 2. Verify fhEVM is live on Sepolia ──
echo ""
echo -e "${CYAN}[2/7]${NC} Verifying fhEVM on Sepolia..."

ACL_ADDR="0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D"
EXECUTOR_ADDR="0x92C920834Ec8941d2C77D188936E1f7A6f49c127"
KMS_ADDR="0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A"
INPUT_ADDR="0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0"

ACL_SIZE=$(cast codesize "$ACL_ADDR" --rpc-url "$SEPOLIA_RPC_URL" 2>/dev/null || echo "0")
EXEC_SIZE=$(cast codesize "$EXECUTOR_ADDR" --rpc-url "$SEPOLIA_RPC_URL" 2>/dev/null || echo "0")

echo "  ACL:      $ACL_ADDR ($ACL_SIZE bytes)"
echo "  Executor: $EXECUTOR_ADDR ($EXEC_SIZE bytes)"
echo "  KMS:      $KMS_ADDR"
echo "  Input:    $INPUT_ADDR"

if [ "$ACL_SIZE" = "0" ] || [ "$EXEC_SIZE" = "0" ]; then
    echo -e "  ${RED}ERROR: fhEVM contracts not found on Sepolia!${NC}"
    exit 1
fi
echo -e "  ${GREEN}fhEVM live on Sepolia${NC}"

# ── 3. Build ──
echo ""
echo -e "${CYAN}[3/7]${NC} Building contracts..."
forge build --quiet 2>/dev/null || forge build
echo "  Build OK"

# ── 3.5. (Optional) Deploy our CCA factory for USDC on Sepolia ──
if [ -n "${DEPLOY_OUR_CCA_FACTORY:-}" ]; then
    echo ""
    echo -e "${CYAN}[3.5]${NC} Deploying our CCA factory (for USDC on Sepolia)..."
    CCA_LIB="$ROOT_DIR/lib/continuous-clearing-auction"
    if [ ! -d "$CCA_LIB" ]; then
        echo -e "  ${YELLOW}Skip: $CCA_LIB not found${NC}"
    else
        OUR_FACTORY_OUTPUT=$(cd "$CCA_LIB" && forge script script/deploy/DeployOurCCAFactory.s.sol:DeployOurCCAFactoryScript \
            --rpc-url "$SEPOLIA_RPC_URL" \
            --private-key "$PRIVATE_KEY" \
            --broadcast \
            -vv 2>&1)
        OUR_FACTORY=$(echo "$OUR_FACTORY_OUTPUT" | grep "Our CCA Factory deployed to:" | sed 's/.*: *//' | tr -d ' ')
        if [ -n "$OUR_FACTORY" ]; then
            echo -e "  ${GREEN}Our CCA Factory: $OUR_FACTORY${NC}"
            echo ""
            echo "  To use USDC on Sepolia in the app, set in Ethglobal .env:"
            echo "    NEXT_PUBLIC_CCA_FACTORY=$OUR_FACTORY"
            echo ""
        fi
    fi
fi

# ── 4. Deploy CCA ──
echo ""
echo -e "${CYAN}[4/7]${NC} Deploying CCA auction..."
echo "  Factory: 0xcca1101C61cF5cb44C968947985300DF945C3565"
echo ""

CCA_OUTPUT=$(forge script script/DeployCCA.s.sol:DeployCCA \
    --rpc-url "$SEPOLIA_RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    --code-size-limit 50000 \
    -vv 2>&1)

echo "$CCA_OUTPUT" | grep -E "Token|Auction|Supply|Duration|Block|Deployer" || true

# Parse auction address from output
AUCTION_ADDRESS=$(echo "$CCA_OUTPUT" | grep "Auction Address:" | awk '{print $NF}')
TOKEN_ADDRESS=$(echo "$CCA_OUTPUT" | grep "Token Address:" | awk '{print $NF}')

if [ -z "$AUCTION_ADDRESS" ]; then
    echo ""
    echo -e "${YELLOW}Could not parse auction address from output.${NC}"
    echo "  Check broadcast output above."
    echo "  If it deployed, find the address in:"
    echo "    broadcast/DeployCCA.s.sol/11155111/run-latest.json"
    echo ""
    # Try to get from broadcast JSON
    AUCTION_ADDRESS=$(cat broadcast/DeployCCA.s.sol/11155111/run-latest.json 2>/dev/null | \
        python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; print([t['contractAddress'] for t in txs if t.get('contractName')=='ContinuousClearingAuction'][0])" 2>/dev/null || echo "")
    TOKEN_ADDRESS=$(cat broadcast/DeployCCA.s.sol/11155111/run-latest.json 2>/dev/null | \
        python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; print([t['contractAddress'] for t in txs if t.get('contractName')=='ERC20Mock'][0])" 2>/dev/null || echo "")

    if [ -z "$AUCTION_ADDRESS" ]; then
        echo -e "  ${RED}ERROR: Could not determine auction address${NC}"
        echo "  Set AUCTION_ADDRESS manually and re-run step 5"
        exit 1
    fi
fi

echo ""
echo -e "  ${GREEN}CCA deployed:  $AUCTION_ADDRESS${NC}"
echo "  Token:       $TOKEN_ADDRESS"

# ── 5. Deploy SilentBidCCA ──
echo ""
echo -e "${CYAN}[5/7]${NC} Deploying SilentBidCCA privacy wrapper..."
echo "  Pointing to CCA: $AUCTION_ADDRESS"
echo ""

export AUCTION_ADDRESS="$AUCTION_ADDRESS"

SILENTBID_OUTPUT=$(forge script script/DeploySilentBid.s.sol:DeploySilentBid \
    --rpc-url "$SEPOLIA_RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    --code-size-limit 50000 \
    -vv 2>&1)

echo "$SILENTBID_OUTPUT" | grep -E "SilentBid|CCA|Block|Deadline|Admin|deployed" || true

SILENTBID_ADDRESS=$(echo "$SILENTBID_OUTPUT" | grep "SilentBidCCA deployed to:" | awk '{print $NF}')

if [ -z "$SILENTBID_ADDRESS" ]; then
    SILENTBID_ADDRESS=$(cat broadcast/DeploySilentBid.s.sol/11155111/run-latest.json 2>/dev/null | \
        python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; print([t['contractAddress'] for t in txs if t.get('contractName')=='SilentBidCCA'][0])" 2>/dev/null || echo "")
fi

if [ -z "$SILENTBID_ADDRESS" ]; then
    echo -e "  ${RED}ERROR: Could not determine SilentBid address${NC}"
    exit 1
fi

echo ""
echo -e "  ${GREEN}SilentBid deployed: $SILENTBID_ADDRESS${NC}"

# ── 6. Verify on Etherscan (optional) ──
echo ""
echo -e "${CYAN}[6/7]${NC} Verifying contracts on Etherscan..."

if [ -n "$ETHERSCAN_API_KEY" ] && [ "$ETHERSCAN_API_KEY" != "YOUR_ETHERSCAN_KEY_HERE" ]; then
    echo "  Verifying SilentBidCCA..."
    forge verify-contract "$SILENTBID_ADDRESS" \
        src/SilentBidCCA.sol:SilentBidCCA \
        --chain sepolia \
        --etherscan-api-key "$ETHERSCAN_API_KEY" \
        --constructor-args $(cast abi-encode "constructor(address,uint64)" "$AUCTION_ADDRESS" "$(cast call "$SILENTBID_ADDRESS" "silentBidDeadline()(uint64)" --rpc-url "$SEPOLIA_RPC_URL")") \
        2>&1 | tail -3 || echo "  Verification may take a moment..."
else
    echo -e "  ${YELLOW}Skipped (no ETHERSCAN_API_KEY)${NC}"
fi

# ── 7. Summary ──
echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo ""
echo "  Network:          Sepolia (chainId: 11155111)"
echo "  Deployer:         $DEPLOYER"
echo ""
echo "  Contracts:"
echo "    Token:          $TOKEN_ADDRESS"
echo "    CCA Auction:    $AUCTION_ADDRESS"
echo "    SilentBidCCA:   $SILENTBID_ADDRESS"
echo ""
echo "  fhEVM (already on Sepolia):"
echo "    ACL:            $ACL_ADDR"
echo "    Executor:       $EXECUTOR_ADDR"
echo "    KMS Verifier:   $KMS_ADDR"
echo "    Input Verifier: $INPUT_ADDR"
echo ""
echo "  ────────────────────────────────────────────────"
echo "  Frontend SDK Config (fhevmjs):"
echo "  ────────────────────────────────────────────────"
echo ""
echo "  const instance = await createInstance({"
echo "    aclContractAddress: '$ACL_ADDR',"
echo "    kmsContractAddress: '$KMS_ADDR',"
echo "    inputVerifierContractAddress: '$INPUT_ADDR',"
echo "    verifyingContractAddressDecryption:"
echo "      '0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478',"
echo "    verifyingContractAddressInputVerification:"
echo "      '0x483b9dE06E4E4C7D35CCf5837A1668487406D955',"
echo "    chainId: 11155111,"
echo "    gatewayChainId: 10901,"
echo "    network: '${SEPOLIA_RPC_URL}',"
echo "    relayerUrl: 'https://relayer.testnet.zama.org',"
echo "  });"
echo ""
echo "  ────────────────────────────────────────────────"
echo "  Contract Addresses for Frontend:"
echo "  ────────────────────────────────────────────────"
echo ""
echo "  SILENTBID_ADDRESS=$SILENTBID_ADDRESS"
echo "  CCA_ADDRESS=$AUCTION_ADDRESS"
echo "  TOKEN_ADDRESS=$TOKEN_ADDRESS"
echo ""
echo "  ────────────────────────────────────────────────"
echo "  How to submit a sealed bid (frontend):"
echo "  ────────────────────────────────────────────────"
echo ""
echo "  // 1. Compute commitment (EIP-712 or keccak256)"
echo "  const commitment = computeBidCommitment(auctionId, sender, maxPrice, amount, timestamp);"
echo ""
echo "  // 2. Submit to SilentBidCCA"
echo "  await silentBid.submitSilentBid(commitment, { value: ethDeposit });"
echo ""
echo "  ────────────────────────────────────────────────"
echo "  Management commands:"
echo "  ────────────────────────────────────────────────"
echo ""
echo "  # Check status"
echo "  SILENTBID_ADDRESS=$SILENTBID_ADDRESS \\"
echo "    forge script script/CheckSilentBid.s.sol \\"
echo "    --rpc-url \$SEPOLIA_RPC_URL -vv"
echo ""
echo "  # After deadline: CRE workflow calls forwardBidToCCA"
echo "  SILENTBID_ADDRESS=$SILENTBID_ADDRESS \\"
echo "    forge script script/RevealSilentBid.s.sol \\"
echo "    --rpc-url \$SEPOLIA_RPC_URL -vv"
echo ""
echo "============================================================"

# Save deployment info
DEPLOY_FILE=".deployments/sepolia-$(date +%Y%m%d-%H%M%S).env"
mkdir -p .deployments
cat > "$DEPLOY_FILE" << EOF
# Sepolia Deployment - $(date)
TOKEN_ADDRESS=$TOKEN_ADDRESS
AUCTION_ADDRESS=$AUCTION_ADDRESS
SILENTBID_ADDRESS=$SILENTBID_ADDRESS
DEPLOYER=$DEPLOYER
CHAIN_ID=11155111
EOF

echo "  Deployment saved to: $DEPLOY_FILE"
echo ""
