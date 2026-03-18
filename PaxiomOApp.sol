// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract PaxiomOApp is OApp {
    
    // Latest price data received from another chain
    struct PriceData {
        string asset;
        uint256 price;
        string buyChain;
        string sellChain;
        uint256 spreadBps; // spread in basis points
        uint256 timestamp;
    }

    PriceData public latestOpportunity;
    
    event OpportunityReceived(
        string asset,
        uint256 price,
        uint256 spreadBps,
        string buyChain,
        string sellChain,
        uint256 timestamp
    );

    event OpportunitySent(
        uint32 dstChainId,
        string asset,
        uint256 spreadBps
    );

    constructor(
        address _endpoint,
        address _owner
    ) OApp(_endpoint, _owner) Ownable(_owner) {}

    // Send opportunity data to another chain
    function sendOpportunity(
        uint32 _dstEid,          // destination chain endpoint ID
        string memory _asset,
        uint256 _price,
        string memory _buyChain,
        string memory _sellChain,
        uint256 _spreadBps
    ) external payable {
        bytes memory payload = abi.encode(
            _asset,
            _price,
            _buyChain,
            _sellChain,
            _spreadBps,
            block.timestamp
        );

        _lzSend(
            _dstEid,
            payload,
            abi.encodePacked(uint16(1), uint256(200000)), // options
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );

        emit OpportunitySent(_dstEid, _asset, _spreadBps);
    }

    // Receive opportunity data from another chain
    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) internal override {
        (
            string memory asset,
            uint256 price,
            string memory buyChain,
            string memory sellChain,
            uint256 spreadBps,
            uint256 timestamp
        ) = abi.decode(_message, (string, uint256, string, string, uint256, uint256));

        latestOpportunity = PriceData({
            asset: asset,
            price: price,
            buyChain: buyChain,
            sellChain: sellChain,
            spreadBps: spreadBps,
            timestamp: timestamp
        });

        emit OpportunityReceived(asset, price, spreadBps, buyChain, sellChain, timestamp);
    }

    // Quote the fee for sending a message
    function quoteSend(
        uint32 _dstEid,
        string memory _asset,
        uint256 _price,
        string memory _buyChain,
        string memory _sellChain,
        uint256 _spreadBps
    ) external view returns (uint256 nativeFee) {
        bytes memory payload = abi.encode(
            _asset,
            _price,
            _buyChain,
            _sellChain,
            _spreadBps,
            block.timestamp
        );

        MessagingFee memory fee = _quote(
            _dstEid,
            payload,
            abi.encodePacked(uint16(1), uint256(200000)),
            false
        );

        return fee.nativeFee;
    }
}
