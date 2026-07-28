// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MintingRateLimiter} from "../src/contracts/assetManager/library/data/MintingRateLimiter.sol";

/// @notice Runs the real limiter and writes what it did to a JSON file, so the
///         TypeScript replay in ../src/limiter.ts can be checked against it
///         rather than against my reading of the source.
///
/// The library under test is the verified Coston2 source, copied byte for byte:
/// the directory layout here exists only so its own import paths resolve.
contract VectorsTest is Test {
    using MintingRateLimiter for MintingRateLimiter.State;

    MintingRateLimiter.State internal limiter;

    string internal json;
    uint256 internal count;

    function _reset(uint64 windowSize, uint64 maxPerWindow, uint64 at) internal {
        vm.warp(at);
        // initialize() aligns windowStart to the window size, exactly as on chain
        MintingRateLimiter.initialize(limiter, windowSize, maxPerWindow);
    }

    /// One step: record `amount` at `at`, then append the before/after to the log.
    function _step(uint64 windowSize, uint64 maxPerWindow, uint64 at, uint64 amount) internal {
        vm.warp(at);
        uint64 startBefore = limiter.windowStartTimestamp;
        uint64 mintedBefore = limiter.mintedInCurrentWindow;
        (bool delayed, uint256 allowedAt) = MintingRateLimiter.recordMinting(limiter, amount);

        json = string.concat(
            json,
            count == 0 ? "" : ",",
            "{",
            '"windowSize":', vm.toString(windowSize), ",",
            '"maxPerWindow":', vm.toString(maxPerWindow), ",",
            '"now":', vm.toString(at), ",",
            '"amount":', vm.toString(amount), ",",
            '"windowStartBefore":', vm.toString(startBefore), ",",
            '"mintedBefore":', vm.toString(mintedBefore), ",",
            '"delayed":', delayed ? "true" : "false", ",",
            '"allowedAt":', vm.toString(allowedAt), ",",
            '"windowStartAfter":', vm.toString(limiter.windowStartTimestamp), ",",
            '"mintedAfter":', vm.toString(limiter.mintedInCurrentWindow),
            "}"
        );
        count++;
    }

    uint64 constant HOUR = 3600;
    uint64 constant DAY = 86400;
    uint64 constant M = 1_000_000; // 1 XRP in AMG, granularity 1

    function test_writeVectors() public {
        uint64 t0 = 1785000000; // aligned to neither window on purpose

        // 1. a fresh window, well under the limit
        _reset(HOUR, 100_000 * M, t0);
        _step(HOUR, 100_000 * M, t0 + 10, 1_000 * M);

        // 2. landing exactly on the limit
        _reset(HOUR, 100 * M, t0);
        _step(HOUR, 100 * M, t0 + 10, 40 * M);
        _step(HOUR, 100 * M, t0 + 20, 60 * M);

        // 3. five times the limit in one go — the carry-over case
        _reset(HOUR, 100 * M, t0);
        _step(HOUR, 100 * M, t0 + 5, 500 * M);

        // 4. overspend, then let windows elapse and mint again
        _reset(HOUR, 100 * M, t0);
        _step(HOUR, 100 * M, t0 + 5, 250 * M);
        _step(HOUR, 100 * M, t0 + HOUR + 5, 10 * M);
        _step(HOUR, 100 * M, t0 + 2 * HOUR + 5, 10 * M);
        _step(HOUR, 100 * M, t0 + 3 * HOUR + 5, 10 * M);

        // 5. a long quiet period, so several windows elapse at once
        _reset(HOUR, 100 * M, t0);
        _step(HOUR, 100 * M, t0 + 5, 90 * M);
        _step(HOUR, 100 * M, t0 + 10 * HOUR, 90 * M);

        // 6. the daily window, with a partly-used state
        _reset(DAY, 500_000 * M, t0);
        _step(DAY, 500_000 * M, t0 + 60, 499_000 * M);
        _step(DAY, 500_000 * M, t0 + 120, 90_000 * M);

        // 7. amounts that do not divide the limit evenly (floor in allowedAt)
        _reset(HOUR, 7 * M, t0);
        _step(HOUR, 7 * M, t0 + 1, 3 * M);
        _step(HOUR, 7 * M, t0 + 2, 11 * M);
        _step(HOUR, 7 * M, t0 + 3, 1 * M);

        // 8. zero, and one unit
        _reset(HOUR, 100 * M, t0);
        _step(HOUR, 100 * M, t0 + 1, 0);
        _step(HOUR, 100 * M, t0 + 2, 1);

        vm.writeFile("./out-vectors/vectors.json", string.concat("[", json, "]"));
        assertGt(count, 10, "expected a useful number of vectors");
    }
}
