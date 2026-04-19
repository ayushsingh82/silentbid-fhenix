// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SilentBidCCA} from "./SilentBidCCA.sol";

/// @notice Minimal interface to read CCA endBlock for deadline
interface ICCAEndBlock {
    function endBlock() external view returns (uint64);
}

/// @title SilentBidFactory
/// @notice Deploy a SilentBidCCA for a given CCA auction. Callable from the UI (user signs with wallet).
contract SilentBidFactory {
    event SilentBidDeployed(address indexed cca, address indexed silentBid, uint64 silentBidDeadline);

    /// @param _cca Address of the Uniswap CCA auction
    /// @return silentBid Address of the deployed SilentBidCCA
    function deploySilentBid(address _cca) external returns (address silentBid) {
        uint64 endBlock = ICCAEndBlock(_cca).endBlock();
        uint64 silentDeadline = endBlock > 20 ? endBlock - 20 : 0;

        SilentBidCCA pool = new SilentBidCCA(_cca, silentDeadline);
        silentBid = address(pool);

        emit SilentBidDeployed(_cca, silentBid, silentDeadline);
    }
}
