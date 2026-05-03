// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IConfidentialUSDC {
    function transferFromAllowance(address from, address to) external returns (euint64);
    function transferEncrypted(address to, euint64 amount) external returns (euint64);
    function allowance(address owner, address spender) external view returns (euint64);
}

interface ITreasury {
    function feeBasisPoints() external view returns (uint16);
}

/// @title SilentBidAuction V2
/// @notice Sealed-bid auction with automated settlement, treasury fees,
///         and gas deposit system. After the auction deadline:
///         1. Anyone calls `endAuction` → FHE handles become publicly decryptable.
///         2. Anyone calls CoFHE `decryptForTx` off-chain to get oracle sigs.
///         3. Anyone calls `finalizeAuction` → publishes winner, settles ALL
///            bids atomically (winner pays seller minus fee, losers refunded,
///            fee goes to treasury). The caller is compensated from the gas pool.
///
/// @dev Changes from V1:
///   - `publishWinner` + per-bid `settleBid` merged into `finalizeAuction`.
///   - Auction creators deposit ETH for gas; bidders contribute a small gas fee.
///   - Platform fee (configurable via Treasury) deducted from winning bid.
///   - `revealMyBid` kept as bidder-only opt-in reveal.
contract SilentBidAuction {
    IConfidentialUSDC public immutable cUSDC;
    ITreasury public immutable treasury;
    address public owner;

    uint256 public minGasDeposit = 0.005 ether;
    uint256 public minBidGasFee  = 0.0005 ether;

    // ─── EIP-712 for meta-bids ────────────────────────────────────────────
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant BID_TYPEHASH = keccak256(
        "BidWithSignature(address bidder,uint256 auctionId,uint64 amount)"
    );

    struct Bid {
        address bidder;
        euint64 encAmount;
        bool settled;
        bool revealed;
    }

    struct Auction {
        address seller;
        string itemName;
        string itemDescription;
        uint64 minBidPlain;        // public floor (for UX)
        euint64 minBidEnc;         // encrypted floor (enforced on-chain)
        uint64 endTime;            // unix timestamp
        bool ended;
        bool finalized;            // true after finalizeAuction completes
        euint64 highestBid;
        eaddress highestBidder;
        uint64 winningAmountPlain; // published post-verify
        address winnerPlain;       // published post-verify
        bool decryptRequested;
        uint256 gasDeposit;        // ETH from auction creator
        uint256 bidGasPool;        // ETH from bidders
    }

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => Bid[]) public bids;
    mapping(uint256 => mapping(address => bool)) public hasBid;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        string itemName,
        uint64 minBidPlain,
        uint64 endTime,
        uint256 gasDeposit
    );
    event BidPlaced(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, bytes32 encAmountHandle);
    event AuctionEnded(uint256 indexed auctionId, bytes32 highestBidHandle, bytes32 highestBidderHandle);
    event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint64 amount, uint64 fee);
    event BidSettled(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, bool isWinner);
    event BidRevealed(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, bytes32 encAmountHandle);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(IConfidentialUSDC _cUSDC, ITreasury _treasury) {
        cUSDC = _cUSDC;
        treasury = _treasury;
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SilentBid"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ─── Owner functions ──────────────────────────────────────────────────

    function setMinGasDeposit(uint256 _min) external onlyOwner {
        minGasDeposit = _min;
    }

    function setMinBidGasFee(uint256 _min) external onlyOwner {
        minBidGasFee = _min;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Auction creation ──────────────────────────────────────────────────

    function createAuction(
        string calldata itemName,
        string calldata itemDescription,
        uint64 minBidPlain,
        uint64 durationSeconds
    ) external payable returns (uint256 auctionId) {
        require(durationSeconds >= 60, "duration too short");
        require(msg.value >= minGasDeposit, "insufficient gas deposit");

        auctionId = nextAuctionId++;
        Auction storage a = auctions[auctionId];
        a.seller = msg.sender;
        a.itemName = itemName;
        a.itemDescription = itemDescription;
        a.minBidPlain = minBidPlain;
        a.endTime = uint64(block.timestamp) + durationSeconds;
        a.gasDeposit = msg.value;

        // Initialise encrypted zero for running max.
        a.highestBid = FHE.asEuint64(0);
        a.highestBidder = FHE.asEaddress(address(0));
        FHE.allowThis(a.highestBid);
        FHE.allowThis(a.highestBidder);

        // Encrypted minimum bid for on-chain enforcement.
        a.minBidEnc = FHE.asEuint64(minBidPlain);
        FHE.allowThis(a.minBidEnc);

        emit AuctionCreated(auctionId, msg.sender, itemName, minBidPlain, a.endTime, msg.value);
    }

    // ─── Bid placement (3 variants) ────────────────────────────────────────

    /// @notice Place a bid directly (original flow). Requires gas fee as msg.value.
    function placeBid(uint256 auctionId) external payable returns (uint256 bidIndex) {
        return _placeBid(auctionId, msg.sender);
    }

    /// @notice Relayer submits a bid on behalf of `bidder`.
    function placeBidFor(uint256 auctionId, address bidder) external payable returns (uint256 bidIndex) {
        require(bidder != address(0), "bidder=0");
        return _placeBid(auctionId, bidder);
    }

    /// @notice Signature-verified meta-bid.
    function placeBidWithSignature(
        uint256 auctionId,
        address bidder,
        uint64 amount,
        bytes calldata signature
    ) external payable returns (uint256 bidIndex) {
        require(bidder != address(0), "bidder=0");
        bytes32 structHash = keccak256(abi.encode(BID_TYPEHASH, bidder, auctionId, amount));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, uint8(signature[64]), bytes32(signature[0:32]), bytes32(signature[32:64]));
        require(recovered != address(0) && recovered == bidder, "invalid signature");
        return _placeBid(auctionId, bidder);
    }

    /// @dev Core bid logic shared by all entry points.
    function _placeBid(uint256 auctionId, address bidder) internal returns (uint256 bidIndex) {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp < a.endTime, "auction ended");
        require(bidder != a.seller, "seller cannot bid");
        require(!hasBid[auctionId][bidder], "bid already placed");
        require(msg.value >= minBidGasFee, "insufficient gas fee");

        // Add gas fee to pool for settlement costs.
        a.bidGasPool += msg.value;

        // Pull the encrypted amount from the bidder's cUSDC allowance.
        euint64 encAmount = cUSDC.transferFromAllowance(bidder, address(this));

        // Enforce minimum bid on-chain via FHE comparison.
        ebool meetsMin = FHE.gt(encAmount, a.minBidEnc);
        encAmount = FHE.select(meetsMin, encAmount, FHE.asEuint64(0));
        FHE.allowThis(encAmount);

        // Running-max update inside FHE.
        ebool isHigher = FHE.gt(encAmount, a.highestBid);
        a.highestBid = FHE.max(encAmount, a.highestBid);
        a.highestBidder = FHE.select(isHigher, FHE.asEaddress(bidder), a.highestBidder);
        FHE.allowThis(a.highestBid);
        FHE.allowThis(a.highestBidder);

        // Grant ACL so we can refund/transfer at settlement.
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, address(cUSDC));
        FHE.allow(encAmount, bidder);

        bidIndex = bids[auctionId].length;
        bids[auctionId].push(Bid({
            bidder: bidder,
            encAmount: encAmount,
            settled: false,
            revealed: false
        }));
        hasBid[auctionId][bidder] = true;
        emit BidPlaced(auctionId, bidIndex, bidder, euint64.unwrap(encAmount));
    }

    // ─── Auction close ────────────────────────────────────────────────────

    /// @notice Close bidding, make the winner handles publicly decryptable.
    ///         After this, call CoFHE decryptForTx off-chain, then finalizeAuction.
    function endAuction(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp >= a.endTime, "not ended");
        require(!a.ended, "already ended");
        a.ended = true;
        a.decryptRequested = true;

        FHE.allowPublic(a.highestBid);
        FHE.allowPublic(a.highestBidder);

        emit AuctionEnded(auctionId, euint64.unwrap(a.highestBid), eaddress.unwrap(a.highestBidder));
    }

    // ─── Finalize: publish winner + settle all bids + collect fee ──────────

    /// @notice Atomic finalization: verifies CoFHE oracle decryption, publishes
    ///         the winner, settles every bid (winner→seller minus fee, losers→refund),
    ///         sends fee to treasury, and compensates the caller from the gas pool.
    ///         Anyone can call this — incentivized by gas compensation.
    function finalizeAuction(
        uint256 auctionId,
        address winner,
        uint64 amount,
        bytes calldata winnerSig,
        bytes calldata amountSig
    ) external {
        uint256 startGas = gasleft();

        Auction storage a = auctions[auctionId];
        require(a.ended, "not ended");
        require(!a.finalized, "already finalized");

        // ── Step 1: Verify and publish CoFHE oracle results ──
        FHE.publishDecryptResult(a.highestBidder, winner, winnerSig);
        FHE.publishDecryptResult(a.highestBid, amount, amountSig);

        address oracleWinner = FHE.getDecryptResult(a.highestBidder);
        require(oracleWinner == winner, "winner mismatch");

        uint64 oracleAmount = FHE.getDecryptResult(a.highestBid);
        require(oracleAmount == amount, "amount mismatch");

        a.winnerPlain = winner;
        a.winningAmountPlain = amount;

        // ── Step 2: Calculate fee ──
        uint16 feeBps = treasury.feeBasisPoints();
        uint64 feeAmount = uint64((uint256(amount) * feeBps) / 10000);

        // ── Step 3: Settle all bids ──
        uint256 numBids = bids[auctionId].length;
        for (uint256 i = 0; i < numBids; i++) {
            Bid storage b = bids[auctionId][i];
            if (b.settled) continue;
            b.settled = true;

            if (b.bidder == winner && feeAmount > 0) {
                // Winner: split into (net → seller) and (fee → treasury)
                euint64 feeEnc = FHE.asEuint64(feeAmount);
                euint64 netEnc = FHE.sub(b.encAmount, feeEnc);
                FHE.allowThis(netEnc);
                FHE.allowThis(feeEnc);
                FHE.allow(netEnc, address(cUSDC));
                FHE.allow(feeEnc, address(cUSDC));

                cUSDC.transferEncrypted(a.seller, netEnc);
                cUSDC.transferEncrypted(address(treasury), feeEnc);
            } else if (b.bidder == winner) {
                // Winner, zero fee: full amount to seller
                cUSDC.transferEncrypted(a.seller, b.encAmount);
            } else {
                // Loser: refund to bidder
                cUSDC.transferEncrypted(b.bidder, b.encAmount);
            }
            emit BidSettled(auctionId, i, b.bidder, b.bidder == winner);
        }

        a.finalized = true;
        emit AuctionFinalized(auctionId, winner, amount, feeAmount);

        // ── Step 4: Gas compensation ──
        uint256 gasPool = a.gasDeposit + a.bidGasPool;
        if (gasPool > 0) {
            uint256 gasUsed = startGas - gasleft() + 40000; // +40k for the transfer itself
            uint256 compensation = gasUsed * tx.gasprice;
            uint256 payout = compensation > gasPool ? gasPool : compensation;

            // Pay the finalizer
            if (payout > 0) {
                (bool ok, ) = payable(msg.sender).call{value: payout}("");
                if (!ok) payout = 0; // don't revert if refund fails
            }

            // Refund remaining gas pool to auction creator
            uint256 remaining = gasPool - payout;
            if (remaining > 0) {
                (bool ok2, ) = payable(a.seller).call{value: remaining}("");
                if (!ok2) {
                    // If seller refund fails, send to treasury
                    (bool ok3, ) = payable(address(treasury)).call{value: remaining}("");
                    ok3; // silence unused warning
                }
            }
            a.gasDeposit = 0;
            a.bidGasPool = 0;
        }
    }

    // ─── Post-auction: bidder opt-in reveal ────────────────────────────────

    /// @notice Bidder opts in to making their own bid amount publicly
    ///         marked as revealed (for UX/audit trails).
    /// @dev Does NOT call `allowPublic` — only the bidder can decrypt their bid
    ///      because ACL was granted at bid-placement time.
    function revealMyBid(uint256 auctionId, uint256 bidIndex) external {
        Bid storage b = bids[auctionId][bidIndex];
        require(b.bidder == msg.sender, "not your bid");
        require(auctions[auctionId].ended, "auction not ended");
        b.revealed = true;
        emit BidRevealed(auctionId, bidIndex, msg.sender, euint64.unwrap(b.encAmount));
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    function bidCount(uint256 auctionId) external view returns (uint256) {
        return bids[auctionId].length;
    }

    function auctionCount() external view returns (uint256) {
        return nextAuctionId;
    }

    function getBid(uint256 auctionId, uint256 bidIndex)
        external
        view
        returns (address bidder, bytes32 encAmountHandle, bool settled, bool revealed)
    {
        Bid storage b = bids[auctionId][bidIndex];
        return (b.bidder, euint64.unwrap(b.encAmount), b.settled, b.revealed);
    }

    struct AuctionView {
        address seller;
        string itemName;
        string itemDescription;
        uint64 minBidPlain;
        uint64 endTime;
        bool ended;
        bool decryptRequested;
        bytes32 highestBidHandle;
        bytes32 highestBidderHandle;
        bool finalized;
        address winnerPlain;
        uint64 winningAmountPlain;
        uint256 numBids;
        uint256 gasDeposit;
        uint256 bidGasPool;
    }

    function getAuction(uint256 auctionId) external view returns (AuctionView memory v) {
        Auction storage a = auctions[auctionId];
        v.seller = a.seller;
        v.itemName = a.itemName;
        v.itemDescription = a.itemDescription;
        v.minBidPlain = a.minBidPlain;
        v.endTime = a.endTime;
        v.ended = a.ended;
        v.decryptRequested = a.decryptRequested;
        v.highestBidHandle = euint64.unwrap(a.highestBid);
        v.highestBidderHandle = eaddress.unwrap(a.highestBidder);
        v.finalized = a.finalized;
        v.winnerPlain = a.winnerPlain;
        v.winningAmountPlain = a.winningAmountPlain;
        v.numBids = bids[auctionId].length;
        v.gasDeposit = a.gasDeposit;
        v.bidGasPool = a.bidGasPool;
    }
}
