// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { SilentBidCCA } from "../src/SilentBidCCA.sol";
import { ContinuousClearingAuctionFactory } from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";
import { ContinuousClearingAuction } from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import { AuctionParameters } from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";
import { IDistributionContract } from "continuous-clearing-auction/interfaces/external/IDistributionContract.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

/// @title SilentBidCCATest (CRE commitment-based)
/// @notice Tests SilentBidCCA with submitSilentBid(bytes32) and admin-only forwardBidToCCA.
/// @dev Run: forge test --match-contract SilentBidCCATest -vvv
contract SilentBidCCATest is Test {
    address constant OWNER = address(0xBEEF);
    address bidder1;
    address bidder2;

    ERC20Mock token;
    ContinuousClearingAuction cca;
    SilentBidCCA silentBid;

    uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 constant FLOOR_PRICE = 79_228_162_514_264_334_008_320; // Q96
    uint256 constant TICK_SPACING = 79_228_162_514_264_334_008_320;
    uint64 auctionStartBlock;
    uint64 auctionEndBlock;
    uint64 silentDeadline;

    function setUp() public {
        bidder1 = makeAddr("bidder1");
        bidder2 = makeAddr("bidder2");
        vm.deal(bidder1, 10 ether);
        vm.deal(bidder2, 10 ether);
        vm.deal(OWNER, 10 ether);

        ContinuousClearingAuctionFactory factory = new ContinuousClearingAuctionFactory();
        token = new ERC20Mock();
        token.mint(OWNER, TOTAL_SUPPLY);

        auctionStartBlock = uint64(block.number + 5);
        auctionEndBlock = uint64(block.number + 105);
        silentDeadline = auctionEndBlock - 20;

        bytes memory auctionSteps = _buildAuctionSteps();
        AuctionParameters memory params = AuctionParameters({
            currency: address(0),
            tokensRecipient: OWNER,
            fundsRecipient: OWNER,
            startBlock: auctionStartBlock,
            endBlock: auctionEndBlock,
            claimBlock: auctionEndBlock,
            tickSpacing: TICK_SPACING,
            validationHook: address(0),
            floorPrice: FLOOR_PRICE,
            requiredCurrencyRaised: 0,
            auctionStepsData: auctionSteps
        });

        bytes32 salt = bytes32(0);
        IDistributionContract dist = factory.initializeDistribution(address(token), TOTAL_SUPPLY, abi.encode(params), salt);
        address auctionAddress = address(dist);
        cca = ContinuousClearingAuction(auctionAddress);
        vm.prank(OWNER);
        token.transfer(auctionAddress, TOTAL_SUPPLY);
        dist.onTokensReceived();

        silentBid = new SilentBidCCA(auctionAddress, silentDeadline);
    }

    function _buildAuctionSteps() internal pure returns (bytes memory) {
        uint24 mps = 100_000;
        uint40 blockDelta = 100;
        bytes8 step1 = bytes8(uint64(mps) << 40 | uint64(blockDelta));
        return abi.encodePacked(step1);
    }

    function test_SubmitSilentBid() public {
        vm.roll(auctionStartBlock);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, uint256(100_000), uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        silentBid.submitSilentBid{ value: 1 ether }(commit1);

        assertEq(silentBid.nextSilentBidId(), 1);
        (address b, uint256 dep, bool fwd, bytes32 c) = silentBid.getSilentBidInfo(0);
        assertEq(b, bidder1);
        assertEq(dep, 1 ether);
        assertFalse(fwd);
        assertEq(c, commit1);
    }

    function test_CannotBidAfterDeadline() public {
        vm.roll(silentDeadline);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, uint256(100_000), uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        vm.expectRevert(SilentBidCCA.AuctionClosed.selector);
        silentBid.submitSilentBid{ value: 1 ether }(commit1);
    }

    function test_NoDepositReverts() public {
        vm.roll(auctionStartBlock);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, uint256(100_000), uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        vm.expectRevert(SilentBidCCA.NoDeposit.selector);
        silentBid.submitSilentBid(commit1);
    }

    function test_OnlyAdminCanForward() public {
        vm.roll(auctionStartBlock);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, uint256(100_000), uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        silentBid.submitSilentBid{ value: 1 ether }(commit1);
        vm.roll(silentDeadline + 1);

        vm.prank(bidder2);
        vm.expectRevert(SilentBidCCA.OnlyAdmin.selector);
        silentBid.forwardBidToCCA(0, FLOOR_PRICE, 0.5 ether, bidder1, "");
    }

    function test_ForwardBidToCCA_AdminOnly() public {
        vm.roll(auctionStartBlock);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, FLOOR_PRICE, uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        silentBid.submitSilentBid{ value: 1 ether }(commit1);
        vm.roll(silentDeadline + 1);
        assertEq(silentBid.admin(), address(this));
        (,, bool fwd,) = silentBid.getSilentBidInfo(0);
        assertFalse(fwd);
    }

    function test_AlreadyForwardedReverts() public {
        vm.roll(auctionStartBlock);
        bytes32 commit1 = keccak256(abi.encodePacked(address(cca), bidder1, FLOOR_PRICE, uint256(0.5 ether), block.timestamp));
        vm.prank(bidder1);
        silentBid.submitSilentBid{ value: 1 ether }(commit1);
        vm.roll(silentDeadline + 1);
        uint256 price = 2 * FLOOR_PRICE;
        vm.prank(address(this));
        silentBid.forwardBidToCCA(0, price, 0.5 ether, bidder1, "");
        vm.prank(address(this));
        vm.expectRevert(SilentBidCCA.AlreadyForwarded.selector);
        silentBid.forwardBidToCCA(0, price, 0.5 ether, bidder1, "");
    }
}
