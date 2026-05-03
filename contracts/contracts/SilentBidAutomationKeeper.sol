// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface ISilentBidAuction {
    struct Auction {
        address seller;
        uint64 minBidPlain;
        uint256 endTime;
        bool ended;
        bool finalized;
        uint256 numBids;
    }
    
    function getAuction(uint256 auctionId) external view returns (Auction memory);
    function endAuction(uint256 auctionId) external;
    function finalizeAuction(
        uint256 auctionId,
        address winner,
        uint64 amount,
        bytes calldata winnerSig,
        bytes calldata amountSig
    ) external;
    function auctionCount() external view returns (uint256);
}

contract SilentBidAutomationKeeper {
    ISilentBidAuction public immutable auction;
    address public owner;
    
    mapping(uint256 => bool) public auctionEnded;
    mapping(uint256 => bool) public auctionFinalized;
    
    event UpkeepPerformed(uint256 indexed auctionId, string action);
    event UpkeepFailed(uint256 indexed auctionId, string reason);

    constructor(address _auctionAddress) {
        auction = ISilentBidAuction(_auctionAddress);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    function checkUpkeep()
        external
        view
        returns (uint256 auctionIdToEnd, uint256 auctionIdToFinalize)
    {
        uint256 auctionCount = auction.auctionCount();
        
        for (uint256 i = 0; i < auctionCount; i++) {
            try auction.getAuction(i) returns (ISilentBidAuction.Auction memory a) {
                if (block.timestamp >= a.endTime && !a.ended && a.numBids > 0) {
                    return (i, type(uint256).max);
                }
                
                if (a.ended && !a.finalized && a.numBids > 0) {
                    return (type(uint256).max, i);
                }
            } catch {}
        }
        
        return (type(uint256).max, type(uint256).max);
    }

    function performUpkeepEndAuction(uint256 auctionId) external {
        ISilentBidAuction.Auction memory a = auction.getAuction(auctionId);
        
        require(block.timestamp >= a.endTime, "Auction not ended yet");
        require(!a.ended, "Already ended");
        require(a.numBids > 0, "No bids");
        
        try auction.endAuction(auctionId) {
            auctionEnded[auctionId] = true;
            emit UpkeepPerformed(auctionId, "endAuction");
        } catch Error(string memory reason) {
            emit UpkeepFailed(auctionId, reason);
            revert(reason);
        }
    }
    
    function performUpkeepFinalize(
        uint256 auctionId,
        address winner,
        uint64 amount,
        bytes calldata winnerSig,
        bytes calldata amountSig
    ) external {
        ISilentBidAuction.Auction memory a = auction.getAuction(auctionId);
        
        require(a.ended, "Auction not ended");
        require(!a.finalized, "Already finalized");
        require(a.numBids > 0, "No bids");
        
        try auction.finalizeAuction(auctionId, winner, amount, winnerSig, amountSig) {
            auctionFinalized[auctionId] = true;
            emit UpkeepPerformed(auctionId, "finalizeAuction");
        } catch Error(string memory reason) {
            emit UpkeepFailed(auctionId, reason);
            revert(reason);
        }
    }
    
    function getNextAuctionForAction() 
        external 
        view 
        returns (uint256 auctionId, string memory action, bool found) 
    {
        uint256 auctionCount = auction.auctionCount();
        
        for (uint256 i = 0; i < auctionCount; i++) {
            try auction.getAuction(i) returns (ISilentBidAuction.Auction memory a) {
                if (block.timestamp >= a.endTime && !a.ended && a.numBids > 0) {
                    return (i, "endAuction", true);
                }
                
                if (a.ended && !a.finalized && a.numBids > 0) {
                    return (i, "waitingForDecryption", true);
                }
            } catch {}
        }
        
        return (0, "", false);
    }
}
