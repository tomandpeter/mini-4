"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseEther,
  parseEventLogs,
  parseGwei,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

import {
  ADDER8_CIRCUIT_ID,
  ADDER8_EXPECTED_PREVIOUS_ID,
  ADDER8_INPUTS,
  ADDER8_NAND_COUNT,
  ADDER8_NETLIST,
  ADDER8_NETLIST_BYTES,
  ADDER8_NETLIST_KECCAK256,
  ADDER8_NETLIST_SHA256,
  ADDER8_OUTPUTS,
  ADDER8_SOURCE_TASK_ID,
  ADDER8_TASK_ID,
  BEACON_ABI,
  EIP1967_BEACON_SLOT,
  MINI4_BEACON,
  MINI4_CHAIN_ID,
  MINI4_CREATOR,
  MINI4_IMPLEMENTATION,
  MINI4_PROCESSOR,
  MINI4_PROXY_CODE_HASH,
  MINI4_TRANSISTORS,
  PROCESSOR_TAPEOUT_ABI,
  TRANSISTOR_ABI,
  addressFromStorageWord,
  decodeAdder8Output,
  packAdder8Inputs,
} from "@/lib/adder8-tapeout";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "signing"
  | "mining"
  | "submitted"
  | "complete"
  | "error";

type Preflight = {
  account: Address;
  blockNumber: bigint;
  nandBalance: bigint;
  gasEstimate: bigint;
  gasLimit: bigint;
  gasPrice: bigint;
  maxGasCost: bigint;
  bnbBalance: bigint;
  nonce: number;
};

type StoredGuard =
  | {
      status: "signing";
      account: Address;
      nonce: number;
      createdAt: string;
    }
  | {
      status: "submitted" | "complete";
      account: Address;
      nonce: number;
      hash: Hex;
      createdAt: string;
      circuitId?: string;
    };

class SubmittedTransactionRevertedError extends Error {}

const SUBMISSION_STORAGE_KEY = "mini4-adder8-tapeout-submission-v1";
const MAX_GAS_PRICE = parseGwei("0.1");
const MAX_GAS_COST = parseEther("0.0001");

const publicClient = createPublicClient({
  chain: bsc,
  transport: http("https://bsc-dataseed.binance.org", {
    retryCount: 1,
    timeout: 10_000,
  }),
});

function shortAddress(address: Address): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && error.code === 4001) {
    return "钱包已取消：没有发送交易，也没有改变链上状态。";
  }
  if (error instanceof Error) return error.message;
  return "操作失败；没有得到可验证的成功结果。";
}

function readStoredGuard(): StoredGuard | null {
  const raw = window.localStorage.getItem(SUBMISSION_STORAGE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<StoredGuard>;
  if (
    (value.status === "signing" || value.status === "submitted" || value.status === "complete") &&
    typeof value.account === "string" &&
    isAddressEqual(getAddress(value.account), MINI4_CREATOR) &&
    typeof value.nonce === "number" &&
    Number.isSafeInteger(value.nonce) &&
    typeof value.createdAt === "string"
  ) {
    if (value.status === "signing") return value as StoredGuard;
    if (typeof value.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.hash)) {
      return value as StoredGuard;
    }
  }
  throw new Error("本地防重复记录损坏；为防止重复流片，已停止。 ");
}

function writeStoredGuard(value: StoredGuard): void {
  window.localStorage.setItem(SUBMISSION_STORAGE_KEY, JSON.stringify(value));
}

function requirePersistentGuard(): void {
  const probeKey = `${SUBMISSION_STORAGE_KEY}-probe`;
  window.localStorage.setItem(probeKey, "1");
  window.localStorage.removeItem(probeKey);
}

async function requireWallet() {
  if (!window.ethereum) {
    throw new Error("没有检测到浏览器钱包。请安装并解锁支持 BNB Chain 的钱包。");
  }

  const walletClient = createWalletClient({
    chain: bsc,
    transport: custom(window.ethereum),
  });

  const currentChainId = await walletClient.getChainId();
  if (currentChainId !== MINI4_CHAIN_ID) {
    await walletClient.switchChain({ id: MINI4_CHAIN_ID });
  }

  const [account] = await walletClient.requestAddresses();
  if (!account || !isAddressEqual(account, MINI4_CREATOR)) {
    throw new Error(
      `必须连接 MINI-4 创建者钱包 ${MINI4_CREATOR}；当前钱包不匹配。`,
    );
  }

  return { walletClient, account: getAddress(account) };
}

