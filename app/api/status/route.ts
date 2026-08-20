import { getMini4Config } from "@/lib/mini4-config";
import { Mini4Error, probeMini4Chain } from "@/lib/mini4-chain";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

export async function GET(): Promise<Response> {
  const config = getMini4Config();
  let blockNumber: string | undefined;
  let chainOnline: boolean | null = null;
  let rpcError: { code: string; message: string } | undefined;

  if (
    config.chain.supported &&
    config.chain.rpcConfigured &&
    config.processor.configured
  ) {
    try {
      const probe = await probeMini4Chain();
      blockNumber = probe.blockNumber;
      chainOnline = true;
    } catch (error) {
      chainOnline = false;
      rpcError =
        error instanceof Mini4Error
          ? { code: error.code, message: error.message }
          : {
              code: "RPC_UNAVAILABLE",
              message: "The configured BNB RPC endpoint is unavailable.",
            };
    }
  }

  const configurationBlocked = config.blockers.length > 0;
  const status = configurationBlocked ? "blocked" : rpcError ? "degraded" : "ready";
  const error = configurationBlocked
    ? {
        code: "CONFIGURATION_BLOCKED",
        message: config.blockers.join(" | "),
      }
    : rpcError;

  const payload = {
    status,
    chain: {
      id: config.chain.id,
      name: config.chain.name,
      explorerBaseUrl: config.chain.explorerBaseUrl,
      rpcConfigured: config.chain.rpcConfigured,
      online: chainOnline,
    },
    circuits: Object.values(config.circuits).map((circuit) => ({
      key: circuit.key,
      number: circuit.number,
      label: circuit.label,
      ...(circuit.address ? { address: circuit.address } : {}),
      configured: circuit.configured,
    })),
    ...(blockNumber ? { blockNumber } : {}),
    ...(error ? { error } : {}),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: responseHeaders,
  });
}
