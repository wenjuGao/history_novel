"use client";

import { useEffect, useState, type FormEvent } from "react";
import { astronomicalToHistorical, historicalToAstronomical } from "@/lib/history-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type Scope = { startYear: string; endYear: string; region: string };
const empty: Scope = { startYear: "", endYear: "", region: "" };

export function ScopePanel({
	projectId,
	onSaved,
}: {
	projectId: string;
	onSaved?: () => void;
}) {
	const [scope, setScope] = useState<Scope>(empty);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setMessage("");
		setScope(empty);
		fetch(`/api/projects/${projectId}/scope`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("无法读取历史范围。");
				return response.json() as Promise<{ scope?: { startYear: number; endYear: number; region: string } | null }>;
			})
			.then((data) => {
				if (data.scope) {
					setScope({
						startYear: String(astronomicalToHistorical(data.scope.startYear)),
						endYear: String(astronomicalToHistorical(data.scope.endYear)),
						region: data.scope.region,
					});
				}
			})
			.catch((cause: unknown) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setMessage("无法读取历史范围。");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [projectId]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setMessage("");
		try {
			const response = await fetch(`/api/projects/${projectId}/scope`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					startYear: historicalToAstronomical(Number(scope.startYear)),
					endYear: historicalToAstronomical(Number(scope.endYear)),
					region: scope.region,
				}),
			});
			const result = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(result.error ?? "保存失败。");
			setMessage("历史范围已保存，候选名单按新区间重新查询。");
			onSaved?.();
		} catch (cause) {
			setMessage(cause instanceof Error ? cause.message : "保存失败。");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="flex flex-col gap-3" aria-label="历史范围">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				使用历史纪年，公元前填负数，没有公元 0 年。范围只用于查询已预处理的人物年份档案与带年纪事，保存不会触发生成。
			</p>

			{loading ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-9" />
					<Skeleton className="h-9" />
					<Skeleton className="h-9" />
				</div>
			) : (
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1.5">
							<Label htmlFor="scope-start">起始年份</Label>
							<Input
								id="scope-start"
								type="number"
								required
								min={-10000}
								max={10000}
								value={scope.startYear}
								onChange={(event) => setScope({ ...scope, startYear: event.target.value })}
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<Label htmlFor="scope-end">结束年份</Label>
							<Input
								id="scope-end"
								type="number"
								required
								min={-10000}
								max={10000}
								value={scope.endYear}
								onChange={(event) => setScope({ ...scope, endYear: event.target.value })}
							/>
						</label>
					</div>
					<label className="flex flex-col gap-1.5">
						<Label htmlFor="scope-region">区域（可留空）</Label>
						<Input
							id="scope-region"
							maxLength={200}
							value={scope.region}
							placeholder="例如：关中、江南；留空表示不限区域"
							onChange={(event) => setScope({ ...scope, region: event.target.value })}
						/>
					</label>
					<div className="flex items-center gap-2">
						<Button type="submit" size="sm" disabled={saving}>
							{saving ? "保存中…" : "保存历史范围"}
						</Button>
						{message && (
							<p className="text-[11px] leading-snug text-muted-foreground" role="status">
								{message}
							</p>
						)}
					</div>
				</form>
			)}
		</section>
	);
}
