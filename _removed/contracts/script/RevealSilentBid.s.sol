// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { SilentBidCCA } from "../src/SilentBidCCA.sol";

/// @title RevealSilentBid (CRE flow — no onchain reveal)
/// @notice With CRE integration, there is no requestReveal(). After the silent bid deadline,
///         the CRE workflow loads stored bids, computes clearing price, and calls
///         forwardBidToCCA / forwardBidsToCCA (admin-only). This script only prints status.
contract RevealSilentBid is Script {
    function run() public view {
        address silentBidAddress = vm.envAddress("SILENTBID_ADDRESS");

        SilentBidCCA silentBid = SilentBidCCA(payable(silentBidAddress));

        console2.log("=== SilentBid Status (CRE flow) ===");
        console2.log("SilentBid Address:", silentBidAddress);
        console2.log("Silent Bid Deadline:", silentBid.silentBidDeadline());
        console2.log("Current Block:", block.number);
        console2.log("Total Silent Bids:", silentBid.nextSilentBidId());

        if (block.number < silentBid.silentBidDeadline()) {
            console2.log("Still accepting sealed bids. After deadline, run CRE finalization workflow.");
        } else {
            console2.log("Deadline passed. CRE workflow should call forwardBidToCCA(silentBidId, maxPrice, amount, owner, hookData) for each bid (admin only).");
        }
    }
}
