// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { ContinuousClearingAuctionFactory } from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";
import { AuctionParameters } from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";
import { IDistributionContract } from "continuous-clearing-auction/interfaces/external/IDistributionContract.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

/// @title ExportCCAContracts
/// @notice Exports CCA Factory + Token + Auction code+storage (large contracts >24KB).
///         For use with Anvil snapshots. SilentBid is CRE commitment-based; deploy separately.
contract ExportCCAContracts is Script {
    uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 constant FLOOR_PRICE = 79_228_162_514_264_334_008_320;
    string constant BASE = ".forge-snapshots/app/";

    function run() public {
        address deployer = address(0xCAFE);
        vm.startPrank(deployer);
        vm.deal(deployer, 100 ether);
        vm.record();

        ContinuousClearingAuctionFactory ccaFactory = new ContinuousClearingAuctionFactory();
        console2.log("CCA_FACTORY:", address(ccaFactory));

        ERC20Mock token = new ERC20Mock();
        console2.log("TOKEN:", address(token));

        uint64 startBlock = uint64(block.number + 10);
        uint64 endBlock = startBlock + 200;

        bytes memory auctionSteps = _buildAuctionSteps();
        AuctionParameters memory params = AuctionParameters({
            currency: address(0),
            tokensRecipient: deployer,
            fundsRecipient: deployer,
            startBlock: startBlock,
            endBlock: endBlock,
            claimBlock: endBlock,
            tickSpacing: FLOOR_PRICE,
            validationHook: address(0),
            floorPrice: FLOOR_PRICE,
            requiredCurrencyRaised: 0,
            auctionStepsData: auctionSteps
        });

        IDistributionContract dist = ccaFactory.initializeDistribution(
            address(token), TOTAL_SUPPLY, abi.encode(params), bytes32(0)
        );
        address auctionAddr = address(dist);
        console2.log("AUCTION:", auctionAddr);
        console2.log("START_BLOCK:", startBlock);
        console2.log("END_BLOCK:", endBlock);

        token.mint(auctionAddr, TOTAL_SUPPLY);
        dist.onTokensReceived();
        console2.log("FUNDED: true");

        _exportContract("cca_factory", address(ccaFactory));
        _exportContract("token", address(token));
        _exportContract("auction", auctionAddr);

        vm.stopPrank();

        vm.writeFile(string.concat(BASE, "start_block.txt"), vm.toString(uint256(startBlock)));
        vm.writeFile(string.concat(BASE, "end_block.txt"), vm.toString(uint256(endBlock)));
    }

    function _exportContract(string memory name, address addr) internal {
        vm.writeFile(string.concat(BASE, name, "_addr.txt"), vm.toString(addr));
        vm.writeFile(string.concat(BASE, name, "_code.hex"), vm.toString(addr.code));

        (, bytes32[] memory writes) = vm.accesses(addr);
        string memory data = "";
        for (uint256 i = 0; i < writes.length; i++) {
            bytes32 slot = writes[i];
            bytes32 val = vm.load(addr, slot);
            bool dup = false;
            for (uint256 j = 0; j < i; j++) {
                if (writes[j] == slot) { dup = true; break; }
            }
            if (dup) continue;
            data = string.concat(data, vm.toString(slot), "\n", vm.toString(val), "\n");
        }
        vm.writeFile(string.concat(BASE, name, "_storage.txt"), data);
        console2.log("  exported:", name);
    }

    function _buildAuctionSteps() internal pure returns (bytes memory) {
        uint24 mps = 50_000;
        uint40 blockDelta = 200;
        bytes8 step1 = bytes8(uint64(mps) << 40 | uint64(blockDelta));
        return abi.encodePacked(step1);
    }
}
