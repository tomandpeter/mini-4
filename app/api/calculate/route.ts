import {
  calculateOnChain,
  Mini4Error,
  parseCalculationInput,
} from "@/lib/mini4-chain";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message },
    }),
    { status, headers: responseHeaders },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  try {
    const input = parseCalculationInput(body);
    const result = await calculateOnChain(input);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof Mini4Error) {
      return errorResponse(error.code, error.message, error.httpStatus);
    }

    return errorResponse(
      "INTERNAL_ERROR",
      "The on-chain calculation could not be completed.",
      500,
    );
  }
}

export async function GET(): Promise<Response> {
  return errorResponse(
    "METHOD_NOT_ALLOWED",
    "Use POST with circuit and inputs to calculate on-chain.",
    405,
  );
}
