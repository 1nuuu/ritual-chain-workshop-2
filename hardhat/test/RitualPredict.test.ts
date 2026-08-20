import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAddressEqual, parseEther } from "viem";

import {
  ADDRESSES,
  deployRitualPredictFixture,
  encodeHttpResponse,
} from "./RitualPredict.ts";

describe("RitualPredict", async function () {
  // ───────────────────────── constructor ──────────────────────────

  describe("constructor", async function () {
    it("authorises the Scheduler itself in approveScheduler, not the contract's own address", async function () {
      const f = await deployRitualPredictFixture();

      const approved = await f.scheduler.read.lastApprovedScheduler();
      assert.ok(isAddressEqual(approved, ADDRESSES.scheduler)); // Scheduler canonical address
      assert.ok(!isAddressEqual(approved, f.predict.address)); // not the contract itself
    });
  });

  // ──────────────────────── createMarket ──────────────────────────

  describe("createMarket", async function () {
    it("creates a market with correct state and emits events", async function () {
      const f = await deployRitualPredictFixture();
      const market = await f.createMarketWithDefaults();
      assert.equal(market.state, 0); // Open
      assert.equal(market.outcome, 0); // Unresolved
      assert.ok(market.closeBlock > 0n);
      assert.ok(market.resolveBlock > market.closeBlock);
      assert.ok(market.scheduleId > 0n);
    });

    it("calls Scheduler.schedule with correct params", async function () {
      const f = await deployRitualPredictFixture();
      const market = await f.createMarketWithDefaults();
      const marketId = await f.predict.read.marketCount();
      const marketResolveBlock = BigInt(market.resolveBlock);
      const call = await f.scheduler.read.getCall([marketId]);
      assert.equal(call.target.toLowerCase(), f.predict.address.toLowerCase()); // target
      assert.equal(call.numCalls, 3); // = MAX_ATTEMPTS
      assert.equal(call.frequency, 200); // = RETRY_INTERVAL_BLOCKS
      assert.equal(call.payer.toLowerCase(), f.predict.address.toLowerCase()); // payer
      assert.equal(BigInt(call.startBlock), marketResolveBlock);
    });

    it("reverts with BadDuration for too-short betting", async function () {
      const f = await deployRitualPredictFixture();
      await f.viem.assertions.revertWithCustomError(
        f.predict.write.createMarket([{
          question: "Q",
          oracleUrl: "https://x.com",
          jsonPath: ".x",
          target: 1n,
          comparator: 0,
          bettingSeconds: 1n,
          resolveDelaySeconds: 15n,
        }]),
        f.predict,
        "BadDuration",
      );
    });

    it("reverts with EmptyString for empty question", async function () {
      const f = await deployRitualPredictFixture();
      await f.viem.assertions.revertWithCustomError(
        f.predict.write.createMarket([{
          question: "",
          oracleUrl: "https://x.com",
          jsonPath: ".x",
          target: 1n,
          comparator: 0,
          bettingSeconds: 30n,
          resolveDelaySeconds: 15n,
        }]),
        f.predict,
        "EmptyString",
      );
    });
  });

  // ──────────────────────────── bet ────────────────────────────────

  describe("bet", async function () {
    it("updates pools on YES and NO bets", async function () {
      const f = await deployRitualPredictFixture();
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();

      await f.predict.write.bet([id, true], { value: parseEther("1"), account: f.alice.account });
      await f.predict.write.bet([id, false], { value: parseEther("2"), account: f.bob.account });

      const m = await f.predict.read.getMarket([id]);
      assert.equal(m.totalYes, parseEther("1"));
      assert.equal(m.totalNo, parseEther("2"));
    });

    it("reverts with BettingClosed after closeBlock", async function () {
      const f = await deployRitualPredictFixture();
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.closeBlock);

      await f.viem.assertions.revertWithCustomError(
        f.predict.write.bet([id, true], { value: parseEther("1") }),
        f.predict,
        "BettingClosed",
      );
    });

    it("reverts with ZeroStake on 0 value", async function () {
      const f = await deployRitualPredictFixture();
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      await f.viem.assertions.revertWithCustomError(
        f.predict.write.bet([id, true], { value: 0n }),
        f.predict,
        "ZeroStake",
      );
    });
  });

  // ──────────────────── onScheduledResolve ─────────────────────────

  describe("onScheduledResolve", async function () {
    it("reverts with OnlyScheduler when called by non-scheduler", async function () {
      const f = await deployRitualPredictFixture();
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      await f.viem.assertions.revertWithCustomError(
        f.predict.write.onScheduledResolve([1n, id]),
        f.predict,
        "OnlyScheduler",
      );
    });

    it("resolves YES when oracle value satisfies comparator", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 }); // GTE
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      await f.triggerScheduledResolve(id);

      const resolved = await f.predict.read.getMarket([id]);
      assert.equal(resolved.state, 3); // Resolved
      assert.equal(resolved.outcome, 1); // Yes
      assert.equal(resolved.observedValue, 4500n);
    });

    it("resolves NO when oracle value does not satisfy comparator", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([3500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":3500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 }); // GTE
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      await f.triggerScheduledResolve(id);

      const resolved = await f.predict.read.getMarket([id]);
      assert.equal(resolved.state, 3); // Resolved
      assert.equal(resolved.outcome, 2); // No
    });

    it("calls Scheduler.cancel after successful resolution", async function () {
      const f = await deployRitualPredictFixture();
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      await f.triggerScheduledResolve(id);

      const callState = await f.scheduler.read.getCallState([market.scheduleId]);
      assert.equal(callState, 2); // cancelled
    });

    it("3 failed oracle reads result in Invalid, never NO", async function () {
      const f = await deployRitualPredictFixture();
      await f.http.write.setResponse([encodeHttpResponse(500, "")]);

      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      // 3 attempts
      for (let i = 1; i <= 3; i++) {
        await f.triggerScheduledResolve(id, BigInt(i));
      }

      const m = await f.predict.read.getMarket([id]);
      assert.equal(m.state, 4); // Invalid
      assert.notEqual(m.outcome, 2); // Never NO — should be Unresolved
      assert.equal(m.outcome, 0); // Unresolved
    });

    it("resolves on a later attempt after an earlier failure, cancelling only once", async function () {
      const f = await deployRitualPredictFixture();

      // Attempt 1: HTTP precompile returns non-200 → failure path.
      await f.http.write.setResponse([encodeHttpResponse(500, "")]);
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      await f.triggerScheduledResolve(id, 1n);

      // Attempt 1 failed: still Resolving, oracle did not resolve, and the schedule
      // must NOT be cancelled — a later attempt is still allowed.
      let m = await f.predict.read.getMarket([id]);
      assert.equal(m.state, 2); // Resolving
      assert.equal(m.outcome, 0); // Unresolved
      assert.equal(m.attempts, 1);
      assert.equal(await f.scheduler.read.getCallState([market.scheduleId]), 1); // not cancelled

      // Attempt 2: oracle recovers 200 + value satisfying GTE target.
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.jq.write.setResult([4500n]);
      await f.triggerScheduledResolve(id, 1n);

      m = await f.predict.read.getMarket([id]);
      assert.equal(m.state, 3); // Resolved
      assert.equal(m.outcome, 1); // Yes
      assert.equal(m.attempts, 2);
      assert.equal(await f.scheduler.read.getCallState([market.scheduleId]), 2); // cancelled
    });

    it("is a no-op when called again on an already-resolved market", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 }); // GTE
      const id = await f.predict.read.marketCount();
      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      await f.triggerScheduledResolve(id, 1n);
      const resolved = await f.predict.read.getMarket([id]);
      assert.equal(resolved.state, 3); // Resolved
      assert.equal(resolved.outcome, 1); // Yes

      const eventsBefore = await f.publicClient.getContractEvents({
        address: f.predict.address,
        abi: f.predict.abi,
        eventName: "MarketResolved",
        fromBlock: 0n,
      });

      // Second callback (e.g. a leftover scheduled execution): must be a no-op.
      await f.triggerScheduledResolve(id, 2n);

      const after = await f.predict.read.getMarket([id]);
      assert.equal(after.outcome, resolved.outcome); // unchanged
      assert.equal(after.observedValue, resolved.observedValue); // unchanged
      assert.equal(after.attempts, resolved.attempts); // unchanged

      const eventsAfter = await f.publicClient.getContractEvents({
        address: f.predict.address,
        abi: f.predict.abi,
        eventName: "MarketResolved",
        fromBlock: 0n,
      });
      assert.equal(eventsAfter.length, eventsBefore.length); // no new MarketResolved event
    });
  });

  // ────────────────── empty winning side ───────────────────────────

  describe("empty winning side", async function () {
    it("becomes Invalid when nobody backed the winning side", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      // comparator GTE (1), target 4000 → YES wins, but only NO bets exist
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 });
      const id = await f.predict.read.marketCount();

      // only bet on NO
      await f.predict.write.bet([id, false], { value: parseEther("1"), account: f.alice.account });

      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);
      await f.triggerScheduledResolve(id);

      const resolved = await f.predict.read.getMarket([id]);
      // Empty winning pool → Invalid, refundable (README requirement)
      assert.equal(resolved.state, 4); // Invalid
      assert.equal(resolved.outcome, 1); // Yes (oracle result recorded)

      // alice can refund her NO stake
      const balBefore = await f.publicClient.getBalance({ address: f.alice.account.address });
      await f.predict.write.claimRefund([id], { account: f.alice.account });
      const balAfter = await f.publicClient.getBalance({ address: f.alice.account.address });
      assert.ok(balAfter - balBefore > parseEther("0.9"));
    });
  });

  // ──────────────────── claimWinnings ──────────────────────────────

  describe("claimWinnings", async function () {
    it("pays proportional share to winners", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 }); // GTE → YES
      const id = await f.predict.read.marketCount();

      // alice bets YES 1 ETH, bob bets NO 2 ETH
      await f.predict.write.bet([id, true], { value: parseEther("1"), account: f.alice.account });
      await f.predict.write.bet([id, false], { value: parseEther("2"), account: f.bob.account });

      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);
      await f.triggerScheduledResolve(id);

      // YES wins. alice's payout = 1 * (1+2) / 1 = 3 ETH
      const balBefore = await f.publicClient.getBalance({ address: f.alice.account.address });
      await f.predict.write.claimWinnings([id], { account: f.alice.account });
      const balAfter = await f.publicClient.getBalance({ address: f.alice.account.address });
      // Allow some gas cost tolerance (payout should be ~3 ETH)
      assert.ok(balAfter - balBefore > parseEther("2.9"));
    });

    it("reverts with AlreadySettled on double claim", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 });
      const id = await f.predict.read.marketCount();

      await f.predict.write.bet([id, true], { value: parseEther("1"), account: f.alice.account });
      await f.predict.write.bet([id, false], { value: parseEther("1"), account: f.bob.account });

      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);
      await f.triggerScheduledResolve(id);

      await f.predict.write.claimWinnings([id], { account: f.alice.account });

      await f.viem.assertions.revertWithCustomError(
        f.predict.write.claimWinnings([id], { account: f.alice.account }),
        f.predict,
        "AlreadySettled",
      );
    });

    it("reverts with NothingToClaim for losing side", async function () {
      const f = await deployRitualPredictFixture();
      await f.jq.write.setResult([4500n]);
      await f.http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
      await f.createMarketWithDefaults({ target: 4000n, comparator: 1 });
      const id = await f.predict.read.marketCount();

      await f.predict.write.bet([id, true], { value: parseEther("1"), account: f.alice.account });
      await f.predict.write.bet([id, false], { value: parseEther("1"), account: f.bob.account });

      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);
      await f.triggerScheduledResolve(id);

      await f.viem.assertions.revertWithCustomError(
        f.predict.write.claimWinnings([id], { account: f.bob.account }),
        f.predict,
        "NothingToClaim",
      );
    });
  });

  // ──────────────────── claimRefund ────────────────────────────────

  describe("claimRefund", async function () {
    it("refunds stake on Invalid market", async function () {
      const f = await deployRitualPredictFixture();
      await f.http.write.setResponse([encodeHttpResponse(500, "")]);
      await f.createMarketWithDefaults();
      const id = await f.predict.read.marketCount();

      await f.predict.write.bet([id, true], { value: parseEther("1"), account: f.alice.account });
      await f.predict.write.bet([id, false], { value: parseEther("2"), account: f.bob.account });

      const market = await f.predict.read.getMarket([id]);
      await f.mineToBlock(market.resolveBlock);

      for (let i = 1; i <= 3; i++) {
        await f.triggerScheduledResolve(id, BigInt(i));
      }

      const balBefore = await f.publicClient.getBalance({ address: f.alice.account.address });
      await f.predict.write.claimRefund([id], { account: f.alice.account });
      const balAfter = await f.publicClient.getBalance({ address: f.alice.account.address });
      // Refund should be ~1 ETH minus gas
      assert.ok(balAfter - balBefore > parseEther("0.9"));
    });
  });
});
