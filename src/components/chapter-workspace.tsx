"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, Download, LoaderCircle, PencilLine, Plus, RotateCcw, Save, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useStory, type Chapter, type StoryStateEntry } from "@/components/story-provider";
import { cn } from "@/lib/utils";

const MAX_CHAPTERS = 50;
const READING_SIZES = { cozy: "15px", book: "17px", large: "19px" } as const;
type ReadingSize = keyof typeof READING_SIZES;

const sizeLabel: Record<ReadingSize, string> = { cozy: "小", book: "中", large: "大" };

const statusLabel: Record<string, { text: string; variant: "success" | "warning" | "secondary" }> = {
	accepted: { text: "已接受", variant: "success" },
	draft: { text: "待人工审阅", variant: "warning" },
	generating: { text: "生成中", variant: "secondary" },
	"failed-or-unknown": { text: "状态未知", variant: "warning" },
};

function GenerationProgress({
	characters,
	updatedAt,
	onOpenReading,
}: {
	characters: number;
	updatedAt: string;
	onOpenReading?: () => void;
}) {
	return (
		<div role="status" className="flex flex-col gap-1.5" aria-label="章节生成进度">
			<div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
				<div className="animate-generate-slide h-full w-1/3 rounded-full bg-primary/70" />
			</div>
			<p className="text-[11px] text-muted-foreground">
				正在生成 · 已保存 {characters.toLocaleString()} 字符 · 最近保存{" "}
				{new Date(updatedAt).toLocaleTimeString("zh-CN")}
				{onOpenReading && (
					<>
						{" · "}
						<button type="button" className="underline underline-offset-2" onClick={onOpenReading}>
							到正文页逐字预览
						</button>
					</>
				)}
			</p>
		</div>
	);
}

