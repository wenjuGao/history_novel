import { NextResponse, type NextRequest } from "next/server";
import { BAILIAN_BASE_URL, BAILIAN_MODELS, getBailianConfiguration } from "@/lib/bailian";
import { isLoopbackRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json({ error: "仅允许本机访问。" }, { status: 403 });
  }

  try {
    const configuration = getBailianConfiguration();
    return NextResponse.json(
      {
        provider: configuration?.billingMode === "token-plan" ? "阿里云百炼 Token Plan" : "阿里云百炼按量 API",
        billingMode: configuration?.billingMode ?? "unconfigured",
        region: "cn-beijing",
        baseURL: configuration?.baseURL ?? BAILIAN_BASE_URL,
        configured: Boolean(configuration),
        writingModel: configuration?.writingModel ?? "qwen3.8-max",
        fastModel: configuration?.fastModel ?? "qwen3.8-flash",
        models: BAILIAN_MODELS,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "百炼配置无效。";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}