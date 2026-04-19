// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";
import {AuctionParameters} from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";
import {IDistributionContract} from "continuous-clearing-auction/interfaces/external/IDistributionContract.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

/// @title DeployCCA
/// @notice Script to deploy a Continuous Clearing Auction on Sepolia testnet
/// @dev Uses the existing CCA Factory deployed on Sepolia
contract DeployCCA is Script {
    // Sepolia CCA Factory v1.1.0
    address constant CCA_FACTORY = 0xcca1101C61cF5cb44C968947985300DF945C3565;

    function run() public {
        // Use the sender from --sender flag or keystore
        vm.startBroadcast();
        
        address deployer = msg.sender;
        console2.log("Deployer:", deployer);
        console2.log("CCA Factory:", CCA_FACTORY);

        // Deploy a mock token for testing
        ERC20Mock token = new ERC20Mock();
        console2.log("Mock Token deployed to:", address(token));

        uint256 totalSupply = 1_000_000_000e18; // 1 billion tokens

        // Build auction steps: 10% over 50 blocks, 49% over 49 blocks, 41% in last block
        bytes memory auctionStepsData = _buildAuctionSteps();

        // Configure auction parameters
        AuctionParameters memory parameters = AuctionParameters({
            currency: address(0), // Use ETH
            tokensRecipient: deployer, // Leftover tokens go to deployer
            fundsRecipient: deployer, // Raised funds go to deployer
            startBlock: uint64(block.number + 10), // Start 10 blocks from now
            endBlock: uint64(block.number + 110), // End after 100 blocks
            claimBlock: uint64(block.number + 110), // Allow claims at end
            tickSpacing: 79228162514264334008320, // Equal to floor price (1:1,000,000 ratio)
            validationHook: address(0), // No validation hook
            floorPrice: 79228162514264334008320, // 1 ETH = 1,000,000 tokens
            requiredCurrencyRaised: 0, // No graduation threshold
            auctionStepsData: auctionStepsData
        });

        console2.log("Auction Parameters:");
        console2.log("  Start Block:", parameters.startBlock);
        console2.log("  End Block:", parameters.endBlock);
        console2.log("  Claim Block:", parameters.claimBlock);

        // Get the CCA Factory
        ContinuousClearingAuctionFactory factory = ContinuousClearingAuctionFactory(CCA_FACTORY);

        // Deploy the auction via factory
        IDistributionContract auction = factory.initializeDistribution(
            address(token),
            totalSupply,
            abi.encode(parameters),
            bytes32(0) // No salt
        );
        console2.log("Auction deployed to:", address(auction));

        // Mint tokens to the auction contract
        token.mint(address(auction), totalSupply);
        console2.log("Minted", totalSupply / 1e18, "tokens to auction");

        // Notify auction of token receipt
        auction.onTokensReceived();
        console2.log("Auction notified of token receipt");

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("Token Address:", address(token));
        console2.log("Auction Address:", address(auction));
        console2.log("Total Supply:", totalSupply / 1e18, "tokens");
        console2.log("Auction Duration: 100 blocks");
    }

    /// @dev Build auction steps data
    /// Schedule: Linear release over 100 blocks
    /// Total MPS must equal 1e7 (100% = 10,000,000)
    /// Format: bytes8 = uint24(mps) in high 3 bytes | uint40(blockDelta) in low 5 bytes
    function _buildAuctionSteps() internal pure returns (bytes memory) {
        // 100% over 100 blocks = 1e7 / 100 = 100,000 MPS per block
        uint24 mps = 100_000;
        uint40 blockDelta = 100;
        
        // Pack: mps in high 24 bits, blockDelta in low 40 bits
        bytes8 step1 = bytes8(uint64(mps) << 40 | uint64(blockDelta));

        return abi.encodePacked(step1);
    }
}
