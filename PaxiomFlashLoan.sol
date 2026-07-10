// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract PaxiomFlashLoan {
    // Base mainnet addresses
    address constant AAVE_POOL     = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC          = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH          = 0x4200000000000000000000000000000000000006;
    address constant UNISWAP_ROUTER  = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    address public owner;

    constructor() {
        owner = msg.sender;
    }

    // Entry point. Slippage protection is mandatory: the caller computes
    // minLeg1Out / minLeg2Out from a pre-trade quote off-chain and a minimum
    // profit floor, and the contract reverts if either swap under-delivers
    // or the post-swap USDC balance does not cover repayment + profit.
    function executeArb(
        uint256 loanAmount,
        bool buyOnUniswap,
        uint256 minLeg1Out,
        uint256 minLeg2Out,
        uint256 minProfit
    ) external {
        require(msg.sender == owner, "Not owner");
        bytes memory params = abi.encode(buyOnUniswap, minLeg1Out, minLeg2Out, minProfit);
        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            USDC,
            loanAmount,
            params,
            0
        );
    }

    // Called by Aave during flash loan
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, // initiator unused
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == AAVE_POOL, "Not Aave");

        (bool buyOnUniswap, uint256 minLeg1Out, uint256 minLeg2Out, uint256 minProfit) =
            abi.decode(params, (bool, uint256, uint256, uint256));
        uint256 totalOwed = amount + premium;

        if (buyOnUniswap) {
            // Buy WETH cheap on Uniswap, sell expensive on Aerodrome
            _swapUniswap(USDC, WETH, amount, 500, minLeg1Out);
            uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
            _swapAerodrome(WETH, USDC, wethBalance, false, minLeg2Out);
        } else {
            // Buy WETH cheap on Aerodrome, sell expensive on Uniswap
            _swapAerodrome(USDC, WETH, amount, false, minLeg1Out);
            uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
            _swapUniswap(WETH, USDC, wethBalance, 500, minLeg2Out);
        }

        // Final slippage check: a sandwich attack between the two legs would
        // leave us short of repayment + minProfit even if both per-leg
        // amountOut* checks passed, so enforce the round-trip explicitly.
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= totalOwed + minProfit, "Slippage: insufficient round-trip");

        // Repay Aave
        IERC20(asset).approve(AAVE_POOL, totalOwed);
        return true;
    }

    function _swapUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint256 minAmountOut
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(UNISWAP_ROUTER, amountIn);
        IUniswapRouter.ExactInputSingleParams memory params =
            IUniswapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            });
        return IUniswapRouter(UNISWAP_ROUTER).exactInputSingle(params);
    }

    function _swapAerodrome(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool stable,
        uint256 minAmountOut
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(AERODROME_ROUTER, amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: tokenIn,
            to: tokenOut,
            stable: stable,
            factory: AERODROME_FACTORY
        });

        uint256[] memory amounts = IAerodromeRouter(AERODROME_ROUTER).swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            routes,
            address(this),
            block.timestamp + 300
        );

        return amounts[amounts.length - 1];
    }

    function withdraw(address token) external {
        require(msg.sender == owner, "Not owner");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(IERC20(token).transfer(owner, balance), "Transfer failed");
    }
}