async function runPreflight(account: Address): Promise<Preflight> {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== MINI4_CHAIN_ID) {
    throw new Error(`RPC 链 ID 为 ${actualChainId}，不是 BNB Chain 56。`);
  }

  const blockNumber = await publicClient.getBlockNumber();
  const code = await publicClient.getCode({ address: MINI4_PROCESSOR, blockNumber });
  if (!code || code === "0x" || keccak256(code) !== MINI4_PROXY_CODE_HASH) {
    throw new Error("MINI-4 代理代码与已验证的固定代码哈希不一致，已停止。 ");
  }

  const beaconWord = await publicClient.getStorageAt({
    address: MINI4_PROCESSOR,
    slot: EIP1967_BEACON_SLOT,
    blockNumber,
  });
  const beacon = addressFromStorageWord(beaconWord);
  if (!beacon || !isAddressEqual(beacon, MINI4_BEACON)) {
    throw new Error("MINI-4 beacon 地址已变化，已停止。 ");
  }

  const implementation = await publicClient.readContract({
    address: beacon,
    abi: BEACON_ABI,
    functionName: "implementation",
    blockNumber,
  });
  if (!isAddressEqual(implementation, MINI4_IMPLEMENTATION)) {
    throw new Error("MINI-4 implementation 已升级，必须重新审计后再流片。 ");
  }

  const transistorAddress = await publicClient.readContract({
    address: MINI4_PROCESSOR,
    abi: PROCESSOR_TAPEOUT_ABI,
    functionName: "transistors",
    blockNumber,
  });
  if (!isAddressEqual(transistorAddress, MINI4_TRANSISTORS)) {
    throw new Error("处理器关联的 ERC-1155 地址与 MINI-4 不一致，已停止。 ");
  }

  const previousId = await publicClient.readContract({
    address: MINI4_PROCESSOR,
    abi: PROCESSOR_TAPEOUT_ABI,
    functionName: "nextId",
    blockNumber,
  });
  if (previousId !== ADDER8_EXPECTED_PREVIOUS_ID) {
    throw new Error(
      `MINI-4 的最后电路 ID 已是 ${previousId}，不再是预期的 5；为防止重复流片，已停止。`,
    );
  }

  const nandBalance = await publicClient.readContract({
    address: MINI4_TRANSISTORS,
    abi: TRANSISTOR_ABI,
    functionName: "balanceOf",
    args: [account, 0n],
    blockNumber,
  });
  if (nandBalance < ADDER8_NAND_COUNT) {
    throw new Error(`NAND 余额只有 ${nandBalance}，流片需要 68 个。`);
  }

  const simulation = await publicClient.simulateContract({
    account,
    address: MINI4_PROCESSOR,
    abi: PROCESSOR_TAPEOUT_ABI,
    functionName: "tapeout",
    args: [ADDER8_NETLIST, ADDER8_INPUTS, ADDER8_OUTPUTS],
    blockNumber,
  });
  if (simulation.result !== ADDER8_CIRCUIT_ID) {
    throw new Error(`链上模拟返回 Circuit #${simulation.result}，不是预期的 #6。`);
  }

  const gasEstimate = await publicClient.estimateContractGas({
    account,
    address: MINI4_PROCESSOR,
    abi: PROCESSOR_TAPEOUT_ABI,
    functionName: "tapeout",
    args: [ADDER8_NETLIST, ADDER8_INPUTS, ADDER8_OUTPUTS],
  });
  if (gasEstimate > 700_000n) {
    throw new Error(`Gas 估算异常升高到 ${gasEstimate}，已停止。`);
  }

  const gasLimit = (gasEstimate * 130n + 99n) / 100n;
  const [gasPrice, bnbBalance, latestNonce, pendingNonce] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: account }),
    publicClient.getTransactionCount({ address: account, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account, blockTag: "pending" }),
  ]);
  if (pendingNonce !== latestNonce) {
    throw new Error("创建者钱包已有待确认交易；为避免 nonce 竞态，已停止。 ");
  }
  if (gasPrice > MAX_GAS_PRICE) {
    throw new Error(`Gas price ${formatGwei(gasPrice)} gwei 超过固定上限 0.1 gwei。`);
  }
  const maxGasCost = gasLimit * gasPrice;
  if (maxGasCost > MAX_GAS_COST) {
    throw new Error(`Gas 上限金额 ${formatEther(maxGasCost)} BNB 超过固定上限 0.0001 BNB。`);
  }
  if (bnbBalance < maxGasCost) {
    throw new Error("创建者钱包的 BNB 不足以覆盖缓冲后的 gas 上限。 ");
  }

  return {
    account,
    blockNumber,
    nandBalance,
    gasEstimate,
    gasLimit,
    gasPrice,
    maxGasCost,
    bnbBalance,
    nonce: latestNonce,
  };
}

