"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type Bit = 0 | 1;
type CircuitKey = "nand" | "not" | "and" | "xor" | "halfAdder";
type SiteState = "ready" | "blocked" | "degraded";
type ActiveOperand = "A" | "B";

type CircuitStatus = {
  key: CircuitKey;
  number: number;
  label: string;
  address?: string;
  configured: boolean;
};

type StatusResponse = {
  status: SiteState;
  chain: {
    id: number | null;
    name: string;
    explorerBaseUrl: string;
    rpcConfigured: boolean;
    online: boolean | null;
  };
  circuits: CircuitStatus[];
  blockNumber?: string;
  error?: { code: string; message: string };
};

type Evidence = {
  chainId: number;
  blockNumber: string;
  address: string;
  calldata: string;
  rawResult: string;
  explorerUrl: string;
  durationMs: number;
};

type ScalarSuccess = {
  ok: true;
  circuit: Exclude<CircuitKey, "halfAdder">;
  inputs: Bit[];
  outputs: { result: Bit };
  evidence: Evidence;
};

type HalfAdderSuccess = {
  ok: true;
  circuit: "halfAdder";
  inputs: Bit[];
  outputs: {
    sum: Bit;
    carry: Bit;
    binary: "00" | "01" | "10";
    decimal: 0 | 1 | 2;
  };
  evidence: Evidence;
};

type CalculationSuccess = ScalarSuccess | HalfAdderSuccess;
type LogicResult = Partial<
  Record<Exclude<CircuitKey, "halfAdder">, ScalarSuccess>
>;

type TelemetryEntry = {
  circuit: CircuitKey;
  evidence: Evidence;
};