function StreamingBody({ text, fontSize }: { text: string; fontSize: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const shownRef = useRef(0);
	const [shown, setShown] = useState(() => Math.max(0, text.length - 400));

	useEffect(() => {
		if (shownRef.current === 0) shownRef.current = Math.max(0, text.length - 400);
		const timer = setInterval(() => {
			const target = text.length;
			const current = shownRef.current;
			if (current >= target) return;
			const step = Math.max(2, Math.ceil((target - current) / 24));
			shownRef.current = Math.min(target, current + step);
			setShown(shownRef.current);
			const container = containerRef.current;
			if (container) container.scrollTop = container.scrollHeight;
		}, 40);
		return () => clearInterval(timer);
	}, [text.length]);

	return (
		<div
			ref={containerRef}
			className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap font-serif text-foreground"
			style={{ fontSize, lineHeight: 1.9 }}
			aria-label="生成中的正文逐字预览"
			aria-live="polite"
		>
			{text.slice(0, shown)}
			{shown < text.length && <span className="animate-pulse text-primary" aria-hidden>▌</span>}
		</div>
	);
}

export function ChapterWorkspace({
	projectId,
	initialChapterId,
	initialView,
}: {
	projectId: string;
	/** 直达正文时定位的章节 ID；须已在服务端校验归属。 */
	initialChapterId?: string;
	initialView?: "outline" | "reading";
}) {
	const story = useStory();
	const { data, plan, status } = story;
	const [view, setView] = useState<"outline" | "reading">(initialView ?? "outline");
	const [readingSize, setReadingSize] = useState<ReadingSize>("book");
	const [retryConfirmed, setRetryConfirmed] = useState<Record<string, boolean>>({});
	const [activeId, setActiveId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [tocOpen, setTocOpen] = useState(true);
	const [planning, setPlanning] = useState(false);
	const [planTransfer, setPlanTransfer] = useState(false);
	const [planError, setPlanError] = useState("");

	useEffect(() => {
		setActiveId((current) => {
			if (current && plan?.chapters.some((chapter) => chapter.id === current)) return current;
			if (initialChapterId && plan?.chapters.some((chapter) => chapter.id === initialChapterId)) {
				return initialChapterId;
			}
			return plan?.chapters[0]?.id ?? null;
		});
	}, [plan, initialChapterId]);

	if (status === "loading") {
		return (
			<div className="flex flex-col gap-3" role="status" aria-label="正在读取章节稿">
				<Skeleton className="h-10" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (status === "failed") {
		return (
			<Alert variant="destructive">
				<AlertDescription>{story.error}</AlertDescription>
			</Alert>
		);
	}

	if (!plan || !data) {
		return (
			<p className="text-[13px] leading-relaxed text-muted-foreground">
				这部作品还没有故事方案。请先在左侧完成「生成策略」步骤并人工确认方案。
			</p>
		);
	}

	const drafts = new Map(data.chapters.map((chapter) => [chapter.chapterId, chapter]));
	const activeChapter = plan.chapters.find((chapter) => chapter.id === activeId) ?? null;

	function patchChapter(chapterId: string, patch: Partial<Chapter>) {
		story.updatePlan((current) => ({
			...current,
			chapters: current.chapters.map((item) => (item.id === chapterId ? { ...item, ...patch } : item)),
		}));
	}

	function moveChapter(index: number, delta: number) {
		story.updatePlan((current) => {
			const chapters = [...current.chapters];
			const target = index + delta;
			if (target < 0 || target >= chapters.length) return current;
			[chapters[index], chapters[target]] = [chapters[target], chapters[index]];
			return { ...current, chapters };
		});
	}

	function addChapter() {
		story.updatePlan((current) => {
			if (current.chapters.length >= MAX_CHAPTERS) return current;
			const id = `chapter-${crypto.randomUUID().slice(0, 8)}`;
			return {
				...current,
				chapters: [
					...current.chapters,
					{
						id,
						title: "新章节",
						pov: "待定",
						time: "",
						synopsis: "",
						plot: [""],
						historyEvidence: [],
						fiction: ["新增人物、对白及情节均为虚构。"],
						endingHook: "",
					},
				],
				scope: { ...current.scope, plannedChapters: current.chapters.length + 1 },
			};
		});
	}

	function removeChapter(chapterId: string) {
		story.updatePlan((current) => ({
			...current,
			chapters: current.chapters.filter((item) => item.id !== chapterId),
			scope: { ...current.scope, plannedChapters: current.chapters.length - 1 },
		}));
	}

	// 基于已保存规划的最后一章（章末钩子、情节节点、史料编号）调用模型生成下一章设定；
	// 结果先进入本地待保存状态，由人工审阅后再保存章节目录。
	async function generateNextChapterPlan() {
		if (!projectId || !plan || planning) return;
		if (plan.chapters.length >= MAX_CHAPTERS) return;
		if (story.dirty) {
			setPlanError("有未保存的目录修改；请先保存章节目录，再基于已保存的上一章生成。");
			return;
		}
		setPlanning(true);
		setPlanError("");
		try {
			const response = await fetch(`/api/projects/${projectId}/chapter-plan`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "generate", allowExternalTransfer: true }),
			});
			const result = (await response.json()) as {
				chapter?: Omit<Chapter, "id">;
				issues?: string[];
				generatedAt?: string;
				usage?: { promptTokens: number | null; completionTokens: number | null } | null;
				error?: string;
			};
			if (!response.ok) throw new Error(result.error ?? "生成下一章设定失败。");
			if (!result.chapter) throw new Error("模型未返回章节设定。");
			const id = `chapter-${crypto.randomUUID().slice(0, 8)}`;
			const generated = result.chapter;
			story.updatePlan((current) => ({
				...current,
				chapters: [...current.chapters, { ...generated, id }],
				scope: { ...current.scope, plannedChapters: current.chapters.length + 1 },
			}));
			setActiveId(id);
			setExpanded((current) => ({ ...current, [id]: true }));
			const generatedAt = result.generatedAt ? new Date(result.generatedAt).toLocaleString("zh-CN") : "";
			const usageText = result.usage
				? ` · 输入 ${result.usage.promptTokens ?? "?"} / 输出 ${result.usage.completionTokens ?? "?"} Token`
				: "";
			story.setMessage(
				`下一章设定已生成${generatedAt ? `（生成时间 ${generatedAt}）` : ""}${usageText}；请审阅内容后保存章节目录。`,
			);
			if (result.issues?.length) setPlanError(`模型结果提示：${result.issues.join(" ")}`);
		} catch (cause) {
			setPlanError(cause instanceof Error ? cause.message : "生成下一章设定失败。");
		} finally {
			setPlanning(false);
		}
	}

	function exportManuscript() {
		if (!plan) return;
		const lines: string[] = [`# ${plan.title || "未命名作品"}`, "", plan.synopsis, ""];
		let exported = 0;
		plan.chapters.forEach((chapter, index) => {
			const draft = drafts.get(chapter.id);
			if (!draft?.content) return;
			exported += 1;
			lines.push(`## 第${index + 1}章 ${chapter.title}`, "", draft.content, "");
		});
		if (!exported) {
			story.setMessage("还没有可导出的章节正文；先生成并接受章节后再导出。");
			return;
		}
		const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${plan.title || "未命名作品"}-${exported}章.md`;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
		story.setMessage(`已导出 ${exported} 章正文。`);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Tabs value={view} onValueChange={(value) => setView(value as "outline" | "reading")}>
					<TabsList>
						<TabsTrigger value="outline">目录</TabsTrigger>
						<TabsTrigger value="reading">正文</TabsTrigger>
					</TabsList>
				</Tabs>
				{view === "outline" && plan.chapters.length > 1 && (
					<div className="flex items-center gap-1" role="group" aria-label="章节折叠">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="全部折叠"
							onClick={() => setExpanded(Object.fromEntries(plan.chapters.map((chapter) => [chapter.id, false])))}
						>
							<ChevronUp />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="全部展开"
							onClick={() => setExpanded(Object.fromEntries(plan.chapters.map((chapter) => [chapter.id, true])))}
						>
							<ChevronDown />
						</Button>
					</div>
				)}
				<div className="flex items-center gap-1.5">
					{view === "reading" && (
						<div className="flex items-center gap-1" role="group" aria-label="正文字号">
							{(Object.keys(READING_SIZES) as ReadingSize[]).map((size) => (
								<button
									type="button"
									key={size}
									onClick={() => setReadingSize(size)}
									aria-pressed={readingSize === size}
									className={cn(
										"rounded-sm border px-2 py-1 text-[11px] transition-colors",
										readingSize === size
											? "border-primary/30 bg-primary/10 text-primary"
											: "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{sizeLabel[size]}
								</button>
							))}
						</div>
					)}
					<Button variant="outline" size="sm" onClick={exportManuscript}>
						<Download size={14} /> 导出全文
					</Button>
				</div>
			</div>

			{view === "reading" && activeChapter && (
				<Collapsible open={tocOpen} onOpenChange={setTocOpen} className="flex flex-col gap-1.5">
					<CollapsibleTrigger asChild>
						<button
							type="button"
							aria-expanded={tocOpen}
							className="flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronDown className={cn("size-3.5 transition-transform", tocOpen && "rotate-180")} aria-hidden />
							正文中目录 · 共 {plan.chapters.length} 章 · 当前第 {plan.chapters.findIndex((item) => item.id === activeId) + 1} 章
							<span className="max-w-[12rem] truncate font-medium text-foreground">{activeChapter.title || "未命名章节"}</span>
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="flex flex-wrap items-center gap-1.5">
							{plan.chapters.map((chapter, index) => {
								const draft = drafts.get(chapter.id);
								return (
									<button
										type="button"
										key={chapter.id}
										onClick={() => setActiveId(chapter.id)}
										aria-current={activeId === chapter.id}
										className={cn(
											"flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[12px] transition-colors",
											activeId === chapter.id
												? "border-primary/30 bg-primary/10 text-primary"
												: "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
										)}
									>
										<span className="font-mono text-[10px]">{String(index + 1).padStart(2, "0")}</span>
										<span className="max-w-[9rem] truncate">{chapter.title || "未命名章节"}</span>
										{draft?.status === "accepted" && <span className="size-1.5 rounded-full bg-success" />}
									</button>
								);
							})}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}

			{view === "outline" && story.evidenceIssues.length > 0 && (
				<Alert variant="destructive" className="mb-1">
					<AlertDescription>
						当前方案仍依赖待复核或已失效的证据，生成已被阻止。请先在事件步骤核对或更换依据，再重新确认方案：
						{story.evidenceIssues.join("；")}
					</AlertDescription>
				</Alert>
			)}

			{story.data?.proposalIssue && (
				<Alert variant="destructive" className="mb-1">
					<AlertDescription>{story.data.proposalIssue}</AlertDescription>
				</Alert>
			)}

			{story.specNotice && (
				<Alert className="mb-1">
					<AlertDescription>{story.specNotice}</AlertDescription>
				</Alert>
			)}

			{view === "outline" &&
				plan.chapters.map((chapter, index) => {
					const draft = drafts.get(chapter.id);
					const previousAccepted = plan.chapters
						.slice(0, index)
						.every((previous) => drafts.get(previous.id)?.status === "accepted");
					const canGenerate = story.approvalMatches && !story.dirty && !story.hasRunningChapter && previousAccepted && story.evidenceIssues.length === 0 && !story.data?.proposalIssue;
					const estimate = data.estimate?.chapters.find((item) => item.chapterId === chapter.id);
					const mark = draft ? statusLabel[draft.status] : null;
					const open = expanded[chapter.id] ?? (chapter.id === activeId || draft?.status === "generating");

					return (
						<Collapsible
							className={cn(
								"flex flex-col gap-3 rounded-md border border-border bg-card p-4",
								activeId === chapter.id && "ring-1 ring-primary/20",
							)}
							key={chapter.id}
							open={open}
							onOpenChange={(value) => setExpanded((current) => ({ ...current, [chapter.id]: value }))}
						>
							<header className="flex flex-wrap items-center gap-2">
								<CollapsibleTrigger asChild>
									<Button variant="ghost" size="icon-xs" aria-label={open ? `折叠第 ${index + 1} 章` : `展开第 ${index + 1} 章`}>
										<ChevronDown className={cn("transition-transform", open && "rotate-180")} />
									</Button>
								</CollapsibleTrigger>
								<span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground">
									{String(index + 1).padStart(2, "0")}
								</span>
								<Input
									aria-label={`第 ${index + 1} 章标题`}
									className="h-8 min-w-[10rem] flex-1 font-serif text-[15px]"
									maxLength={160}
									value={chapter.title}
									onChange={(event) => patchChapter(chapter.id, { title: event.target.value })}
								/>
								<Badge variant={mark?.variant ?? "outline"}>{mark?.text ?? "待生成"}</Badge>
								{draft?.needsReview === 1 && <Badge variant="warning">前文变更待复核</Badge>}
								<Button variant="ghost" size="icon-xs" aria-label="上移章节" disabled={index === 0 || story.busy} onClick={() => moveChapter(index, -1)}>
									<ArrowUp />
								</Button>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="下移章节"
									disabled={index === plan.chapters.length - 1 || story.busy}
									onClick={() => moveChapter(index, 1)}
								>
									<ArrowDown />
								</Button>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="删除章节"
									disabled={plan.chapters.length <= 1 || story.busy}
									onClick={() => removeChapter(chapter.id)}
								>
									<Trash2 />
								</Button>
							</header>

							<CollapsibleContent className="flex flex-col gap-3">
								<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={`${chapter.id}-pov`}>视点人物</Label>
									<Input
										id={`${chapter.id}-pov`}
										className="h-8"
										maxLength={80}
										value={chapter.pov}
										onChange={(event) => patchChapter(chapter.id, { pov: event.target.value })}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={`${chapter.id}-time`}>时间设定</Label>
									<Input
										id={`${chapter.id}-time`}
										className="h-8"
										maxLength={160}
										placeholder="如：904 年秋，汴州"
										value={chapter.time ?? ""}
										onChange={(event) => patchChapter(chapter.id, { time: event.target.value })}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={`${chapter.id}-evidence`}>史料编号</Label>
									<Input
										id={`${chapter.id}-evidence`}
										className="h-8"
										value={chapter.historyEvidence.join("、")}
										onChange={(event) =>
											patchChapter(chapter.id, {
												historyEvidence: event.target.value
													.split(/[、,，\s]+/)
													.map((item) => item.trim())
													.filter(Boolean),
											})
										}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${chapter.id}-synopsis`}>本章梗概</Label>
								<Textarea
									id={`${chapter.id}-synopsis`}
									rows={2}
									maxLength={4000}
									value={chapter.synopsis}
									onChange={(event) => patchChapter(chapter.id, { synopsis: event.target.value })}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${chapter.id}-plot`}>情节节点（每行一项）</Label>
								<Textarea
									id={`${chapter.id}-plot`}
									rows={4}
									maxLength={10000}
									value={chapter.plot.join("\n")}
									onChange={(event) => patchChapter(chapter.id, { plot: event.target.value.split("\n").slice(0, 20) })}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${chapter.id}-hook`}>章末钩子</Label>
								<Textarea
									id={`${chapter.id}-hook`}
									rows={2}
									maxLength={2000}
									value={chapter.endingHook}
									onChange={(event) => patchChapter(chapter.id, { endingHook: event.target.value })}
								/>
							</div>

							<p className="text-[11px] leading-relaxed text-muted-foreground">
								{story.tokenPlan
									? `单章工作量估算 ${(estimate?.tokenAllowance ?? 0).toLocaleString()} Token`
									: `单章费用上限估算 ¥${(estimate?.ceilingCny ?? 0).toFixed(3)}`}
							</p>

							{draft?.status === "generating" && (
								<GenerationProgress
									characters={draft.content.length}
									updatedAt={draft.updatedAt}
									onOpenReading={() => {
										setActiveId(chapter.id);
										setView("reading");
									}}
								/>
							)}

							{draft?.status === "failed-or-unknown" && (
								<div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
									<p className="text-[11px] leading-relaxed text-foreground">
										第 {draft.attemptCount} 次尝试已中断或未完整返回，保留 {draft.content.length.toLocaleString()} 字符。
										{draft.errorMessage && draft.errorMessage !== "HTTP undefined"
											? draft.errorMessage
											: "请先核对百炼请求记录与用量。"}{" "}
										{draft.content ? "继续时不会清空正文，会从已保存末尾续写。" : "旧请求没有保存正文，确认后将重新请求本章。"}
										{!story.tokenPlan && `此前预留费用上限 ¥${draft.reservedCostCny.toFixed(3)}。`}
									</p>
									<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
										<Checkbox
											className="mt-0.5"
											checked={retryConfirmed[chapter.id] ?? false}
											onCheckedChange={(value) =>
												setRetryConfirmed((current) => ({ ...current, [chapter.id]: value === true }))
											}
										/>
										<span>我已核对历史请求与用量，确认继续生成（另一次请求）</span>
									</label>
									<Button
										variant="outline"
										size="sm"
										className="self-start"
										disabled={
											story.busy ||
											story.busyChapter !== null ||
											story.hasRunningChapter ||
											story.dirty ||
											!story.approvalMatches ||
											!(retryConfirmed[chapter.id] ?? false)
										}
										onClick={() =>
											void story.runChapter(chapter.id, {
												retry: true,
												retryConfirmed: retryConfirmed[chapter.id] === true,
											})
										}
									>
										<RotateCcw size={15} /> {draft.content ? "从已保存处继续生成" : "重新请求本章"}
									</Button>
								</div>
							)}

							{!draft && (
								<Button
									size="sm"
									className="self-start"
									disabled={!canGenerate || story.busyChapter !== null}
									onClick={() => void story.runChapter(chapter.id)}
								>
									<Sparkles size={15} /> {story.busyChapter === chapter.id ? "生成中…" : "生成本章"}
								</Button>
							)}
							</CollapsibleContent>
						</Collapsible>
					);
				})}

			{view === "outline" && (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="outline" size="sm" disabled={story.busy || plan.chapters.length >= MAX_CHAPTERS} onClick={addChapter}>
							<Plus size={15} /> 添加章节
						</Button>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={planTransfer} onCheckedChange={(value) => setPlanTransfer(value === true)} />
							<span>我确认将已核定史料片段发送到百炼，基于上一章的钩子、情节与史料生成下一章设定</span>
						</label>
						<Button
							variant="outline"
							size="sm"
							disabled={planning || story.busy || plan.chapters.length >= MAX_CHAPTERS || !planTransfer}
							onClick={() => void generateNextChapterPlan()}
						>
							{planning ? <LoaderCircle size={15} className="animate-spin" /> : <Wand2 size={15} />}
							{planning ? "生成中…" : "AI 续设下一章"}
						</Button>
						{story.dirty && (
							<Button size="sm" disabled={story.busy || story.hasRunningChapter} onClick={() => void story.savePlan()}>
								<Save size={15} /> 保存章节目录
							</Button>
						)}
						{story.dirty && (
							<span className="text-[11px] text-warning">有未保存的目录修改；保存后旧确认失效，需回左侧重新确认。</span>
						)}
					</div>
					{planError && (
						<Alert variant="destructive">
							<AlertDescription>{planError}</AlertDescription>
						</Alert>
					)}
				</div>
			)}

			{view === "reading" && activeChapter && <ReadingPane chapter={activeChapter} size={readingSize} />}
			{view === "reading" && !activeChapter && (
				<p className="text-[13px] leading-relaxed text-muted-foreground">目录里还没有章节；切回「目录」添加或生成大纲。</p>
			)}

			{story.message && <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{story.message}</p>}
			{story.error && (
				<Alert variant="destructive">
					<AlertDescription>{story.error}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}

const stateBuckets = [
	{ key: "locations", label: "人物所在" },
	{ key: "relations", label: "关系口径" },
	{ key: "knowledge", label: "已知与未知" },
	{ key: "threads", label: "未收束伏笔" },
] as const;

function StateEntry({ entry }: { entry: StoryStateEntry }) {
	return (
		<li className="flex flex-col gap-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
			<div className="flex flex-wrap items-center gap-2">
				<strong className="text-[12px] text-foreground">{entry.chapterTitle || "未命名章节"}</strong>
				<Badge variant={entry.status === "confirmed" ? "success" : "warning"}>
					{entry.status === "confirmed" ? "已确认" : "已失效"}
				</Badge>
				<span className="font-mono text-[10px] text-muted-foreground">
					输入版本 {entry.draftInputHash ? `${entry.draftInputHash.slice(0, 12)}…` : "未记录"} · 写作规格 v{entry.specVersion ?? "?"} ·{" "}
					{entry.confirmedAt.slice(0, 19).replace("T", " ")}
				</span>
			</div>
			{entry.staleReason && <p className="text-[11px] leading-relaxed text-warning">{entry.staleReason}</p>}
			{entry.summary && <p className="text-[11px] leading-relaxed text-muted-foreground">{entry.summary}</p>}
			{stateBuckets.map((bucket) => {
				const items = entry[bucket.key];
				if (!items.length) return null;
				return (
					<p className="text-[11px] leading-relaxed text-muted-foreground" key={bucket.key}>
						<span className="text-foreground">{bucket.label}：</span>
						{items.join("；")}
					</p>
				);
			})}
		</li>
	);
}

// REQ-028/029：请求前文时说明实际使用了哪些版本；已失效的状态原样列出但不带入新请求。
function StoryStateCard({ chapterId, chapterNumber }: { chapterId: string; chapterNumber: number }) {
	const story = useStory();
	const states = story.data?.storyStates ?? [];
	const order = story.plan?.chapters.map((item) => item.id) ?? [];
	const self = order.indexOf(chapterId);
	const own = states.find((item) => item.chapterId === chapterId);
	const carried = states.filter((item) => {
		const at = order.indexOf(item.chapterId);
		return at >= 0 && self >= 0 && at < self;
	});
	if (!own && !carried.length) return null;
	const confirmedCarried = carried.filter((item) => item.status === "confirmed");
	return (
		<section className="flex flex-col gap-2 rounded-md border border-border bg-card px-4 py-3" aria-label="已确认故事状态">
			<div className="flex flex-wrap items-center gap-2">
				<h4 className="text-[12px] font-medium text-foreground">已确认故事状态</h4>
				<span className="text-[11px] text-muted-foreground">第 {chapterNumber} 章</span>
			</div>
			<p className="text-[11px] leading-relaxed text-muted-foreground">
				生成下一章时只带入下列「已确认」条目及其版本；前文改写后其状态转为已失效，保留原文供对照，不会静默混入新请求。
			</p>
			{carried.length > 0 && (
				<details className="flex flex-col gap-1">
					<summary className="cursor-pointer text-[11px] text-muted-foreground">
						带入本章请求的前文状态 · {confirmedCarried.length} 条已确认
						{carried.length - confirmedCarried.length > 0 ? ` · ${carried.length - confirmedCarried.length} 条已失效` : ""}
					</summary>
					<ul className="mt-1 flex flex-col gap-2">
						{carried.map((item) => (
							<StateEntry entry={item} key={item.chapterId} />
						))}
					</ul>
				</details>
			)}
			{own ? (
				<ul className="flex flex-col gap-2">
					<StateEntry entry={own} />
				</ul>
			) : (
				<p className="text-[11px] leading-relaxed text-muted-foreground">本章尚未接受，还没有固化故事状态。</p>
			)}
		</section>
	);
}

function ReadingPane({
	chapter,
	size,
}: {
	chapter: Chapter;
	size: ReadingSize;
}) {
	const story = useStory();
	const { data } = story;
	const draft = data?.chapters.find((item) => item.chapterId === chapter.id) ?? null;
	const index = data ? story.plan?.chapters.findIndex((item) => item.id === chapter.id) ?? 0 : 0;
	const confirmed = data?.storyStates?.find((item) => item.chapterId === chapter.id) ?? null;
	const [revising, setRevising] = useState(false);

	// 改写入口只在已接受时打开；保存后本章已是草稿，交回 DraftEditor 的正常流程。
	useEffect(() => {
		setRevising(false);
	}, [chapter.id, draft?.status]);

	if (!draft?.content) {
		return (
			<article className="mx-auto flex w-full max-w-[var(--reading-measure)] flex-col gap-4 rounded-md border border-border bg-card px-8 py-10 text-center">
				<h3 className="font-serif text-[18px] text-foreground">{chapter.title || "未命名章节"}</h3>
				<p className="text-[12px] leading-relaxed text-muted-foreground">
					本章还没有正文。切回「目录」生成本章；生成中的正文会在这里逐步出现，刷新或关闭页面都不会丢失。
				</p>
			</article>
		);
	}

	return (
		<article className="mx-auto flex w-full max-w-[var(--reading-measure)] flex-col gap-4">
			<header className="flex flex-col gap-2 border-b border-border pb-4 text-center">
				<p className="font-mono text-[11px] tracking-[0.24em] text-muted-foreground">
					CHAPTER {String(index + 1).padStart(2, "0")}
				</p>
				<h3 className="font-serif text-[20px] leading-tight text-foreground">{chapter.title || "未命名章节"}</h3>
				<p className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
					<span>视点 {chapter.pov || "待定"}</span>
					{draft.status === "generating" && <Badge variant="secondary">生成中</Badge>}
					{draft.status === "accepted" && <Badge variant="success">已接受</Badge>}
					{draft.status === "draft" && <Badge variant="warning">待人工审阅</Badge>}
					{draft.status === "failed-or-unknown" && <Badge variant="warning">状态未知</Badge>}
					{draft.autoContinuations > 0 && (
						<Badge variant="secondary">自动续写 {draft.autoContinuations}/{data?.autoContinuationLimit ?? 0} 次</Badge>
					)}
				</p>
			</header>

			{draft.needsReview === 1 && (
				<Alert>
					<AlertDescription>
						{draft.reviewReason ?? "前文已变更，本章需要复核。"}
						{confirmed?.bodyTail ? ` 已接受版本的结尾仍保留：……${confirmed.bodyTail.slice(-120)}` : ""}
					</AlertDescription>
				</Alert>
			)}

			<StoryStateCard chapterId={chapter.id} chapterNumber={index + 1} />

			{draft.status === "generating" && (
				<GenerationProgress characters={draft.content.length} updatedAt={draft.updatedAt} />
			)}

			{draft.status === "draft" || revising ? (
				<DraftEditor chapterId={chapter.id} size={size} />
			) : draft.status === "generating" ? (
				<StreamingBody text={draft.content} fontSize={READING_SIZES[size]} />
			) : (
				<div className="flex flex-col gap-3">
					{draft.status === "accepted" && (
						<div className="flex items-center gap-2">
							<Button variant="outline" size="sm" disabled={story.busy || story.hasRunningChapter} onClick={() => setRevising(true)}>
								<PencilLine size={15} /> 改写已接受正文
							</Button>
							<p className="text-[11px] leading-relaxed text-muted-foreground">改写后本章退回待审阅，其后章节标为待复核；已写文本不会被自动重写或删除。</p>
						</div>
					)}
					<div
						className="whitespace-pre-wrap font-serif text-foreground"
						style={{ fontSize: READING_SIZES[size], lineHeight: 1.9 }}
						aria-label={`${chapter.title} 正文`}
					>
						{draft.content}
					</div>
				</div>
			)}

			{draft.status === "failed-or-unknown" && (
				<Alert variant="destructive">
					<AlertDescription>
						生成已中断，保留 {draft.content.length.toLocaleString()} 字符；请切回「目录」核对该章的恢复选项。
					</AlertDescription>
				</Alert>
			)}

			{draft.metaJson && <MetaPanel metaJson={draft.metaJson} />}

			<p className="text-[11px] leading-relaxed text-muted-foreground">
				Token：{draft.promptTokens ?? "—"} 输入 / {draft.completionTokens ?? "—"} 输出 ·{" "}
				{draft.actualCostCny === null
					? "不折算人民币；用量以控制台为准"
					: `标价估算 ¥${draft.actualCostCny.toFixed(3)}`}
				{draft.errorMessage ? ` · ${draft.errorMessage}` : ""}
			</p>
		</article>
	);
}

const META_SECTIONS = [
	{ key: "factBasis", label: "事实依据" },
	{ key: "fictionNotes", label: "虚构说明" },
	{ key: "openQuestions", label: "待核查问题" },
	{ key: "specNotes", label: "写作规格应用说明" },
] as const;

function MetaPanel({ metaJson }: { metaJson: string }) {
	let meta: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(metaJson);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
	} catch {
		meta = null;
	}
	if (!meta) return null;
	const notes = typeof meta.notes === "string" ? meta.notes.trim() : "";
	const sections = META_SECTIONS.map((section) => ({
		label: section.label,
		items: Array.isArray(meta?.[section.key])
			? (meta[section.key] as unknown[]).map((item) => String(item)).filter(Boolean)
			: [],
	})).filter((section) => section.items.length > 0);
	if (!sections.length && !notes) return null;
	return (
		<details className="rounded-md border border-border bg-muted/40 px-4 py-2 text-[12px]">
			<summary className="cursor-pointer select-none text-muted-foreground">本章元信息（衔接与核查约束，不属于正文）</summary>
			<div className="mt-2 flex flex-col gap-2 leading-relaxed">
				{sections.map((section) => (
					<div key={section.label}>
						<p className="font-medium text-foreground">{section.label}</p>
						<ul className="list-disc pl-5 text-muted-foreground">
							{section.items.map((item, itemIndex) => (
								<li key={itemIndex}>{item}</li>
							))}
						</ul>
					</div>
				))}
				{notes && (
					<div>
						<p className="font-medium text-foreground">其他说明</p>
						<p className="whitespace-pre-wrap text-muted-foreground">{notes}</p>
					</div>
				)}
			</div>
		</details>
	);
}

function DraftEditor({ chapterId, size }: { chapterId: string; size: ReadingSize }) {
	const story = useStory();
	const { data, plan } = story;
	const draft = data?.chapters.find((item) => item.chapterId === chapterId);
	const chapter = plan?.chapters.find((item) => item.id === chapterId);
	const [value, setValue] = useState("");

	useEffect(() => {
		if (draft && draft.status !== "generating") setValue(draft.content);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chapterId, draft?.status]);

	return (
		<div className="flex flex-col gap-3">
			<Textarea
				aria-label={`${chapter?.title ?? "本章"} 草稿`}
				className="min-h-[30rem] whitespace-pre-wrap font-serif text-foreground"
				style={{ fontSize: READING_SIZES[size], lineHeight: 1.9 }}
				maxLength={100000}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			<div className="flex items-center gap-2">
				<Button variant="outline" size="sm" disabled={story.busy} onClick={() => void story.saveChapter(chapterId, value)}>
					<Save size={15} /> 保存修改
				</Button>
				<Button size="sm" disabled={story.busy} onClick={() => void story.acceptChapter(chapterId)}>
					<Check size={15} /> 接受本章
				</Button>
			</div>
		</div>
	);
}
