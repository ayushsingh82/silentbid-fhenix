// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ContinuousClearingAuctionFactory} from "../../src/ContinuousClearingAuctionFactory.sol";
import {IContinuousClearingAuctionFactory} from "../../src/interfaces/IContinuousClearingAuctionFactory.sol";
import "forge-std/Script.sol";
import "forge-std/console2.sol";

/// @title DeployOurCCAFactoryScript
/// @notice Deploy YOUR OWN CCA factory to a NEW address (different salt than official).
/// @dev Use this on Sepolia/Base Sepolia so you can create USDC auctions (official factory may revert).
///      No code changes needed — the factory already supports any currency (ETH or USDC).
///      After deploy, set this address as CCA_FACTORY in your app (Ethglobal/lib/auction-contracts.ts).
contract DeployOurCCAFactoryScript is Script {
    function run() public returns (IContinuousClearingAuctionFactory factory) {
        vm.startBroadcast();

        // Different salt = different address (v2 = factory + auction both via_ir for size limit)
        bytes32 salt = keccak256("SilentBidCCA-our-factory-sepolia-v2");
        factory = IContinuousClearingAuctionFactory(
            address(new ContinuousClearingAuctionFactory{salt: salt}())
        );

        console2.log("Our CCA Factory deployed to:", address(factory));
        console2.log("Set in app (Ethglobal): CCA_FACTORY =", address(factory));
        vm.stopBroadcast();
    }
}
