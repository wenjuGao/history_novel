"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

type ModelsResponse = {
	provider?: string;
	billingMode?: string;
	region?: string;
	baseURL?: string;
	configured?: boolean;
	writingModel?: string;
	fastModel?: string;
	models?: Record<string, { name: string; role: string; inputPricePerMillion: number; outputPricePerMillion: number }>;
	error?: string;
};

export function SettingsPanel() {
	const [data, setData] = useState<ModelsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState("");

	async function load() {
		setLoading(true);
		setFailed("");
		try {
			const response = await fetch("/api/models", { cache: "no-store" });
			const result = (await response.json()) as ModelsResponse;
			if (!response.ok) throw new Error(result.error ?? "无法读取百炼配置。");
			setData(result);
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "无法读取百炼配置。");
			setData(null);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void load();
	}, []);

	return (
		<div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6 px-6 py-8">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-serif text-[18px] text-foreground">百炼调用配置</h2>
					<p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
						Key 只由本机服务端读取，不进入作品数据与导出；未配置时应用不发送任何外部请求。
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
					<RefreshCw size={14} /> 重新检查
				</Button>
			</header>

			{failed && (
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertTitle>配置读取失败</AlertTitle>
					<AlertDescription>{failed}</AlertDescription>
				</Alert>
			)}

			{loading ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-10" />
					<Skeleton className="h-32" />
				</div>
			) : data ? (
				<section className="flex flex-col gap-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<Stat label="计费模式" value={data.billingMode === "token-plan" ? "Token Plan 套餐" : "按量计费"} />
						<Stat label="地域" value={`${data.region ?? "cn-beijing"} · ${data.configured ? "已配置" : "未配置"}`} />
					</div>
					<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-3 py-2.5">
						<p className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
							<KeyRound size={12} /> 服务端点
						</p>
						<code className="break-all font-mono text-[12px] text-foreground">{data.baseURL}</code>
					</div>

					<Separator />

					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>模型</TableHead>
								<TableHead>用途</TableHead>
								<TableHead>输入 / 输出 · 元/百万 Token</TableHead>
								<TableHead className="text-right">角色</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{Object.entries(data.models ?? {}).map(([id, model]) => (
								<TableRow key={id}>
									<TableCell className="font-serif text-[13px]">{model.name}</TableCell>
									<TableCell className="text-muted-foreground">{model.role}</TableCell>
									<TableCell className="font-mono text-[12px]">
										{model.inputPricePerMillion} / {model.outputPricePerMillion}
									</TableCell>
									<TableCell className="text-right">
										{data.writingModel === id ? (
											<Badge variant="success">正文</Badge>
										) : data.fastModel === id ? (
											<Badge variant="secondary">提取</Badge>
										) : (
											<Badge variant="outline">未启用</Badge>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					<p className="text-[11px] leading-relaxed text-muted-foreground">
						价格为文档查询日快照，实际单价、促销与套餐 Credits 以百炼控制台为准。
						{data.billingMode === "token-plan" && "套餐模式下不折算人民币费用。"}
					</p>
				</section>
			) : null}
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2.5">
			<span className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
			<strong className="font-serif text-[14px] font-normal text-foreground">{value}</strong>
		</div>
	);
}
