// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title Treasury — Collects platform fees and funds gas costs
/// @notice Receives ETH (gas deposits) and cUSDC (auction fees).
///         Only the owner can change the fee rate or withdraw funds.
///         Authorized contracts (SilentBidAuction) can deposit ETH.
contract Treasury {
    address public owner;
    uint16 public feeBasisPoints;           // e.g. 250 = 2.5%
    uint16 public constant MAX_FEE_BPS = 1000; // 10% cap

    mapping(address => bool) public authorizedContracts;

    event FeeUpdated(uint16 oldBps, uint16 newBps);
    event ContractAuthorized(address indexed addr);
    event ContractRevoked(address indexed addr);
    event EthWithdrawn(address indexed to, uint256 amount);
    event EthReceived(address indexed from, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint16 _feeBasisPoints) {
        require(_feeBasisPoints <= MAX_FEE_BPS, "fee too high");
        owner = msg.sender;
        feeBasisPoints = _feeBasisPoints;
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    function setFeeBasisPoints(uint16 _bps) external onlyOwner {
        require(_bps <= MAX_FEE_BPS, "fee too high");
        emit FeeUpdated(feeBasisPoints, _bps);
        feeBasisPoints = _bps;
    }

    function authorizeContract(address _contract) external onlyOwner {
        require(_contract != address(0), "addr=0");
        authorizedContracts[_contract] = true;
        emit ContractAuthorized(_contract);
    }

    function revokeContract(address _contract) external onlyOwner {
        authorizedContracts[_contract] = false;
        emit ContractRevoked(_contract);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(address(this).balance >= amount, "insufficient balance");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
        emit EthWithdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