const LOGIC_CIRCUITS = ["nand", "not", "and", "xor"] as const;
const CIRCUIT_IDS: Record<CircuitKey, number> = {
  nand: 1,
  not: 2,
  and: 3,
  xor: 4,
  halfAdder: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBit(value: unknown): value is Bit {
  return value === 0 || value === 1;
}

function hasValidEvidence(value: unknown): value is Evidence {
  if (!isRecord(value)) return false;

  return (
    value.chainId === 56 &&
    typeof value.blockNumber === "string" &&
    /^\d+$/.test(value.blockNumber) &&
    typeof value.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
    typeof value.calldata === "string" &&
    /^0x[0-9a-fA-F]+$/.test(value.calldata) &&
    typeof value.rawResult === "string" &&
    /^0x[0-9a-fA-F]+$/.test(value.rawResult) &&
    typeof value.explorerUrl === "string" &&
    /^https?:\/\//.test(value.explorerUrl) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

function isCalculationSuccessFor(
  value: unknown,
  circuit: CircuitKey,
  inputs: Bit[],
): value is CalculationSuccess {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.circuit !== circuit ||
    !Array.isArray(value.inputs) ||
    value.inputs.length !== inputs.length ||
    !value.inputs.every((bit, index) => bit === inputs[index]) ||
    !isRecord(value.outputs) ||
    !hasValidEvidence(value.evidence)
  ) {
    return false;
  }

  if (circuit !== "halfAdder") {
    return isBit(value.outputs.result);
  }

  const { sum, carry, binary, decimal } = value.outputs;
  return (
    isBit(sum) &&
    isBit(carry) &&
    ((sum === 0 && carry === 0 && binary === "00" && decimal === 0) ||
      (sum === 1 && carry === 0 && binary === "01" && decimal === 1) ||
      (sum === 0 && carry === 1 && binary === "10" && decimal === 2))
  );
}

function shortAddress(address?: string): string {
  if (!address) return "NOT CONFIGURED";
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function shortHex(value: string): string {
  if (value.length <= 34) return value;
  return `${value.slice(0, 22)}…${value.slice(-10)}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

async function calculate(
  circuit: CircuitKey,
  inputs: Bit[],
): Promise<CalculationSuccess> {
  const response = await fetch("/api/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ circuit, inputs }),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      errorMessage(payload, "The on-chain call failed. No result was generated."),
    );
  }
  if (!isCalculationSuccessFor(payload, circuit, inputs)) {
    throw new Error("The on-chain response did not pass validation.");
  }
  return payload;
}

async function fetchStatusPayload(): Promise<StatusResponse> {
  const response = await fetch("/api/status", { cache: "no-store" });
  const payload = await readJson(response);
  if (!response.ok || typeof payload !== "object" || payload === null) {
    throw new Error(errorMessage(payload, "Could not read chain status."));
  }
  return payload as StatusResponse;
}

function BitSwitch({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: Bit;
  disabled?: boolean;
  onChange: (next: Bit) => void;
}) {
  return (
    <div className="bit-control">
      <span className="bit-label" id={`${id}-label`}>
        INPUT {label}
      </span>
      <button
        className={`bit-switch bit-switch--${value}`}
        type="button"
        aria-label={`Input ${label}, current value ${value}. Press to set ${value === 1 ? 0 : 1}.`}
        aria-pressed={value === 1}
        disabled={disabled}
        onClick={() => onChange(value === 1 ? 0 : 1)}
      >
        <span aria-hidden="true" className="bit-switch__rail">
          <span className="bit-switch__zero">0</span>
          <span className="bit-switch__one">1</span>
          <span className="bit-switch__knob" />
        </span>
        <span className="sr-only">{value}</span>
      </button>
    </div>
  );
}

function SignalLamp({
  label,
  value,
  pending,
}: {
  label: string;
  value?: Bit;
  pending?: boolean;
}) {
  const state = pending ? "pending" : value === undefined ? "idle" : `bit-${value}`;
  const spoken = pending
    ? "querying chain"
    : value === undefined
      ? "no result"
      : value === 1
        ? "1, high"
        : "0, low";

  return (
    <div className={`signal signal--${state}`}>
      <span className="signal__lamp" aria-hidden="true" />
      <span className="signal__label">{label}</span>
      <strong className="signal__value">{pending ? "·" : (value ?? "—")}</strong>
      <span className="sr-only">{`${label}: ${spoken}`}</span>
    </div>
  );
}

function StatusConsole({
  status,
  loading,
  loadError,
  onRetry,
}: {
  status: StatusResponse | null;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
}) {
  const state = loading
    ? "checking"
    : loadError
      ? "degraded"
      : (status?.status ?? "blocked");
  const headline =
    state === "ready"
      ? "PROCESSOR READY"
      : state === "checking"
        ? "CHECKING PROCESSOR"
        : state === "degraded"
          ? status?.error?.code === "RPC_UNAVAILABLE"
            ? "RPC UNAVAILABLE"
            : "CHAIN CHECK FAILED"
          : "CONFIGURATION BLOCKED";
  const detail = loadError ?? status?.error?.message;
  const processorAddress = status?.circuits.find((circuit) => circuit.address)?.address;

  return (
    <aside className={`status-console status-console--${state}`} aria-live="polite">
      <div className="status-console__headline">
        <span className="status-dot" aria-hidden="true" />
        <strong>{headline}</strong>
      </div>
      <dl className="status-grid">
        <div>
          <dt>NETWORK</dt>
          <dd>{status?.chain.name ?? "BNB CHAIN"}</dd>
        </div>
        <div>
          <dt>LATEST BLOCK</dt>
          <dd>{status?.blockNumber ?? "—"}</dd>
        </div>
        <div>
          <dt>CIRCUIT IDS</dt>
          <dd>
            {status?.status === "ready"
              ? `${status.circuits.filter((item) => item.configured).length}/5`
              : "0/5"}
          </dd>
        </div>
      </dl>
      {detail ? (
        <p className="status-console__detail">{detail}</p>
      ) : processorAddress ? (
        <p className="status-console__detail">
          ONE COMMUNITY PROCESSOR · {shortAddress(processorAddress)}
        </p>
      ) : null}
      {loadError ? (
        <button className="text-button" type="button" onClick={onRetry}>
          Retry status
        </button>
      ) : null}
    </aside>
  );
}

function EvidencePanel({ entries }: { entries: TelemetryEntry[] }) {
  return (
    <section className="telemetry" aria-labelledby="telemetry-title">
      <div className="section-kicker">
        <span>UNIFIED PROCESSOR / READ-ONLY TELEMETRY</span>
        <span>{entries.length ? "ETH_CALL EVIDENCE" : "AWAITING CALL"}</span>
      </div>
      <h3 id="telemetry-title">One processor. Every result traceable.</h3>
      {entries.length === 0 ? (
        <p className="telemetry__empty">
          No browser-side answer is waiting underneath. A verified read-only
          eth_call to the community MINI-4 processor must finish before an output
          appears here.
        </p>
      ) : (
        <div className="telemetry__entries">
          {entries.map((entry) => (
            <article
              className="telemetry-entry"
              key={`${entry.circuit}-${entry.evidence.blockNumber}-${entry.evidence.calldata}`}
            >
              <div className="telemetry-entry__topline">
                <strong>
                  CIRCUIT ID #{CIRCUIT_IDS[entry.circuit]} /{" "}
                  {entry.circuit === "halfAdder" ? "HALF ADDER" : entry.circuit.toUpperCase()}
                </strong>
                <span>{entry.evidence.durationMs} ms</span>
              </div>
              <dl>
                <div>
                  <dt>BLOCK</dt>
                  <dd>{entry.evidence.blockNumber}</dd>
                </div>
                <div>
                  <dt>PROCESSOR</dt>
                  <dd>
                    <a
                      href={entry.evidence.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open MINI-4 processor ${entry.evidence.address} in the block explorer`}
                    >
                      {shortAddress(entry.evidence.address)}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>CALLDATA</dt>
                  <dd title={entry.evidence.calldata}>{shortHex(entry.evidence.calldata)}</dd>
                </div>
                <div>
                  <dt>RAW RESULT</dt>
                  <dd title={entry.evidence.rawResult}>{shortHex(entry.evidence.rawResult)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function Mini4Lab() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [adderA, setAdderA] = useState<Bit>(0);
  const [adderB, setAdderB] = useState<Bit>(0);
  const [activeOperand, setActiveOperand] = useState<ActiveOperand>("A");
  const [adderPending, setAdderPending] = useState(false);
  const [adderResult, setAdderResult] = useState<HalfAdderSuccess | null>(null);
  const [adderError, setAdderError] = useState<string | null>(null);
  const [logicA, setLogicA] = useState<Bit>(1);
  const [logicB, setLogicB] = useState<Bit>(0);
  const [logicPending, setLogicPending] = useState(false);
  const [logicResults, setLogicResults] = useState<LogicResult>({});
  const [logicError, setLogicError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryEntry[]>([]);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await fetchStatusPayload());
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : "Could not read chain status.");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchStatusPayload()
      .then((payload) => {
        if (active) setStatus(payload);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus(null);
        setStatusError(
          error instanceof Error ? error.message : "Could not read chain status.",
        );
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const ready =
    status?.status === "ready" &&
    status.chain.id === 56 &&
    status.chain.online === true &&
    status.circuits.length === 5 &&
    status.circuits.every((circuit) => circuit.configured && circuit.address) &&
    !statusLoading &&
    !statusError;
  const circuitMap = useMemo(
    () => new Map(status?.circuits.map((circuit) => [circuit.key, circuit]) ?? []),
    [status],
  );

  const clearAdder = () => {
    setAdderResult(null);
    setAdderError(null);
  };

  const runAdder = async () => {
    if (!ready || adderPending) return;
    setAdderPending(true);
    setAdderError(null);
    setAdderResult(null);
    try {
      const result = await calculate("halfAdder", [adderA, adderB]);
      if (result.circuit !== "halfAdder") {
        throw new Error("The server returned the wrong circuit result.");
      }
      setAdderResult(result);
      setTelemetry((current) => [
        { circuit: result.circuit, evidence: result.evidence },
        ...current,
      ].slice(0, 5));
    } catch (error) {
      setAdderError(
        error instanceof Error ? error.message : "The on-chain half adder failed.",
      );
    } finally {
      setAdderPending(false);
    }
  };

  const enterCalculatorBit = (bit: Bit) => {
    if (adderPending) return;
    if (activeOperand === "A") setAdderA(bit);
    else setAdderB(bit);
    clearAdder();
  };

  const selectSecondOperand = () => {
    if (adderPending) return;
    setActiveOperand("B");
    clearAdder();
  };

  const resetCalculator = () => {
    if (adderPending) return;
    setAdderA(0);
    setAdderB(0);
    setActiveOperand("A");
    clearAdder();
  };

  const handleCalculatorKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const nestedControl =
      event.target instanceof HTMLElement
        ? event.target.closest("button, a")
        : null;
    if (
      nestedControl instanceof HTMLAnchorElement ||
      nestedControl?.classList.contains("text-button")
    ) {
      return;
    }

    if (event.key === "0" || event.key === "1") {
      event.preventDefault();
      enterCalculatorBit(Number(event.key) as Bit);
      return;
    }
    if (event.key === "+") {
      event.preventDefault();
      selectSecondOperand();
      return;
    }
    if (event.key === "Enter" || event.key === "=") {
      event.preventDefault();
      void runAdder();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetCalculator();
    }
  };

  const clearLogic = () => {
    setLogicResults({});
    setLogicError(null);
  };

  const runLogicLab = async () => {
    if (!ready || logicPending) return;
    setLogicPending(true);
    setLogicResults({});
    setLogicError(null);

    try {
      const settled = await Promise.allSettled(
        LOGIC_CIRCUITS.map(async (circuit) => {
          const inputs: Bit[] = circuit === "not" ? [logicA] : [logicA, logicB];
          const result = await calculate(circuit, inputs);
          if (result.circuit === "halfAdder") {
            throw new Error("The server returned the wrong circuit result.");
          }
          return result;
        }),
      );
      const successes = settled
        .filter((item): item is PromiseFulfilledResult<ScalarSuccess> => item.status === "fulfilled")
        .map((item) => item.value);
      const failed = settled.filter((item) => item.status === "rejected");

      setLogicResults(
        Object.fromEntries(successes.map((result) => [result.circuit, result])) as LogicResult,
      );
      if (successes.length) {
        setTelemetry((current) => [
          ...successes.map((result) => ({
            circuit: result.circuit,
            evidence: result.evidence,
          })),
          ...current,
        ].slice(0, 5));
      }
      if (failed.length) {
        const firstFailure = failed[0];
        setLogicError(
          firstFailure.status === "rejected" && firstFailure.reason instanceof Error
            ? firstFailure.reason.message
            : "One or more on-chain logic calls failed.",
        );
      }
    } finally {
      setLogicPending(false);
    }
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="MINI-4 home">
          <span className="wordmark__mark">M4</span>
          <span>
            <strong>MINI-4</strong>
            <small>COMMUNITY ON-CHAIN PROCESSOR</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#calculator">Calculator</a>
          <a href="#logic-lab">Logic Lab</a>
          <a href="#circuits">Circuit IDs</a>
          <a href="https://github.com/tomandpeter/mini-4" target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </nav>
      </header>

      <section className="hero" id="top" aria-labelledby="page-title">
        <div className="hero__copy">
          <p className="eyebrow">ONE BIT / ONE PROCESSOR / BNB MAINNET</p>
          <h1 id="page-title">
            A calculator
            <span>built on-chain.</span>
          </h1>
          <p className="hero__lede">
            Enter 0 or 1. MINI-4 asks a community-built processor for the answer
            and shows nothing if the chain cannot verify it.
          </p>
          <div className="hero__proof">
            <span>NO WALLET</span>
            <span>NO TRANSACTION</span>
            <span>NO GAS FEE</span>
            <span>READ-ONLY ETH_CALL</span>
          </div>
        </div>
        <section
          className="calculator-machine"
          id="calculator"
          aria-labelledby="calculator-title"
          aria-describedby="calculator-help keyboard-help"
          tabIndex={0}
          onKeyDown={handleCalculatorKeyDown}
        >
          <header className="calculator-machine__header">
            <div>
              <span className="calculator-machine__brand">MINI-4</span>
              <h2 id="calculator-title">Decimal calculator</h2>
            </div>
            <div className="mode-badge">
              <span aria-hidden="true" />
              1-BIT MODE
            </div>
          </header>

          <div
            className="calculator-display"
            aria-live="polite"
            aria-atomic="true"
            aria-busy={adderPending}
          >
            <div className="calculator-display__topline">
              <span>DECIMAL / CIRCUIT ID #5</span>
              <span>{adderPending ? "READING BNB MAINNET…" : "READY FOR INPUT"}</span>
            </div>
            <div className="calculator-expression" aria-label={`Expression: ${adderA} plus ${adderB}`}>
              <button
                className={`operand ${activeOperand === "A" ? "operand--active" : ""}`}
                type="button"
                aria-pressed={activeOperand === "A"}
                disabled={adderPending}
                onClick={() => setActiveOperand("A")}
              >
                <small>A</small>
                <strong>{adderA}</strong>
              </button>
              <span aria-hidden="true">+</span>
              <button
                className={`operand ${activeOperand === "B" ? "operand--active" : ""}`}
                type="button"
                aria-pressed={activeOperand === "B"}
                disabled={adderPending}
                onClick={() => setActiveOperand("B")}
              >
                <small>B</small>
                <strong>{adderB}</strong>
              </button>
              <span aria-hidden="true">=</span>
              <div className="calculator-decimal">
                <small>CHAIN RESULT</small>
                <strong>{adderPending ? "…" : (adderResult?.outputs.decimal ?? "—")}</strong>
              </div>
            </div>
          </div>

          <div className="calculator-signals">
            <SignalLamp label="SUM" value={adderResult?.outputs.sum} pending={adderPending} />
            <SignalLamp label="CARRY" value={adderResult?.outputs.carry} pending={adderPending} />
            <div className="calculator-signals__mode">
              <span>ACTIVE INPUT</span>
              <strong>{activeOperand}</strong>
            </div>
          </div>

          <div className="calculator-lower">
            <div className="calculator-keypad" aria-label="Calculator keypad">
              {[7, 8, 9, 4, 5, 6].map((digit) => (
                <button
                  className={`calculator-key calculator-key--${digit}`}
                  type="button"
                  key={digit}
                  disabled
                  aria-describedby="future-keys-note"
                  aria-label={`${digit}, unavailable until a future 8-bit adder`}
                >
                  {digit}
                </button>
              ))}
              <button
                className="calculator-key calculator-key--plus calculator-key--operator"
                type="button"
                disabled={adderPending}
                aria-label="Plus, move to operand B"
                onClick={selectSecondOperand}
              >
                +
              </button>
              <button
                className="calculator-key calculator-key--clear"
                type="button"
                disabled={adderPending}
                aria-label="All clear, reset operands and chain result"
                onClick={resetCalculator}
              >
                AC
              </button>
              <button
                className="calculator-key calculator-key--1"
                type="button"
                disabled={adderPending}
                aria-label={`Set operand ${activeOperand} to 1`}
                onClick={() => enterCalculatorBit(1)}
              >
                1
              </button>
              {[2, 3].map((digit) => (
                <button
                  className={`calculator-key calculator-key--${digit}`}
                  type="button"
                  key={digit}
                  disabled
                  aria-describedby="future-keys-note"
                  aria-label={`${digit}, unavailable until a future 8-bit adder`}
                >
                  {digit}
                </button>
              ))}
              <button
                className="calculator-key calculator-key--0"
                type="button"
                disabled={adderPending}
                aria-label={`Set operand ${activeOperand} to 0`}
                onClick={() => enterCalculatorBit(0)}
              >
                0
              </button>
              <button
                className="calculator-key calculator-key--equals"
                type="button"
                disabled={!ready || adderPending}
                aria-label="Equals, calculate on-chain"
                onClick={() => void runAdder()}
              >
                <span>=</span>
                <small>{adderPending ? "READING…" : "ON-CHAIN"}</small>
              </button>
            </div>

            <div className="calculator-sidecar">
              <StatusConsole
                status={status}
                loading={statusLoading}
                loadError={statusError}
                onRetry={() => void refreshStatus()}
              />
              <p className="calculator-help" id="calculator-help">
                Select A or B, then press 0 or 1. Press + to move to B. Only =
                ON-CHAIN asks the processor for a result.
              </p>
              <p className="keyboard-help" id="keyboard-help">
                Keyboard: 0 / 1 / + / Enter / Escape
              </p>
            </div>
          </div>

          <div className="calculator-footer">
            <p id="future-keys-note">
              Keys 2–9 are disabled. They need a future 8-bit adder.
            </p>
            <p className="result-caption">
              {adderResult
                ? `Verified at block ${adderResult.evidence.blockNumber}. Decimal, SUM, and CARRY came from the processor response.`
                : "No chain result yet. This screen never substitutes browser arithmetic."}
            </p>
            {!ready ? (
              <p className="blocked-note" id="calculator-blocked-note">
                On-chain equals stays disabled until the processor and BNB mainnet
                RPC pass verification.
              </p>
            ) : null}
            {adderError ? (
              <p className="error-message" role="alert">
                {adderError}
              </p>
            ) : null}
          </div>
        </section>
      </section>

      <section className="calculator-explainer" aria-labelledby="comparison-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">WHAT MAKES THIS DIFFERENT</p>
            <h2 id="comparison-title">A normal calculator vs. MINI-4.</h2>
          </div>
          <p>
            The point is not speed. It is making the computation independently
            inspectable.
          </p>
        </div>
        <div className="comparison-grid">
          <article>
            <span>ORDINARY CALCULATOR</span>
            <h3>Local and immediate.</h3>
            <p>
              Handles many digits and operations instantly in the device. The
              answer does not need public chain evidence.
            </p>
          </article>
          <article className="comparison-card--mini4">
            <span>MINI-4 TODAY</span>
            <h3>One-bit and verifiable.</h3>
            <p>
              Adds only 0 or 1 through a slower read-only eth_call, then exposes
              the processor address, block, calldata, and raw result. No wallet,
              transaction, or gas is required.
            </p>
          </article>
        </div>
        <p className="proxy-boundary">
          <strong>Verification boundary:</strong> the community-created processor
          is an upgradeable beacon proxy. Each result is verified at its recorded
          block—not promised immutable forever.
        </p>
      </section>

      <section className="logic-section" id="logic-lab" aria-labelledby="logic-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CIRCUIT IDS #1–#4</p>
            <h2 id="logic-title">Logic Lab</h2>
          </div>
          <p>
            One pair of inputs, four circuit IDs, four read-only eth_calls to the
            same community processor. NOT uses A; the other gates use A and B.
          </p>
        </div>

        <div className="logic-console">
          <div className="logic-controls">
            <BitSwitch
              id="logic-a"
              label="A"
              value={logicA}
              disabled={logicPending}
              onChange={(next) => {
                setLogicA(next);
                clearLogic();
              }}
            />
            <BitSwitch
              id="logic-b"
              label="B"
              value={logicB}
              disabled={logicPending}
              onChange={(next) => {
                setLogicB(next);
                clearLogic();
              }}
            />
            <button
              className="execute-button execute-button--compact"
              type="button"
              disabled={!ready || logicPending}
              onClick={() => void runLogicLab()}
            >
              <span>{logicPending ? "QUERYING…" : "RUN LOGIC LAB"}</span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="gate-grid" aria-live="polite" aria-busy={logicPending}>
            {LOGIC_CIRCUITS.map((circuit, index) => (
              <article className="gate-card" key={circuit}>
                <div className="gate-card__header">
                  <span>#{index + 1}</span>
                  <strong>{circuit.toUpperCase()}</strong>
                </div>
                <SignalLamp
                  label="OUTPUT"
                  value={logicResults[circuit]?.outputs.result}
                  pending={logicPending}
                />
                <small>PROCESSOR {shortAddress(circuitMap.get(circuit)?.address)}</small>
              </article>
            ))}
          </div>
          {logicError ? (
            <p className="error-message logic-error" role="alert">
              {logicError}
            </p>
          ) : null}
        </div>
      </section>

      <EvidencePanel entries={telemetry} />

      <section className="circuits-section" id="circuits" aria-labelledby="circuits-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE COMMUNITY MACHINE / BNB MAINNET</p>
            <h2 id="circuits-title">One processor. Five circuit IDs.</h2>
          </div>
          <p>
            Created by the MINI-4 community, the processor exposes only the five
            circuit IDs verified on-chain today—nothing from tomorrow&apos;s roadmap.
          </p>
        </div>
        <div className="circuit-ledger">
          {(status?.circuits ?? [
            { key: "nand", number: 1, label: "NAND", configured: false },
            { key: "not", number: 2, label: "NOT", configured: false },
            { key: "and", number: 3, label: "AND", configured: false },
            { key: "xor", number: 4, label: "XOR", configured: false },
            { key: "halfAdder", number: 5, label: "HALF ADDER", configured: false },
          ] satisfies CircuitStatus[]).map((circuit) => (
            <article key={circuit.key}>
              <span className="circuit-ledger__number">#{circuit.number}</span>
              <div>
                <strong>{circuit.label}</strong>
                <small>
                  PROCESSOR ROUTE · {circuit.key === "halfAdder" ? "SUM + CARRY" : "1-BIT OUTPUT"}
                </small>
              </div>
              <span className={`circuit-state circuit-state--${ready && circuit.configured ? "ready" : "blocked"}`}>
                {ready && circuit.configured ? "ID READY" : "ID UNAVAILABLE"}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="roadmap">
        <div>
          <p className="eyebrow">NEXT / COMMUNITY CIRCUIT IDS</p>
          <h2>8-bit arithmetic.</h2>
        </div>
        <p>
          A 0–255 mode comes only after the community ships and verifies an
          8-bit arithmetic circuit ID on-chain. Multiplication waits for its own
          verified circuit ID. The interface grows only when the processor does.
        </p>
        <span className="roadmap__stamp">COMING ON-CHAIN</span>
      </section>

      <footer>
        <span>MINI-4 / ONE BIT AT A TIME</span>
        <span>COMMUNITY CREATED · BNB MAINNET · READ-ONLY ETH_CALL</span>
      </footer>
    </main>
  );
}
