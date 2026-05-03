// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

contract ConfidentialUSDC {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    address public immutable unwrapper;
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    mapping(address => euint64) private _balances;
    mapping(address => mapping(address => euint64)) private _allowances;

    struct PendingUnwrap {
        address recipient;
        euint64 encAmount;
        bool claimed;
    }
    mapping(uint256 => PendingUnwrap) public pendingUnwraps;
    uint256 public nextUnwrapId;

    event Wrap(address indexed from, uint256 amount);
    event UnwrapRequested(uint256 indexed unwrapId, address indexed from, bytes32 encAmountHandle);
    event UnwrapClaimed(uint256 indexed unwrapId, address indexed to, uint256 amount);
    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner, address indexed spender);

    constructor(IERC20 _underlying, address _unwrapper) {
        require(_unwrapper != address(0), "unwrapper=0");
        underlying = _underlying;
        unwrapper = _unwrapper;
        name = "Confidential USDC";
        symbol = "cUSDC";
        try IERC20Metadata(address(_underlying)).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            decimals = 18;
        }
    }

    function balanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (euint64) {
        return _allowances[owner][spender];
    }

    function wrap(uint64 amount) external {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        euint64 delta = FHE.asEuint64(amount);
        _credit(msg.sender, delta);
        emit Wrap(msg.sender, amount);
    }

    function requestUnwrap(InEuint64 calldata encAmount) external returns (uint256 unwrapId) {
        euint64 amount = FHE.asEuint64(encAmount);
        euint64 debit = _clampToBalance(msg.sender, amount);

        _debit(msg.sender, debit);

        FHE.allowThis(debit);
        FHE.allow(debit, msg.sender);
        FHE.allow(debit, unwrapper);

        unwrapId = nextUnwrapId++;
        pendingUnwraps[unwrapId] = PendingUnwrap({
            recipient: msg.sender,
            encAmount: debit,
            claimed: false
        });
        emit UnwrapRequested(unwrapId, msg.sender, euint64.unwrap(debit));
    }

    function claimUnwrap(uint256 unwrapId, uint64 plain) external {
        PendingUnwrap storage p = pendingUnwraps[unwrapId];
        require(p.recipient != address(0), "unknown unwrap");
        require(!p.claimed, "already claimed");
        require(msg.sender == unwrapper || msg.sender == p.recipient, "Not authorised");

        p.claimed = true;
        if (plain > 0) {
            underlying.safeTransfer(p.recipient, plain);
        }
        emit UnwrapClaimed(unwrapId, p.recipient, plain);
    }

    /// @notice Transfer an existing encrypted handle owned by msg.sender.
    ///         Used when the caller already holds a euint64 handle (e.g.
    ///         a contract that pulled funds via transferFromAllowance and
    ///         later needs to forward them). Silently clamps to balance.
    function transferEncrypted(address to, euint64 amount) external returns (euint64 transferred) {
        transferred = _move(msg.sender, to, amount);
        FHE.allow(transferred, msg.sender);
        FHE.allow(transferred, to);
    }

    function approve(address spender, InEuint64 calldata encAmount) external returns (euint64) {
        euint64 amount = FHE.asEuint64(encAmount);
        _allowances[msg.sender][spender] = amount;
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);
        FHE.allow(amount, spender);
        emit Approval(msg.sender, spender);
        return amount;
    }

    function transferFromAllowance(address from, address to) external returns (euint64 transferred) {
        euint64 allowed = _allowances[from][msg.sender];
        transferred = _move(from, to, allowed);

        euint64 newAllowance = FHE.sub(allowed, transferred);
        _allowances[from][msg.sender] = newAllowance;
        FHE.allowThis(newAllowance);
        FHE.allow(newAllowance, from);
        FHE.allow(newAllowance, msg.sender);

        FHE.allow(transferred, from);
        FHE.allow(transferred, to);
        FHE.allow(transferred, msg.sender);
    }

    function _move(address from, address to, euint64 amount) internal returns (euint64 transferred) {
        require(to != address(0), "to=0");
        transferred = _clampToBalance(from, amount);
        _debit(from, transferred);
        _credit(to, transferred);
        FHE.allowThis(transferred);
        emit Transfer(from, to);
    }

    function _clampToBalance(address owner, euint64 amount) internal returns (euint64) {
        euint64 bal = _balances[owner];
        ebool ok = FHE.gte(bal, amount);
        return FHE.select(ok, amount, FHE.asEuint64(0));
    }

    function _debit(address owner, euint64 amount) internal {
        euint64 next = FHE.sub(_balances[owner], amount);
        _balances[owner] = next;
        FHE.allowThis(next);
        FHE.allow(next, owner);
    }

    function _credit(address owner, euint64 amount) internal {
        euint64 next = FHE.add(_balances[owner], amount);
        _balances[owner] = next;
        FHE.allowThis(next);
        FHE.allow(next, owner);
    }
}
