"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Database, LibraryBig, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog, type ProjectSummary } from "@/components/create-project-dialog";

export type CorpusRow = {
	title: string;
	detail: string;
	label: string;
	complete: boolean;
	icon: "histories" | "chronicle";
};

export type ModelInfo = {
	billingMode: "token-plan" | "pay-as-you-go" | "unconfigured";
	hasApiKey: boolean;
	baseUrlHost: string;
	models: Array<{ name: string; id: string; role: string; price: string }>;
};

type WorkEntry = "scope" | "references" | "persons" | "events" | "proposals" | "outline" | "chapters";

export type WorkSummary = ProjectSummary & { entry: WorkEntry; updatedAtLabel: string };

const corpusIcons = { histories: LibraryBig, chronicle: Archive };

const entryLabel: Record<WorkEntry, string> = {
	scope: "待定历史范围",
	references: "待固定参考资料",
	persons: "待选择人物",
	events: "待采用事件",
	proposals: "待定剧情提案",
	outline: "待确认章纲",
	chapters: "章节创作中",
};

/** 平台概览：作品入口、史料目录与模型配置入口；不归属任何作品。 */
export function OverviewHome({
	corpus,
	models,
	works,
}: {
	corpus: CorpusRow[];
	models: ModelInfo;
	works: WorkSummary[];
}) {
	const router = useRouter();
	const [createOpen, setCreateOpen] = useState(false);
	const [list, setList] = useState<WorkSummary[]>(works);
	const tokenPlan = models.billingMode === "token-plan";

	// 服务端已提供首屏列表与进度；此处在客户端校验最新列表，进度标记保持服务端口径。
	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/projects", { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const result = (await response.json()) as { projects?: ProjectSummary[]; error?: string };
				if (!response.ok) throw new Error(result.error ?? "无法读取本地作品。");
				return result.projects ?? [];
			})
			.then((projects) => {
				// 挂载后的状态更新发生在 hydration 之后，此处可安全使用本地时区格式化。
				setList((current) =>
					projects.map((project) => {
						const known = current.find((item) => item.id === project.id);
						return {
							...project,
							entry: known?.entry ?? ("scope" as WorkEntry),
							updatedAtLabel:
								known?.updatedAtLabel ?? new Date(project.updatedAt).toLocaleString("zh-CN"),
						};
					}),
				);
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, []);

	function onCreated(project: ProjectSummary) {
		setList((current) => [
			{
				...project,
				entry: "scope" as WorkEntry,
				updatedAtLabel: new Date(project.updatedAt).toLocaleString("zh-CN"),
			},
			...current,
		]);
		router.push(`/projects/${project.id}`);
	}

	return (
		<div className="h-full min-h-0 overflow-y-auto overscroll-contain">
			<div className="mx-auto flex w-full max-w-[72rem] flex-col gap-8 px-6 py-8">
				<section className="flex items-start justify-between gap-6">
					<div className="flex flex-col gap-3">
						<p className="flex items-center gap-3 text-[11px] tracking-[0.2em] text-accent-foreground uppercase">
							创作工作区
							<span className="h-px w-14 bg-accent-foreground/40" />
						</p>
						<h1 className="font-serif text-[30px] leading-tight text-primary">让史料，长成故事。</h1>
						<p className="max-w-[46rem] font-serif text-[14px] leading-[1.9] text-muted-foreground">
							先选定历史的时间与土地，再让人物相遇。每一处史实有出处，每一处虚构有边界。
						</p>
					</div>
					<div
						aria-hidden="true"
						className="hidden shrink-0 flex-col items-center gap-0.5 rounded-full border border-border/70 px-5 py-4 text-center size-[7.5rem] justify-center sm:flex"
					>
						<span className="text-[9px] tracking-[0.24em] text-muted-foreground">HISTORIA</span>
						<span className="font-serif text-[26px] leading-none text-primary">史</span>
						<span className="text-[9px] text-muted-foreground">原文 · 人物 · 故事</span>
					</div>
				</section>

				<Separator />

				<section className="flex flex-col gap-3">
					<header className="flex items-center justify-between gap-3">
						<h2 className="font-serif text-[16px] text-foreground">我的作品</h2>
						<Button size="sm" onClick={() => setCreateOpen(true)}>
							<Plus size={15} /> 创建作品
						</Button>
					</header>
					{list.length === 0 ? (
						<p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
							还没有作品。创建一部，从设定年代与地域开始。
						</p>
					) : (
						<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
							{list.map((work) => (
								<li key={work.id}>
									<Link
										href={`/projects/${work.id}`}
										className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60"
									>
										<span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted font-serif text-[13px] text-muted-foreground">
											稿
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<strong className="truncate font-serif text-[13px] font-normal text-foreground">{work.name}</strong>
											<small className="truncate text-[11px] text-muted-foreground">
												第 {work.version} 版 · 更新于 {work.updatedAtLabel}
											</small>
										</span>
										<Badge variant={work.entry === "chapters" ? "success" : "outline"}>
											{entryLabel[work.entry]}
										</Badge>
									</Link>
								</li>
							))}
						</ul>
					)}
				</section>

				<div className="grid gap-6 lg:grid-cols-2">
					<section className="flex flex-col gap-3">
						<header className="flex items-center justify-between gap-3">
							<h2 className="font-serif text-[16px] text-foreground">默认史料目录</h2>
							<Badge variant="outline">25 部</Badge>
						</header>
						<p className="text-[12px] leading-relaxed text-muted-foreground">
							原文采集进度与事实核定分开显示；完成采集不等于已核定史实。
						</p>
						<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
							{corpus.map((row) => {
								const Icon = corpusIcons[row.icon];
								return (
									<li key={row.title} className="flex items-center gap-3 px-3 py-2.5">
										<span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
											<Icon size={16} strokeWidth={1.7} />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<strong className="truncate font-serif text-[13px] font-normal text-foreground">{row.title}</strong>
											<small className="truncate text-[11px] text-muted-foreground">{row.detail}</small>
										</span>
										<Badge variant={row.complete ? "success" : "warning"}>{row.label}</Badge>
									</li>
								);
							})}
						</ul>
						<p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
							<Database size={13} className="mt-0.5 shrink-0" />
							包含《史记》与《资治通鉴》；状态来自本地逐书采集报告。
						</p>
					</section>

					<section className="flex flex-col gap-3">
						<header className="flex items-center justify-between gap-3">
							<h2 className="font-serif text-[16px] text-foreground">
								{tokenPlan ? "百炼 Token Plan" : "百炼按量模型"}
							</h2>
							<Sparkles size={16} className="text-accent-foreground" />
						</header>
						<p className="text-[12px] leading-relaxed text-muted-foreground">
							{tokenPlan ? "服务端调用 · 消耗 Token Plan 套餐额度" : "服务端调用 · 按输入与输出 Token 计费"}
						</p>
						<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
							{models.models.map((model) => (
								<li key={model.id} className="flex items-baseline gap-3 px-3 py-2.5">
									<span className="flex min-w-0 flex-1 flex-col">
										<strong className="truncate font-serif text-[13px] font-normal text-foreground">{model.name}</strong>
										<small className="truncate text-[11px] text-muted-foreground">
											{model.role} · <code className="font-mono">{model.id}</code>
										</small>
									</span>
									<span className="flex shrink-0 flex-col items-end">
										<strong className="text-[12px] font-normal text-foreground">
											{tokenPlan ? "套餐内用量" : model.price}
										</strong>
										<small className="text-[10px] text-muted-foreground">
											{tokenPlan ? "Credits 以控制台为准" : "输入 / 输出 · 元/百万 Token"}
										</small>
									</span>
								</li>
							))}
						</ul>
						<Link
							href="/models"
							className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors hover:bg-muted/60 ${
								models.hasApiKey
									? "border-success/30 bg-success/8 text-success"
									: "border-destructive/30 bg-destructive/8 text-destructive"
							}`}
						>
							<ShieldCheck size={15} className="mt-0.5 shrink-0" />
							<span className="flex flex-col">
								<strong className="text-[12px] font-medium">
									{models.hasApiKey ? "API Key 已配置" : "等待配置 DASHSCOPE_API_KEY"}
								</strong>
								<small className="text-[11px] opacity-80">
									{models.hasApiKey ? `仅由本地服务端读取 · ${models.baseUrlHost}` : "未配置时不发送任何外部请求"}
								</small>
							</span>
						</Link>
					</section>
				</div>

				<footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[11px] text-muted-foreground">
					<span>史稿 · 本地创作，证据先行</span>
					<span>{tokenPlan ? "Token Plan 套餐用量" : "价格快照 2026.10.27"} · 以百炼控制台为准</span>
				</footer>
			</div>

			<CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
		</div>
	);
}
