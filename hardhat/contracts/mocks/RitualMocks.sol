// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockScheduler {
    struct Call {
        address target;
        bytes data;
        uint32 gasLimit;
        uint32 startBlock;
        uint32 numCalls;
        uint32 frequency;
        uint32 ttl;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 value;
        address payer;
        bool cancelled;
    }

    uint256 public nextCallId;
    /// Most recent address passed to approveScheduler(); tests assert on this to catch
    /// a constructor passing the wrong (non-Scheduler) target.
    address public lastApprovedScheduler;
    mapping(uint256 => Call) private _calls;

    function approveScheduler(address schedulerContract) external {
        lastApprovedScheduler = schedulerContract;
    }

    function schedule(
        bytes calldata data,
        uint32 gasLimit,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId) {
        callId = ++nextCallId;
        _calls[callId] = Call({
            target: msg.sender,
            data: data,
            gasLimit: gasLimit,
            startBlock: startBlock,
            numCalls: numCalls,
            frequency: frequency,
            ttl: ttl,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            value: value,
            payer: payer,
            cancelled: false
        });
    }

    function cancel(uint256 callId) external {
        _calls[callId].cancelled = true;
    }

    function getCallState(uint256 callId) external view returns (uint8) {
        return _calls[callId].cancelled ? 2 : 1;
    }

    function getCall(uint256 callId) external view returns (Call memory) {
        return _calls[callId];
    }

    function triggerCall(uint256 callId, uint256 executionIndex) external {
        Call storage scheduled = _calls[callId];
        require(!scheduled.cancelled, "cancelled");
        bytes memory data = scheduled.data;
        require(data.length >= 36, "short callback");
        assembly ("memory-safe") {
            mstore(add(data, 36), executionIndex)
        }
        (bool ok, bytes memory result) = scheduled.target.call{value: scheduled.value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }
}

contract MockTEEServiceRegistry {
    address public executor;
    bool public found;

    function setService(address executor_, bool found_) external {
        executor = executor_;
        found = found_;
    }

    function pickServiceByCapability(uint8, bool, uint256, uint256)
        external
        view
        returns (address teeAddress, bool found_)
    {
        return (executor, found);
    }
}

contract MockRitualWallet {
    mapping(address => uint256) private _balances;
    mapping(address => uint256) private _lockUntil;

    function deposit(uint256 lockDuration) external payable {
        _balances[msg.sender] += msg.value;
        _lockUntil[msg.sender] = block.number + lockDuration;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lockUntil(address account) external view returns (uint256) {
        return _lockUntil[account];
    }
}

contract MockHTTPPrecompile {
    bytes private _response;
    bool public shouldRevert;

    function setResponse(bytes calldata response) external {
        _response = response;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    fallback() external {
        if (shouldRevert) revert("http reverted");
        bytes memory response = _response;
        assembly ("memory-safe") {
            return(add(response, 32), mload(response))
        }
    }
}

contract MockJQPrecompile {
    uint256 public result;
    bool public shouldFail;

    function setResult(uint256 value) external {
        result = value;
    }

    function setShouldFail(bool value) external {
        shouldFail = value;
    }

    fallback() external {
        if (shouldFail) return;
        bytes memory response = abi.encode(result);
        assembly ("memory-safe") {
            return(add(response, 32), mload(response))
        }
    }
}
