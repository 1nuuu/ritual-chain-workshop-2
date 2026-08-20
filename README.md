## Submission Notes

### Environment

Ritual testnet was unavailable for the duration of this workshop, so all work
here was done and verified against a local Hardhat network (edr simulated),
not the live chain. Deployment to Ritual testnet itself was out of scope for
that reason; the deploy scripts in `scripts/` are unchanged from the starter
and are ready to run once the testnet is back.

### What I implemented

The starter left five functions in `RitualPredict.sol` unfilled: `createMarket`,
`onScheduledResolve`, `_readOracle`, `_pickExecutor`, and `_scheduleResolution`.
I implemented all five against the design described earlier in this README:

- **Block based deadlines**, not timestamps, so betting closing and the Scheduler
  waking the contract can never disagree.
- **3 resolution attempts, 200 blocks apart**, booked with the Scheduler at market
  creation time via `numCalls` and `frequency`.
- **A failed oracle read is never interpreted as NO.** Only after all 3 attempts
  are exhausted does the market become `Invalid` and refundable.
- **The winning side can still end up with zero backers** even after a successful
  oracle read (everyone bet the other way). That case also resolves to `Invalid`
  rather than dividing by zero in `claimWinnings`.
- **`Scheduler.cancel` is called on successful resolution** so the remaining
  booked retry slots are not wasted once the market has settled.
- **The executor is picked per attempt**, not hardcoded, using
  `TEEServiceRegistry.pickServiceByCapability` seeded with the market id, attempt
  number, and execution index, so a single unavailable executor doesn't stall the
  market forever.

### Testing without a live chain

`RitualPredict`'s constructor calls `IScheduler.approveScheduler` at deploy time,
which means the contract cannot even be deployed on a clean local Hardhat network,
let alone tested. I built mock contracts for the Scheduler, TEEServiceRegistry,
RitualWallet, and the HTTP (`0x0801`) and JQ (`0x0803`) precompiles
(`contracts/mocks/RitualMocks.sol`), and placed their bytecode at the real Ritual
Chain addresses using `hardhat_setCode` in the test fixture. This let the full
contract, including the Scheduler and precompile integration, run and be tested
end to end locally, without needing the live chain.

18 tests cover market creation and validation, betting window enforcement, access
control on the Scheduler callback, both successful and failed resolution paths,
the empty winning pool edge case, and claim/refund payout correctness. Run with
`npx hardhat test` from `hardhat/`.

### A bug the review process caught

While implementing the constructor, an early pass changed
`approveScheduler(RitualChain.SCHEDULER)` to `approveScheduler(address(this))`,
reasoning (incorrectly) that the contract should authorise itself as the callback
target. Reading the interface comment carefully
(`authorises schedulerContract to call back into / pay from the caller`) makes
clear the argument should be the Scheduler's own address, not the contract's,
since the whole point of the call is to give the Scheduler permission to call
back in, not to give the contract permission over itself.

The bug did not cause any of the 18 tests to fail, because the mock Scheduler
recorded whatever address it was given without validating it. That's a real gap:
tests passing does not mean the logic is correct, only that nothing in the suite
was checking that specific thing. I added a dedicated test asserting
`approveScheduler` is called with the Scheduler's canonical address specifically
(not just that it doesn't revert), so a regression like this would be caught
automatically going forward.

### What I did not change

`bet()` and the payout math in `claimWinnings()` were already implemented in the
starter and correct; I left that logic untouched. `getMarket`, `getMarkets`,
`decodeHttpResponse`, and `_jqUint` were also already present and, after review,
already correct against the precompile ABI reference.

### Why these two design choices, specifically

**The Scheduler, not a cron job or backend.** A backend cron means someone has to
keep a server running and paying gas forever, and it's a centralization point:
if that server goes down, markets never resolve. Booking the resolution with
the Scheduler at market creation time means the resolution is guaranteed by the
chain itself, no off-chain process to babysit, and the retry logic (3 attempts,
200 blocks apart) is enforced the same way regardless of who created the market.

**Pull based payout, not looping over all bettors.** Looping over every bettor
to push payouts in `onScheduledResolve` would make gas cost scale with the
number of bettors, and a single failing transfer (e.g. to a contract that
rejects ETH) would block everyone else's payout too. Pull based claims mean
each bettor pays their own gas to claim, and one broken claim can never affect
another bettor's ability to claim theirs.
