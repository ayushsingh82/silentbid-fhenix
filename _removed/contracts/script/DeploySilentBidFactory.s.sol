// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SilentBidFactory} from "../src/SilentBidFactory.sol";

/// @title DeploySilentBidFactory
/// @notice One-time deploy of SilentBidFactory. After this, anyone can deploy SilentBid wrappers from the UI.
contract DeploySilentBidFactory is Script {
    function run() public {
        vm.startBroadcast();
        SilentBidFactory factory = new SilentBidFactory();
        vm.stopBroadcast();
        console2.log("SilentBidFactory deployed to:", address(factory));
        console2.log("Set in app: NEXT_PUBLIC_SILENTBID_FACTORY_ADDRESS=", address(factory));
    }
}
