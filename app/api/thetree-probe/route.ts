import { createRequire } from "node:module";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const require = createRequire(import.meta.url);
    const ivm = require("isolated-vm");
    const parser = require("thetree/utils/namumark/parser");

    const isolate = new ivm.Isolate({ memoryLimit: 8 });
    const context = await isolate.createContext();
    await context.global.set("x", 2);
    const evaluated = await context.eval("x + 3", { timeout: 100 });
    isolate.dispose();

    const parsed = parser("= Probe =\n'''bold''' [[RESCENE]]");

    return NextResponse.json({
      ok: true,
      isolatedVm: evaluated === 5,
      parser: Boolean(parsed?.result || parsed),
      parsedType: typeof parsed,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      },
      { status: 500 },
    );
  }
}
