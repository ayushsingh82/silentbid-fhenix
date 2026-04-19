// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SilentBidCCA} from "../src/SilentBidCCA.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";

/// @title DeploySilentBid
/// @notice Deploy the SilentBidCCA privacy wrapper on Sepolia.
///         Requires an existing CCA auction address in AUCTION_ADDRESS env var.
contract DeploySilentBid is Script {
    function run() public {
        address auctionAddress = vm.envAddress("AUCTION_ADDRESS");

        ContinuousClearingAuction cca = ContinuousClearingAuction(auctionAddress);

        uint64 ccaEndBlock = cca.endBlock();
        uint64 ccaStartBlock = cca.startBlock();

        // Silent bid deadline: stop accepting sealed bids 20 blocks before CCA ends
        uint64 silentDeadline = ccaEndBlock - 20;

        console2.log("=== SilentBid Deployment ===");
        console2.log("CCA Address:", auctionAddress);
        console2.log("CCA Start Block:", ccaStartBlock);
        console2.log("CCA End Block:", ccaEndBlock);
        console2.log("Silent Bid Deadline:", silentDeadline);
        console2.log("Current Block:", block.number);

        vm.startBroadcast();

        SilentBidCCA silentBid = new SilentBidCCA(auctionAddress, silentDeadline);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("SilentBidCCA deployed to:", address(silentBid));
        console2.log("Admin:", silentBid.admin());
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Users submit sealed bids via frontend (submitSilentBid(commitment) with escrow)");
        console2.log("  2. After block", silentDeadline, "CRE workflow finalizes and calls forwardBidToCCA / forwardBidsToCCA (admin only)");
    }
}
