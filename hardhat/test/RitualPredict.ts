import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const ADDRESSES = {
  scheduler: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B" as Address,
  wallet: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948" as Address,
  registry: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F" as Address,
  http: "0x0000000000000000000000000000000000000801" as Address,
  jq: "0x0000000000000000000000000000000000000803" as Address,
};

const MOCK_ABI = parseAbi([
  "function setService(address executor, bool found)",
  "function setResponse(bytes response)",
  "function setShouldRevert(bool value)",
  "function setResult(uint256 value)",
  "function setShouldFail(bool value)",
  "function getCall(uint256 callId) view returns (address target, bytes data, uint32 gasLimit, uint32 startBlock, uint32 numCalls, uint32 frequency, uint32 ttl, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, uint256 value, address payer, bool cancelled)",
  "function approvedContract() view returns (address)",
]);

const responseTypes = [
  { type: "uint16" },
  { type: "string[]" },
  { type: "string[]" },
  { type: "bytes" },
  { type: "string" },
] as const;

export function encodeHttpResponse(
  status: number,
  body: string,
  errorMessage = "",
): Hex {
  const actualOutput = encodeAbiParameters(responseTypes, [
    status,
    [],
    [],
    toHex(body),
    errorMessage,
  ]);
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    ["0x", actualOutput],
  );
}

export async function deployRitualPredictFixture() {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, alice, bob] = await viem.getWalletClients();
  const deployed = await Promise.all([
    viem.deployContract("MockScheduler"),
    viem.deployContract("MockRitualWallet"),
    viem.deployContract("MockTEEServiceRegistry"),
    viem.deployContract("MockHTTPPrecompile"),
    viem.deployContract("MockJQPrecompile"),
  ]);
  const fixed = [
    ADDRESSES.scheduler,
    ADDRESSES.wallet,
    ADDRESSES.registry,
    ADDRESSES.http,
    ADDRESSES.jq,
  ];
  for (let i = 0; i < fixed.length; i++) {
    const code = await publicClient.getCode({ address: deployed[i].address });
    assert.ok(code);
    await networkHelpers.setCode(fixed[i], code);
  }

  const scheduler = await viem.getContractAt("MockScheduler", ADDRESSES.scheduler);
  const wallet = await viem.getContractAt("MockRitualWallet", ADDRESSES.wallet);
  const registry = await viem.getContractAt("MockTEEServiceRegistry", ADDRESSES.registry);
  const http = await viem.getContractAt("MockHTTPPrecompile", ADDRESSES.http);
  const jq = await viem.getContractAt("MockJQPrecompile", ADDRESSES.jq);

  const predict = await viem.deployContract("RitualPredict", [195n]);
  const executor = alice.account.address;
  await registry.write.setService([executor, true]);
  await http.write.setResponse([encodeHttpResponse(200, '{"price":4500}')]);
  await jq.write.setResult([4500n]);

  async function mineToBlock(target: bigint) {
    const current = await publicClient.getBlockNumber();
    if (target > current) await networkHelpers.mine(Number(target - current));
  }

  async function triggerScheduledResolve(marketId: bigint, executionIndex = 1n) {
    await networkHelpers.impersonateAccount(ADDRESSES.scheduler);
    await networkHelpers.setBalance(ADDRESSES.scheduler, 10n ** 18n);
    await predict.write.onScheduledResolve([executionIndex, marketId], {
      account: ADDRESSES.scheduler,
    });
  }

  async function createMarketWithDefaults(overrides: Record<string, unknown> = {}) {
    const params = {
      question: "Will ETH reach $4000?",
      oracleUrl: "https://example.com/oracle",
      jsonPath: ".price",
      target: 4000n,
      comparator: 1,
      bettingSeconds: 30n,
      resolveDelaySeconds: 15n,
      ...overrides,
    };
    await predict.write.createMarket([params]);
    return predict.read.getMarket([await predict.read.marketCount()]);
  }

  return {
    viem,
    networkHelpers,
    publicClient,
    owner,
    alice,
    bob,
    predict,
    scheduler,
    wallet,
    registry,
    http,
    jq,
    mineToBlock,
    triggerScheduledResolve,
    createMarketWithDefaults,
    encodeHttpResponse,
  };
}