async function verifyTapeout(hash: Hex, account: Address) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status === "reverted") {
    throw new SubmittedTransactionRevertedError("交易已回滚，没有创建电路。 ");
  }
  if (!receipt.to || !isAddressEqual(receipt.to, MINI4_PROCESSOR)) {
    throw new Error("交易没有以成功状态写入 MINI-4 处理器。 ");
  }

  const transaction = await publicClient.getTransaction({ hash });
  const expectedInput = encodeFunctionData({
    abi: PROCESSOR_TAPEOUT_ABI,
    functionName: "tapeout",
    args: [ADDER8_NETLIST, ADDER8_INPUTS, ADDER8_OUTPUTS],
  });
  if (
    !isAddressEqual(transaction.from, account) ||
    !transaction.to ||
    !isAddressEqual(transaction.to, MINI4_PROCESSOR) ||
    transaction.value !== 0n ||
    transaction.input.toLowerCase() !== expectedInput.toLowerCase()
  ) {
    throw new Error("已确认交易的 from/to/value/calldata 与固定流片工件不一致。 ");
  }

  const events = parseEventLogs({
    abi: PROCESSOR_TAPEOUT_ABI,
    eventName: "TapedOut",
    logs: receipt.logs,
    strict: true,
  });
  if (events.length !== 1) throw new Error("交易没有唯一的 TapedOut 事件。 ");
  const event = events[0].args;
  if (
    !event.author ||
    !isAddressEqual(event.author, account) ||
    event.gateCount !== 68 ||
    event.nState !== 0
  ) {
    throw new Error("TapedOut 事件的作者、门数或状态位异常。 ");
  }
  const circuitId = event.circuitId;

  const [info, owner, storedNetlist, nandBalance] = await Promise.all([
    publicClient.readContract({
      address: MINI4_PROCESSOR,
      abi: PROCESSOR_TAPEOUT_ABI,
      functionName: "circuitInfo",
      args: [circuitId],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: MINI4_PROCESSOR,
      abi: PROCESSOR_TAPEOUT_ABI,
      functionName: "ownerOf",
      args: [circuitId],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: MINI4_PROCESSOR,
      abi: PROCESSOR_TAPEOUT_ABI,
      functionName: "netlist",
      args: [circuitId],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: MINI4_TRANSISTORS,
      abi: TRANSISTOR_ABI,
      functionName: "balanceOf",
      args: [account, 0n],
      blockNumber: receipt.blockNumber,
    }),
  ]);

  if (info[0] !== 16 || info[1] !== 9 || info[2] !== 0 || info[3] !== 68) {
    throw new Error(`Circuit #${circuitId} 元数据异常：${info.join("/")}。`);
  }
  if (!isAddressEqual(owner, account)) {
    throw new Error(`Circuit #${circuitId} 所有者不是创建者钱包。`);
  }
  if (keccak256(storedNetlist) !== ADDER8_NETLIST_KECCAK256) {
    throw new Error(`Circuit #${circuitId} 链上网表哈希与已验证网表不一致。`);
  }

  const samples = [
    [0, 0],
    [1, 1],
    [255, 1],
    [255, 255],
    [123, 77],
  ] as const;
  for (const [a, b] of samples) {
    const output = await publicClient.readContract({
      address: MINI4_PROCESSOR,
      abi: PROCESSOR_TAPEOUT_ABI,
      functionName: "eval",
      args: [circuitId, packAdder8Inputs(a, b)],
      blockNumber: receipt.blockNumber,
    });
    if (decodeAdder8Output(output) !== a + b) {
      throw new Error(`Circuit #${circuitId} 链上样例 ${a}+${b} 验证失败。`);
    }
  }

  return { receipt, nandBalance, circuitId };
}

