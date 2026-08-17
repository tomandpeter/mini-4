"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Bit = 0 | 1;
type CircuitKey = "nand" | "not" | "and" | "xor" | "halfAdder";
type SiteState = "ready" | "blocked" | "degraded";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBit(value: unknown): value is Bit {
  return value === 0 || value === 1;
}

function hasValidEvidence(value: unknown): value is Evidence {
  if (!isRecord(value)) return false;

  return (
    (value.chainId === 56 || value.chainId === 97) &&
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
      ? "CHAIN READY"
      : state === "checking"
        ? "CHECKING CHAIN"
        : state === "degraded"
          ? "RPC UNAVAILABLE"
          : "CONFIGURATION BLOCKED";
  const detail = loadError ?? status?.error?.message;

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
          <dt>CIRCUITS</dt>
          <dd>
            {status
              ? `${status.circuits.filter((item) => item.configured).length}/5`
              : "0/5"}
          </dd>
        </div>
      </dl>
      {detail ? <p className="status-console__detail">{detail}</p> : null}
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
        <span>READ-ONLY TELEMETRY</span>
        <span>{entries.length ? "CHAIN EVIDENCE" : "AWAITING CALL"}</span>
      </div>
      <h3 id="telemetry-title">Every result leaves a call-evidence record.</h3>
      {entries.length === 0 ? (
        <p className="telemetry__empty">
          No browser-side answer is waiting underneath. A verified eth_call must
          finish before an output appears here.
        </p>
      ) : (
        <div className="telemetry__entries">
          {entries.map((entry) => (
            <article
              className="telemetry-entry"
              key={`${entry.circuit}-${entry.evidence.blockNumber}-${entry.evidence.calldata}`}
            >
              <div className="telemetry-entry__topline">
                <strong>{entry.circuit === "halfAdder" ? "HALF ADDER" : entry.circuit.toUpperCase()}</strong>
                <span>{entry.evidence.durationMs} ms</span>
              </div>
              <dl>
                <div>
                  <dt>BLOCK</dt>
                  <dd>{entry.evidence.blockNumber}</dd>
                </div>
                <div>
                  <dt>CONTRACT</dt>
                  <dd>
                    <a href={entry.evidence.explorerUrl} target="_blank" rel="noreferrer">
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
  const [adderA, setAdderA] = useState<Bit>(1);
  const [adderB, setAdderB] = useState<Bit>(1);
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
            <small>ON-CHAIN LOGIC INSTRUMENT</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#calculator">Calculator</a>
          <a href="#logic-lab">Logic Lab</a>
          <a href="#circuits">Circuits</a>
          <a href="https://github.com/tomandpeter/mini-4" target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero__copy">
          <p className="eyebrow">A DELIBERATELY TINY COMPUTER / BNB CHAIN</p>
          <h1>
            A calculator
            <span>built on-chain.</span>
          </h1>
          <p className="hero__lede">
            Two switches. One bit. Five circuit interfaces. Every answer must
            come back from contract bytecode—or it does not appear at all.
          </p>
          <div className="hero__proof">
            <span>NO WALLET</span>
            <span>NO TRANSACTION</span>
            <span>REAL ETH_CALL</span>
          </div>
        </div>
        <StatusConsole
          status={status}
          loading={statusLoading}
          loadError={statusError}
          onRetry={() => void refreshStatus()}
        />
      </section>

      <section className="instrument" id="calculator" aria-labelledby="calculator-title">
        <div className="instrument__rail" aria-hidden="true">
          <span />
          <span>MINI-4 / UNIT 05</span>
          <span />
        </div>
        <div className="instrument__header">
          <div>
            <p className="eyebrow">CIRCUIT #5 / 1-BIT HALF ADDER</p>
            <h2 id="calculator-title">The unnecessary on-chain calculator.</h2>
          </div>
          <div className="instrument__address">
            <span>CONTRACT</span>
            <strong>{shortAddress(circuitMap.get("halfAdder")?.address)}</strong>
          </div>
        </div>

        <div className="adder-console">
          <div className="input-bay">
            <div className="input-bay__switches">
              <BitSwitch
                id="adder-a"
                label="A"
                value={adderA}
                disabled={adderPending}
                onChange={(next) => {
                  setAdderA(next);
                  clearAdder();
                }}
              />
              <span className="operator" aria-hidden="true">+</span>
              <BitSwitch
                id="adder-b"
                label="B"
                value={adderB}
                disabled={adderPending}
                onChange={(next) => {
                  setAdderB(next);
                  clearAdder();
                }}
              />
            </div>
            <button
              className="execute-button"
              type="button"
              disabled={!ready || adderPending}
              onClick={() => void runAdder()}
            >
              <span>{adderPending ? "READING BLOCK…" : "ADD ON-CHAIN"}</span>
              <span aria-hidden="true">→</span>
            </button>
            {!ready ? (
              <p className="blocked-note">Enable only after all five contract endpoints pass configuration checks.</p>
            ) : null}
          </div>

          <div className="result-bay" aria-live="polite" aria-busy={adderPending}>
            <div className="result-bay__signals">
              <SignalLamp label="SUM" value={adderResult?.outputs.sum} pending={adderPending} />
              <SignalLamp label="CARRY" value={adderResult?.outputs.carry} pending={adderPending} />
            </div>
            <div className="number-readout">
              <div>
                <span>BINARY</span>
                <strong>{adderResult?.outputs.binary ?? "—"}</strong>
              </div>
              <div>
                <span>DECIMAL</span>
                <strong>{adderResult?.outputs.decimal ?? "—"}</strong>
              </div>
            </div>
            <p className="result-caption">
              {adderResult
                ? `Computed by Circuit #5 at block ${adderResult.evidence.blockNumber}.`
                : "No result is precomputed in this interface."}
            </p>
            {adderError ? <p className="error-message">{adderError}</p> : null}
          </div>
        </div>
      </section>

      <section className="logic-section" id="logic-lab" aria-labelledby="logic-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CIRCUITS #1–#4</p>
            <h2 id="logic-title">Logic Lab</h2>
          </div>
          <p>
            One pair of inputs, four independent contract reads. NOT uses A;
            the other gates use A and B.
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
                <small>{shortAddress(circuitMap.get(circuit)?.address)}</small>
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
            <p className="eyebrow">THE CURRENT MACHINE</p>
            <h2 id="circuits-title">Five circuit interfaces. No pretend results.</h2>
          </div>
          <p>
            MINI-4 exposes exactly what has been configured on-chain today—and
            nothing from tomorrow&apos;s roadmap.
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
                <small>{circuit.key === "halfAdder" ? "SUM + CARRY" : "1-BIT OUTPUT"}</small>
              </div>
              <span className={`circuit-state circuit-state--${circuit.configured ? "ready" : "blocked"}`}>
                {circuit.configured ? "CONNECTED" : "UNCONFIGURED"}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="roadmap">
        <div>
          <p className="eyebrow">NEXT / CIRCUIT #6+</p>
          <h2>8-bit arithmetic.</h2>
        </div>
        <p>
          Addition from 0–255 comes only after an 8-bit adder is deployed and
          verified. Multiplication waits for a multiplier. The interface will
          grow when the machine does.
        </p>
        <span className="roadmap__stamp">COMING ON-CHAIN</span>
      </section>

      <footer>
        <span>MINI-4 / ONE BIT AT A TIME</span>
        <span>BNB CHAIN · READ-ONLY · OPEN SOURCE</span>
      </footer>
    </main>
  );
}
