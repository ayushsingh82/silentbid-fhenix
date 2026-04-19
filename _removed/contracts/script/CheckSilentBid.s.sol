// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SilentBidCCA} from "../src/SilentBidCCA.sol";

/// @title CheckSilentBid
/// @notice View the current status of a SilentBidCCA deployment
contract CheckSilentBid is Script {
    function run() public view {
        address silentBidAddress = vm.envAddress("SILENTBID_ADDRESS");

        SilentBidCCA silentBid = SilentBidCCA(payable(silentBidAddress));

        console2.log("=== SilentBid Status ===");
        console2.log("SilentBid Address:", silentBidAddress);
        console2.log("CCA Address:", address(silentBid.cca()));
        console2.log("Admin:", silentBid.admin());

        console2.log("");
        console2.log("=== Timing ===");
        console2.log("Current Block:", block.number);
        console2.log("Silent Bid Deadline:", silentBid.silentBidDeadline());

        bool acceptingBids = block.number < silentBid.silentBidDeadline();
        console2.log("Accepting Silent Bids:", acceptingBids);
        if (acceptingBids) {
            console2.log("Blocks Until Deadline:", silentBid.silentBidDeadline() - uint64(block.number));
        }

        console2.log("");
        console2.log("=== Bids ===");
        console2.log("Total Silent Bids:", silentBid.nextSilentBidId());
        console2.log("ETH Balance (escrow):", address(silentBid).balance);

        uint256 totalBids = silentBid.nextSilentBidId();
        if (totalBids > 0) {
            console2.log("");
            console2.log("=== Individual Bids ===");
            for (uint256 i = 0; i < totalBids && i < 20; i++) {
                (address bidder, uint256 ethDeposit, bool forwarded, bytes32 bidCommitment) = silentBid.getSilentBidInfo(i);
                console2.log("  Bid", i, ":");
                console2.log("    Bidder:", bidder);
                console2.log("    ETH Deposit:", ethDeposit);
                console2.log("    Forwarded to CCA:", forwarded);
                console2.log("    Commitment:", uint256(bidCommitment));
                if (forwarded) {
                    console2.log("    CCA Bid ID:", silentBid.ccaBidIds(i));
                }
            }
        }
    }
}
