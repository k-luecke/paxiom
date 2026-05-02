// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract PaxiomPool is OApp {

    // ─── constants ───────────────────────────────────────────────
    uint256 public constant COLLATERAL_BPS   = 1000;  // 10% collateral
    uint256 public constant PROTOCOL_FEE_BPS = 9;     // 0.09% total fee
    uint256 public constant PROTOCOL_SHARE   = 30;    // 30% of fee to protocol
    uint256 public constant LP_SHARE         = 70;    // 70% of fee to LPs
    uint256 public constant TIMEOUT          = 5 minutes;
    uint256 public constant BPS_DENOM        = 10000;

    uint8 constant MSG_LOAN_REQUEST = 1;
    uint8 constant MSG_EXEC_CONFIRM = 2;

    // ─── state ───────────────────────────────────────────────────
    address public immutable USDC;
    address public protocolTreasury;
    uint32  public peerEid;

    uint256 public totalLiquidity;
    uint256 public totalFees;
    uint256 public loanCounter;

    mapping(address => uint256) public lpShares;
    uint256 public totalShares;

    struct Loan {
        address borrower;
        uint256 amount;
        uint256 collateral;
        uint256 fee;
        uint256 expiry;
        bool    active;
        bool    repaid;
    }

    mapping(uint256 => Loan) public loans;

    // ─── events ──────────────────────────────────────────────────
    event Deposited(address indexed lp, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lp, uint256 amount);
    event LoanIssued(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, uint256 fee);
    event LoanDefaulted(uint256 indexed loanId, uint256 collateralSlashed);
    event ExecutionConfirmed(uint256 indexed loanId);

    // ─── constructor ─────────────────────────────────────────────
    constructor(
        address _endpoint,
        address _owner,
        address _usdc,
        uint32  _peerEid
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        USDC             = _usdc;
        protocolTreasury = _owner;
        peerEid          = _peerEid;
    }

    // ─── liquidity provider functions ────────────────────────────

    function deposit(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(IERC20(USDC).transferFrom(msg.sender, address(this), amount), "Transfer failed");

        uint256 shares = totalShares == 0
            ? amount
            : (amount * totalShares) / totalLiquidity;

        lpShares[msg.sender] += shares;
        totalShares          += shares;
        totalLiquidity       += amount;

        emit Deposited(msg.sender, amount, shares);
    }

    function withdraw(uint256 shares) external {
        require(shares > 0 && lpShares[msg.sender] >= shares, "Insufficient shares");

        uint256 amount = (shares * totalLiquidity) / totalShares;
        require(IERC20(USDC).balanceOf(address(this)) >= amount, "Insufficient liquidity");

        lpShares[msg.sender] -= shares;
        totalShares          -= shares;
        totalLiquidity       -= amount;

        require(IERC20(USDC).transfer(msg.sender, amount), "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ─── borrower functions ───────────────────────────────────────

    function requestLoan(uint256 loanAmount) external payable {
        require(loanAmount > 0, "Zero amount");
        require(IERC20(USDC).balanceOf(address(this)) >= loanAmount, "Insufficient liquidity");

        uint256 collateral = (loanAmount * COLLATERAL_BPS) / BPS_DENOM;
        uint256 fee        = (loanAmount * PROTOCOL_FEE_BPS) / BPS_DENOM;

        require(IERC20(USDC).transferFrom(msg.sender, address(this), collateral), "Collateral failed");

        uint256 loanId = ++loanCounter;
        loans[loanId] = Loan({
            borrower:   msg.sender,
            amount:     loanAmount,
            collateral: collateral,
            fee:        fee,
            expiry:     block.timestamp + TIMEOUT,
            active:     true,
            repaid:     false
        });

        require(IERC20(USDC).transfer(msg.sender, loanAmount), "Loan transfer failed");

        bytes memory payload = abi.encode(
            MSG_LOAN_REQUEST,
            loanId,
            msg.sender,
            loanAmount
        );
        _lzSend(
            peerEid,
            payload,
            abi.encodePacked(uint16(1), uint256(200000)),
            MessagingFee({ nativeFee: msg.value, lzTokenFee: 0 }),
            payable(msg.sender)
        );

        emit LoanIssued(loanId, msg.sender, loanAmount);
    }

    function repayLoan(uint256 loanId) external {
        Loan storage loan = loans[loanId];
        require(loan.active && !loan.repaid, "Loan not active");
        require(loan.borrower == msg.sender, "Not borrower");
        require(block.timestamp <= loan.expiry, "Loan expired");

        uint256 totalOwed = loan.amount + loan.fee;
        require(IERC20(USDC).transferFrom(msg.sender, address(this), totalOwed), "Repay failed");

        _settleLoan(loanId);
    }

    function liquidateExpired(uint256 loanId) external {
        Loan storage loan = loans[loanId];
        require(loan.active && !loan.repaid, "Loan not active");
        require(block.timestamp > loan.expiry, "Not expired");

        loan.active     = false;
        totalLiquidity += loan.collateral;

        emit LoanDefaulted(loanId, loan.collateral);
    }

    // ─── internal settlement ─────────────────────────────────────

    function _settleLoan(uint256 loanId) internal {
        Loan storage loan = loans[loanId];
        loan.active = false;
        loan.repaid = true;

        uint256 protocolCut = (loan.fee * PROTOCOL_SHARE) / 100;
        uint256 lpCut       = loan.fee - protocolCut;

        require(IERC20(USDC).transfer(protocolTreasury, protocolCut), "Treasury transfer failed");
        totalLiquidity += loan.amount + lpCut;
        totalFees      += loan.fee;

        require(IERC20(USDC).transfer(loan.borrower, loan.collateral), "Collateral return failed");

        emit LoanRepaid(loanId, loan.fee);
    }

    // ─── LayerZero receive ────────────────────────────────────────

    function _lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) internal override {
        (uint8 msgType, uint256 loanId) = abi.decode(_message, (uint8, uint256));

        if (msgType == MSG_EXEC_CONFIRM) {
            Loan storage loan = loans[loanId];
            require(loan.active && !loan.repaid, "Loan not active");
            emit ExecutionConfirmed(loanId);
        }
    }

    // ─── view functions ───────────────────────────────────────────

    function quoteLoanFee(uint256 loanAmount) external pure returns (
        uint256 collateralRequired,
        uint256 protocolFee,
        uint256 totalRequired
    ) {
        collateralRequired = (loanAmount * COLLATERAL_BPS) / BPS_DENOM;
        protocolFee        = (loanAmount * PROTOCOL_FEE_BPS) / BPS_DENOM;
        totalRequired      = collateralRequired + protocolFee;
    }

    function quoteLzFee(uint256 loanAmount) external view returns (uint256 nativeFee) {
        bytes memory payload = abi.encode(MSG_LOAN_REQUEST, uint256(0), address(0), loanAmount);
        MessagingFee memory fee = _quote(
            peerEid,
            payload,
            abi.encodePacked(uint16(1), uint256(200000)),
            false
        );
        return fee.nativeFee;
    }

    function lpBalance(address lp) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (lpShares[lp] * totalLiquidity) / totalShares;
    }

    // ─── admin ────────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        protocolTreasury = _treasury;
    }

    function setPeerEid(uint32 _eid) external onlyOwner {
        peerEid = _eid;
    }
}
