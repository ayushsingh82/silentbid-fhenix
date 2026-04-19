// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IConfidentialUSDC {
    function transferFromAllowance(address from, address to) external returns (euint64);
    function transferEncrypted(address to, euint64 amount) external returns (euint64);
    function allowance(address owner, address spender) external view returns (euint64);
}

/// @notice Sealed-bid auction where bid amounts stay encrypted until the
///         auction ends. Running max is computed inside FHE so the contract
///         never sees plaintext bids. Bidders escrow the encrypted amount in
///         cUSDC; at settlement the winner's escrow goes to the seller and
///         losers get their encrypted escrow refunded. A bidder can opt in
///         to reveal their own bid post-settlement via `revealMyBid`.
contract SilentBidAuction {
    IConfidentialUSDC public immutable cUSDC;

    struct Bid {
        address bidder;
        euint64 encAmount;
        bool refunded;
        bool revealed;
    }

    struct Auction {
        address seller;
        string itemName;
        string itemDescription;
        uint64 minBidPlain;     // public floor (for UX only)
        uint64 endTime;          // unix timestamp
        bool ended;
        bool settled;
        euint64 highestBid;
        eaddress highestBidder;
        uint64 winningAmountPlain; // published post-decrypt
        address winnerPlain;       // published post-decrypt
        bool winnerPublished;
        bool decryptRequested;     // endAuction dispatched FHE.decrypt
    }

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => Bid[]) public bids;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        string itemName,
        uint64 minBidPlain,
        uint64 endTime
    );
    event BidPlaced(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, uint256 encAmountHandle);
    event AuctionEnded(uint256 indexed auctionId, uint256 highestBidHandle, uint256 highestBidderHandle);
    event WinnerPublished(uint256 indexed auctionId, address indexed winner, uint64 amount);
    event BidRevealed(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, uint256 encAmountHandle);
    event BidRefunded(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder);

    constructor(IConfidentialUSDC _cUSDC) {
        cUSDC = _cUSDC;
    }

    function createAuction(
        string calldata itemName,
        string calldata itemDescription,
        uint64 minBidPlain,
        uint64 durationSeconds
    ) external returns (uint256 auctionId) {
        require(durationSeconds >= 60, "duration too short");
        auctionId = nextAuctionId++;
        Auction storage a = auctions[auctionId];
        a.seller = msg.sender;
        a.itemName = itemName;
        a.itemDescription = itemDescription;
        a.minBidPlain = minBidPlain;
        a.endTime = uint64(block.timestamp) + durationSeconds;
        // initialise running max to 0 (trivially encrypted); allowThis so we
        // can re-read it in future placeBid calls.
        a.highestBid = FHE.asEuint64(0);
        a.highestBidder = FHE.asEaddress(address(0));
        FHE.allowThis(a.highestBid);
        FHE.allowThis(a.highestBidder);
        emit AuctionCreated(auctionId, msg.sender, itemName, minBidPlain, a.endTime);
    }

    /// @notice Place a bid. Caller must have approved an encrypted cUSDC
    ///         allowance to this contract beforehand (the approval handle
    ///         carries the bid amount).
    function placeBid(uint256 auctionId) external returns (uint256 bidIndex) {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp < a.endTime, "auction ended");
        require(msg.sender != a.seller, "seller cannot bid");

        // Pull the encrypted amount from the bidder's cUSDC allowance into
        // this contract's encrypted balance. The amount stays encrypted
        // end-to-end; this call also zeroes the allowance to prevent replay.
        euint64 encAmount = cUSDC.transferFromAllowance(msg.sender, address(this));

        // Running-max update inside FHE.
        ebool isHigher = FHE.gt(encAmount, a.highestBid);
        a.highestBid = FHE.max(encAmount, a.highestBid);
        a.highestBidder = FHE.select(isHigher, FHE.asEaddress(msg.sender), a.highestBidder);
        FHE.allowThis(a.highestBid);
        FHE.allowThis(a.highestBidder);

        // Grant this contract ACL on the per-bid handle so we can refund/
        // transfer it at settlement, and grant the bidder ACL so they can
        // later unseal their own bid off-chain if they want.
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, msg.sender);

        bidIndex = bids[auctionId].length;
        bids[auctionId].push(Bid({
            bidder: msg.sender,
            encAmount: encAmount,
            refunded: false,
            revealed: false
        }));
        emit BidPlaced(auctionId, bidIndex, msg.sender, euint64.unwrap(encAmount));
    }

    /// @notice Close bidding and open up the running-max / winner handles
    ///         so any observer can unseal them off-chain via cofhejs.
    ///         Anyone can trigger this once the deadline passes.
    ///
    ///         We intentionally do NOT call `FHE.decrypt` here. Fhenix's
    ///         on-chain decrypt trigger was sunset on base-sepolia and
    ///         its replacement (`publishDecryptResult` + client
    ///         `decryptForTx`) hasn't shipped to npm yet. Until it does,
    ///         we delegate the unseal to the caller of `publishWinner`.
    function endAuction(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp >= a.endTime, "not ended");
        require(!a.ended, "already ended");
        a.ended = true;
        a.decryptRequested = true;
        FHE.allowGlobal(a.highestBid);
        FHE.allowGlobal(a.highestBidder);
        emit AuctionEnded(auctionId, euint64.unwrap(a.highestBid), eaddress.unwrap(a.highestBidder));
    }

    /// @notice Anyone can submit the decrypted winner (unsealed off-chain
    ///         via cofhejs) to publish on-chain. `FHE.allowGlobal` above
    ///         makes the off-chain decryption reproducible — any observer
    ///         can re-unseal and detect a liar. This switches to
    ///         `publishDecryptResult` (threshold-signature verify) once
    ///         the Fhenix SDK ships `decryptForTx`.
    function publishWinner(uint256 auctionId, address winner, uint64 amount) external {
        Auction storage a = auctions[auctionId];
        require(a.ended, "not ended");
        require(!a.winnerPublished, "already published");
        a.winnerPlain = winner;
        a.winningAmountPlain = amount;
        a.winnerPublished = true;
        emit WinnerPublished(auctionId, winner, amount);
    }

    /// @notice Bidder opts in to making their own bid amount publicly
    ///         decryptable (e.g. to show their honest bid after losing).
    function revealMyBid(uint256 auctionId, uint256 bidIndex) external {
        Bid storage b = bids[auctionId][bidIndex];
        require(b.bidder == msg.sender, "not your bid");
        require(auctions[auctionId].ended, "auction not ended");
        b.revealed = true;
        FHE.allowGlobal(b.encAmount);
        emit BidRevealed(auctionId, bidIndex, msg.sender, euint64.unwrap(b.encAmount));
    }

    /// @notice Settle a single bid post-auction: winner's escrow goes to
    ///         the seller, loser's escrow is refunded. Callable by anyone
    ///         once the winner is published (so it's idempotent + permissionless).
    function settleBid(uint256 auctionId, uint256 bidIndex) external {
        Auction storage a = auctions[auctionId];
        require(a.winnerPublished, "winner not published");
        Bid storage b = bids[auctionId][bidIndex];
        require(!b.refunded, "already settled");
        b.refunded = true;

        address to = b.bidder == a.winnerPlain ? a.seller : b.bidder;
        cUSDC.transferEncrypted(to, b.encAmount);
        emit BidRefunded(auctionId, bidIndex, b.bidder);
    }

    // ───── views ─────────────────────────────────────────────────────────

    function bidCount(uint256 auctionId) external view returns (uint256) {
        return bids[auctionId].length;
    }

    function getBid(uint256 auctionId, uint256 bidIndex)
        external
        view
        returns (address bidder, uint256 encAmountHandle, bool refunded, bool revealed)
    {
        Bid storage b = bids[auctionId][bidIndex];
        return (b.bidder, euint64.unwrap(b.encAmount), b.refunded, b.revealed);
    }

    struct AuctionView {
        address seller;
        string itemName;
        string itemDescription;
        uint64 minBidPlain;
        uint64 endTime;
        bool ended;
        bool decryptRequested;
        uint256 highestBidHandle;
        uint256 highestBidderHandle;
        bool winnerPublished;
        address winnerPlain;
        uint64 winningAmountPlain;
        uint256 numBids;
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
        v.winnerPublished = a.winnerPublished;
        v.winnerPlain = a.winnerPlain;
        v.winningAmountPlain = a.winningAmountPlain;
        v.numBids = bids[auctionId].length;
    }
}
