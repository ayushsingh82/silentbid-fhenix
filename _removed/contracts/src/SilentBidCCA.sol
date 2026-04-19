// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IContinuousClearingAuction (minimal interface for forwarding bids)
interface ICCA {
    function submitBid(uint256 maxPrice, uint128 amount, address owner, bytes calldata hookData)
        external
        payable
        returns (uint256 bidId);

    function exitBid(uint256 bidId) external;
    function claimTokens(uint256 bidId) external;
    function endBlock() external view returns (uint64);
    function startBlock() external view returns (uint64);
    function floorPrice() external view returns (uint256);
    function tickSpacing() external view returns (uint256);
    function clearingPrice() external view returns (uint256);
    function token() external view returns (address);
    function totalSupply() external view returns (uint128);
}

/// @title SilentBidCCA
/// @notice Privacy wrapper for Uniswap CCA that keeps bid details offchain.
///         Users submit silent bids with onchain ETH escrow plus an offchain
///         commitment; a trusted offchain workflow (e.g., Chainlink CRE) later
///         forwards cleared bids to the real CCA contract for settlement.
contract SilentBidCCA {
    // ═══════════════════════════════════════════════════════════════════
    //                          STATE
    // ═══════════════════════════════════════════════════════════════════

    address public admin;

    /// @notice The real Uniswap CCA this wrapper forwards revealed bids to
    ICCA public cca;

    /// @notice Block number after which no more silent bids are accepted
    uint64 public silentBidDeadline;

    /// @notice Total number of silent bids submitted
    uint256 public nextSilentBidId;

    /// @notice A single sealed bid
    struct SilentBid {
        address bidder;
        uint256 ethDeposit; // ETH held in escrow (covers worst-case bid)
        bool forwarded; // Whether this bid has been forwarded to the CCA
        bytes32 bidCommitment; // Offchain commitment to bid details (maxPrice, amount, flags, etc.)
    }

    /// @notice silentBidId → SilentBid
    mapping(uint256 => SilentBid) internal _silentBids;

    /// @notice silentBidId → real CCA bidId (set after forwarding)
    mapping(uint256 => uint256) public ccaBidIds;

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event SilentBidPlaced(uint256 indexed silentBidId, address indexed bidder, bytes32 bidCommitment);
    event BidForwarded(uint256 indexed silentBidId, uint256 indexed ccaBidId);
    event EthRefunded(uint256 indexed silentBidId, address indexed bidder, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error AuctionClosed();
    error AlreadyForwarded();
    error OnlyAdmin();
    error NoDeposit();

    // ═══════════════════════════════════════════════════════════════════
    //                        CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _cca Address of the deployed Uniswap CCA auction contract
    /// @param _silentBidDeadline Block number after which silent bidding closes.
    ///        Should be BEFORE the real CCA's endBlock so forwarded bids land in time.
    constructor(address _cca, uint64 _silentBidDeadline) {
        admin = msg.sender;
        cca = ICCA(_cca);
        silentBidDeadline = _silentBidDeadline;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     PHASE 1: SILENT BIDDING
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed bid.
    /// @dev    msg.value is the ETH escrow — it must cover the worst-case bid.
    ///         The actual amount used when forwarding to CCA can be ≤ msg.value;
    ///         excess is refunded at settlement.
    /// @param _bidCommitment Offchain commitment to bid details (hash of maxPrice, amount, flags, etc.)
    function submitSilentBid(bytes32 _bidCommitment) external payable {
        if (block.number >= silentBidDeadline) revert AuctionClosed();
        if (msg.value == 0) revert NoDeposit();

        // Store the silent bid
        uint256 bidId = nextSilentBidId++;
        _silentBids[bidId] = SilentBid({
            bidder: msg.sender,
            ethDeposit: msg.value,
            forwarded: false,
            bidCommitment: _bidCommitment
        });

        emit SilentBidPlaced(bidId, msg.sender, _bidCommitment);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                 FORWARD TO REAL CCA (CRE-DRIVEN)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Forward a single cleared bid to the real Uniswap CCA.
    /// @dev    Intended to be called by an offchain workflow (e.g., CRE) that
    ///         has validated the bid commitment and chosen the final amount.
    /// @param _silentBidId       The silent bid index
    /// @param _clearMaxPrice     Max price (Q96)
    /// @param _clearAmount       Final amount (wei)
    /// @param _owner             Owner address for the CCA bid (usually bidder)
    /// @param _hookData          Optional hook data for CCA
    function forwardBidToCCA(
        uint256 _silentBidId,
        uint256 _clearMaxPrice,
        uint128 _clearAmount,
        address _owner,
        bytes calldata _hookData
    ) external {
        if (msg.sender != admin) revert OnlyAdmin();

        SilentBid storage bb = _silentBids[_silentBidId];
        if (bb.forwarded) revert AlreadyForwarded();

        bb.forwarded = true;

        // Determine actual ETH to send (capped by deposit)
        uint256 bidEth = uint256(_clearAmount);
        uint256 toSend = bidEth <= bb.ethDeposit ? bidEth : bb.ethDeposit;

        // Forward to the real CCA
        uint256 ccaBidId = cca.submitBid{value: toSend}(
            _clearMaxPrice, // maxPrice (Q96)
            _clearAmount, // amount
            _owner, // owner in CCA
            _hookData // optional hook data
        );

        ccaBidIds[_silentBidId] = ccaBidId;

        // Refund excess ETH deposit back to bidder
        uint256 excess = bb.ethDeposit - toSend;
        if (excess > 0) {
            (bool ok,) = bb.bidder.call{value: excess}("");
            require(ok, "Refund failed");
            emit EthRefunded(_silentBidId, bb.bidder, excess);
        }

        emit BidForwarded(_silentBidId, ccaBidId);
    }

    /// @notice Batch-forward cleared bids to the CCA.
    ///         Gas-intensive — call in chunks if needed.
    /// @param _silentBidIds    Array of silent bid IDs to forward
    /// @param _clearMaxPrices Array of decrypted max prices
    /// @param _clearAmounts   Array of final amounts
    /// @param _owners         Array of owners for CCA bids
    /// @param _hookData       Array of hook data blobs
    function forwardBidsToCCA(
        uint256[] calldata _silentBidIds,
        uint256[] calldata _clearMaxPrices,
        uint128[] calldata _clearAmounts,
        address[] calldata _owners,
        bytes[] calldata _hookData
    ) external {
        require(
            _silentBidIds.length == _clearMaxPrices.length
                && _silentBidIds.length == _clearAmounts.length
                && _silentBidIds.length == _owners.length
                && _silentBidIds.length == _hookData.length,
            "Array length mismatch"
        );

        for (uint256 i = 0; i < _silentBidIds.length; i++) {
            // Use this. to allow the function to handle its own reverts
            this.forwardBidToCCA(_silentBidIds[i], _clearMaxPrices[i], _clearAmounts[i], _owners[i], _hookData[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Get public info for a silent bid (no sensitive amounts)
    function getSilentBidInfo(uint256 _silentBidId)
        external
        view
        returns (address bidder, uint256 ethDeposit, bool forwarded, bytes32 bidCommitment)
    {
        SilentBid storage bb = _silentBids[_silentBidId];
        return (bb.bidder, bb.ethDeposit, bb.forwarded, bb.bidCommitment);
    }

    /// @notice Allow contract to receive ETH (for CCA refunds)
    receive() external payable {}
}