export default function TapeoutClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [message, setMessage] = useState<string>("尚未连接钱包；不会自动发送交易。");
  const [transactionHash, setTransactionHash] = useState<Hex | null>(null);
  const [remainingNand, setRemainingNand] = useState<bigint | null>(null);
  const [actualCircuitId, setActualCircuitId] = useState<bigint | null>(null);

  const busy = phase === "checking" || phase === "signing" || phase === "mining";
  const hasSubmitted = transactionHash !== null || phase === "submitted" || phase === "complete";
  const ready = phase === "ready" && preflight !== null && !hasSubmitted;
  const artifactSummary = useMemo(
    () => [
      ["目标", `MINI-4 Circuit #${ADDER8_CIRCUIT_ID}`],
      ["电路", "8-bit Adder（无 carry-in）"],
      ["输入 / 输出", `${ADDER8_INPUTS} bits / ${ADDER8_OUTPUTS} bits`],
      ["消耗", `${ADDER8_NAND_COUNT} NAND / 0 LATCH`],
      ["网表", `${ADDER8_NETLIST_BYTES} bytes / 68 NAND / 无 REF`],
      ["官方任务", `task ${ADDER8_TASK_ID} / source ${ADDER8_SOURCE_TASK_ID}`],
    ],
    [],
  );

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        requirePersistentGuard();
        const stored = readStoredGuard();
        if (!stored) return;
        if (stored.status === "signing") {
          setPhase("submitted");
          setMessage(
            `发现尚无交易哈希的签名保护记录（nonce ${stored.nonce}）。为防止重复流片，禁止重发；请先核对钱包活动。`,
          );
          return;
        }
        setTransactionHash(stored.hash);
        if (stored.circuitId) setActualCircuitId(BigInt(stored.circuitId));
        if (stored.status === "complete") {
          setPhase("complete");
          setMessage(`已恢复成功记录：Circuit #${stored.circuitId ?? "?"} 已完成流片。`);
          return;
        }
        void resumeVerification(stored.hash, stored.account, stored.nonce, stored.createdAt);
      } catch (error) {
        setPhase("submitted");
        setMessage(errorText(error));
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  async function resumeVerification(
    hash: Hex,
    account: Address = MINI4_CREATOR,
    nonce = 0,
    createdAt = new Date().toISOString(),
  ) {
    setTransactionHash(hash);
    setPhase("mining");
    setMessage("交易已经发送，正在等待确认并验收；此时不会允许再次流片。 ");
    try {
      const verified = await verifyTapeout(hash, account);
      setRemainingNand(verified.nandBalance);
      setActualCircuitId(verified.circuitId);
      writeStoredGuard({
        status: "complete",
        account,
        nonce,
        hash,
        createdAt,
        circuitId: verified.circuitId.toString(),
      });
      setPhase("complete");
      setMessage(
        `流片成功：Circuit #${verified.circuitId} 的交易内容、事件、所有者、规格、网表哈希和 5 组加法样例均已通过链上验收。`,
      );
    } catch (error) {
      if (error instanceof SubmittedTransactionRevertedError) {
        window.localStorage.removeItem(SUBMISSION_STORAGE_KEY);
        setTransactionHash(null);
        setPhase("error");
        setMessage("交易已明确回滚，没有创建电路；可以重新执行只读检查。 ");
        return;
      }
      setPhase("submitted");
      setMessage(
        `交易 ${hash.slice(0, 12)}… 已发送，但暂未完成验收。为防止重复流片，发送按钮保持锁定；请稍后点“重新验收”。`,
      );
    }
  }

  async function check() {
    setPhase("checking");
    setMessage("正在连接钱包并执行只读链上模拟…");
    setPreflight(null);
    try {
      requirePersistentGuard();
      const stored = readStoredGuard();
      if (stored) {
        throw new Error("检测到既有签名/交易保护记录；为防止重复流片，已停止。 ");
      }
      const { account } = await requireWallet();
      const result = await runPreflight(account);
      setPreflight(result);
      setPhase("ready");
      setMessage("全部检查通过。下一步只会打开钱包确认，不会读取或保存私钥。");
    } catch (error) {
      setPhase("error");
      setMessage(errorText(error));
    }
  }

  async function tapeout() {
    if (!preflight || !ready) return;
    setPhase("signing");
    setMessage("请在钱包中核对：BNB Chain、目标 MINI-4、value = 0，然后确认。 ");
    try {
      const { walletClient, account } = await requireWallet();
      if (!isAddressEqual(account, preflight.account)) {
        throw new Error("钱包账户在检查后发生了变化，已停止。 ");
      }
      const fresh = await runPreflight(account);
      const createdAt = new Date().toISOString();
      writeStoredGuard({
        status: "signing",
        account,
        nonce: fresh.nonce,
        createdAt,
      });
      const hash = await walletClient.writeContract({
        account,
        chain: bsc,
        address: MINI4_PROCESSOR,
        abi: PROCESSOR_TAPEOUT_ABI,
        functionName: "tapeout",
        args: [ADDER8_NETLIST, ADDER8_INPUTS, ADDER8_OUTPUTS],
        gas: fresh.gasLimit,
        gasPrice: fresh.gasPrice,
        nonce: fresh.nonce,
      });
      writeStoredGuard({
        status: "submitted",
        account,
        nonce: fresh.nonce,
        hash,
        createdAt,
      });
      setTransactionHash(hash);
      await resumeVerification(hash, account, fresh.nonce, createdAt);
    } catch (error) {
      if (!transactionHash && typeof error === "object" && error !== null && "code" in error && error.code === 4001) {
        window.localStorage.removeItem(SUBMISSION_STORAGE_KEY);
      }
      setPhase("error");
      setMessage(errorText(error));
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "#07100d", color: "#f4f7ed", padding: "32px 18px 72px" }}>
      <div style={{ width: "min(900px, 100%)", margin: "0 auto" }}>
        <p style={{ color: "#75f7b1", letterSpacing: "0.18em", fontWeight: 800 }}>MINI-4 · SAFE TAPEOUT</p>
        <h1 style={{ fontSize: "clamp(2rem, 6vw, 4.6rem)", lineHeight: 1, margin: "12px 0 18px" }}>
          8-bit Adder → Circuit #6
        </h1>
        <p style={{ maxWidth: 760, color: "#b7c7bd", fontSize: 18, lineHeight: 1.65 }}>
          固定使用 TapeOut 官方 REF-free 参考网表。连接钱包只用于签署一次
          <code> tapeout(bytes,16,9)</code>；页面不接收私钥，不铸造新晶体管，也不发送 BNB value。
        </p>

        <section style={{ marginTop: 28, border: "1px solid #29483a", borderRadius: 18, background: "#0b1813", padding: 22 }}>
          <h2 style={{ marginTop: 0 }}>固定流片工件</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
            {artifactSummary.map(([label, value]) => (
              <div key={label} style={{ borderTop: "1px solid #29483a", paddingTop: 10 }}>
                <dt style={{ color: "#7d9c8b", fontSize: 12 }}>{label}</dt>
                <dd style={{ margin: "5px 0 0", fontWeight: 750 }}>{value}</dd>
              </div>
            ))}
          </dl>
          <p style={{ overflowWrap: "anywhere", color: "#93aa9d", fontSize: 13 }}>
            SHA-256: {ADDER8_NETLIST_SHA256}
          </p>
          <p style={{ overflowWrap: "anywhere", color: "#93aa9d", fontSize: 13 }}>
            Processor: {MINI4_PROCESSOR}
          </p>
        </section>

        <section style={{ marginTop: 18, border: "1px solid #29483a", borderRadius: 18, background: "#0b1813", padding: 22 }}>
          <h2 style={{ marginTop: 0 }}>安全门</h2>
          <ul style={{ color: "#b7c7bd", lineHeight: 1.75, paddingLeft: 20 }}>
            <li>只接受创建者钱包 {shortAddress(MINI4_CREATOR)}</li>
            <li>固定 BNB Chain 56、Processor、Transistors、Beacon 和 Implementation</li>
            <li>要求最新电路仍为 #5，并先做 eth_call 模拟与 gas 上限检查</li>
            <li>固定 gas price ≤ 0.1 gwei、gas 总上限 ≤ 0.0001 BNB，并锁定交易 nonce</li>
            <li>交易后按 TapedOut 事件的实际 ID 核对元数据、所有者、网表及 5 组链上算例</li>
          </ul>

          {preflight ? (
            <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, margin: "20px 0" }}>
              <div><dt style={{ color: "#7d9c8b" }}>检查区块</dt><dd style={{ margin: 0 }}>{preflight.blockNumber.toString()}</dd></div>
              <div><dt style={{ color: "#7d9c8b" }}>当前 NAND</dt><dd style={{ margin: 0 }}>{preflight.nandBalance.toString()} → {String(preflight.nandBalance - ADDER8_NAND_COUNT)}</dd></div>
              <div><dt style={{ color: "#7d9c8b" }}>Gas estimate</dt><dd style={{ margin: 0 }}>{preflight.gasEstimate.toString()}</dd></div>
              <div><dt style={{ color: "#7d9c8b" }}>Gas limit</dt><dd style={{ margin: 0 }}>{preflight.gasLimit.toString()}</dd></div>
              <div><dt style={{ color: "#7d9c8b" }}>Gas price</dt><dd style={{ margin: 0 }}>{formatGwei(preflight.gasPrice)} gwei</dd></div>
              <div><dt style={{ color: "#7d9c8b" }}>Gas 上限金额</dt><dd style={{ margin: 0 }}>{formatEther(preflight.maxGasCost)} BNB</dd></div>
            </dl>
          ) : null}

          <div aria-live="polite" style={{ borderRadius: 10, padding: 13, background: phase === "error" ? "#381617" : phase === "complete" ? "#103721" : "#111f19", color: phase === "error" ? "#ffb7b2" : "#d7e9dc" }}>
            {message}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
            <button type="button" disabled={busy || hasSubmitted} onClick={check} style={{ border: "1px solid #75f7b1", borderRadius: 12, padding: "13px 17px", color: "#f4f7ed", background: "transparent", cursor: busy ? "wait" : "pointer", fontWeight: 800 }}>
              {phase === "checking" ? "检查中…" : "连接钱包并只读检查"}
            </button>
            <button type="button" disabled={!ready || busy} onClick={tapeout} style={{ border: 0, borderRadius: 12, padding: "13px 17px", color: ready ? "#05110b" : "#617269", background: ready ? "#75f7b1" : "#24342c", cursor: ready ? "pointer" : "not-allowed", fontWeight: 900 }}>
              {phase === "signing" ? "等待钱包…" : phase === "mining" ? "链上确认中…" : "流片 Circuit #6（钱包确认一次）"}
            </button>
            {transactionHash && phase === "submitted" ? (
              <button type="button" onClick={() => void resumeVerification(transactionHash)} style={{ border: "1px solid #d7e9dc", borderRadius: 12, padding: "13px 17px", color: "#f4f7ed", background: "transparent", cursor: "pointer", fontWeight: 800 }}>
                重新验收已发送交易
              </button>
            ) : null}
          </div>

          {transactionHash ? (
            <p style={{ marginBottom: 0 }}>
              <a href={`https://bscscan.com/tx/${transactionHash}`} target="_blank" rel="noreferrer" style={{ color: "#75f7b1" }}>
                在 BscScan 查看交易 ↗
              </a>
            </p>
          ) : null}
          {actualCircuitId !== null ? <p>最终 Circuit ID：#{actualCircuitId.toString()}</p> : null}
          {remainingNand !== null ? <p>验收区块的 NAND 余额：{remainingNand.toString()}</p> : null}
        </section>

        <p style={{ marginTop: 22, color: "#83978b", lineHeight: 1.6 }}>
          这是不可逆的链上流片，会消耗 68 个 MINI-4 NAND 和 gas。预检预计 ID 为 #6；若极小概率有人在签名与入块之间抢先流片，
          TapedOut 事件中的实际 ID 才是权威结果，本页会自动按实际 ID 验收。请勿同时在其他页面发起流片。它用于把网站升级为 0–255 加法器；
          MINI-4 当前 PoD multiplier 为 0，因此本次流片本身不会直接产生 BEM 挖矿收益。
        </p>
      </div>
    </main>
  );
}
