"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, CircleStop, Download, History, Layers, ListChecks, LoaderCircle, PencilLine, Plus, RefreshCw, RotateCcw, Save, Sparkles, Trash2, Wand2 } from "lucide-react";
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
import { useStory, type Chapter, type ChapterBackup, type ChapterDraft, type StoryStateEntry } from "@/components/story-provider";
import { cn } from "@/lib/utils";
import { MAX_PLAN_CHAPTERS } from "@/lib/plan-limits";

const READING_SIZES = { cozy: "15px", book: "17px", large: "19px" } as const;
type ReadingSize = keyof typeof READING_SIZES;

const sizeLabel: Record<ReadingSize, string> = { cozy: "小", book: "中", large: "大" };

const statusLabel: Record<string, { text: string; variant: "success" | "warning" | "secondary" }> = {
	accepted: { text: "已接受", variant: "success" },
	draft: { text: "待人工审阅", variant: "warning" },
	generating: { text: "生成中", variant: "secondary" },
	"failed-or-unknown": { text: "状态未知", variant: "warning" },
};

// 队列只是将既有的「生成本章 / 接受本章」两步按目录顺序串起来，仍是逐章单独请求。
const queuePhaseLabel: Record<string, string> = {
	waiting: "等待本章落库",
	generating: "生成本章中",
	accepting: "自动接受中",
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
	// 正文视图的章节目录固定在左侧，切章时右侧正文要自己回到顶部，而不是跟着页面停在原处。
	const contentTop = useRef<HTMLDivElement | null>(null);
	const [planning, setPlanning] = useState(false);
	const [planTransfer, setPlanTransfer] = useState(false);
	const [planError, setPlanError] = useState("");
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const [queueConfirmed, setQueueConfirmed] = useState(false);
	// REQ-060：正文重生成会覆盖已有正文（服务端先归档），需要单独一次覆盖确认。
	const [bodyRegenConfirmed, setBodyRegenConfirmed] = useState(false);
	const [bodyRegenAutoAccept, setBodyRegenAutoAccept] = useState(false);
	const [planRegenConfirmed, setPlanRegenConfirmed] = useState(false);
	const [approvalConfirmed, setApprovalConfirmed] = useState(false);

	useEffect(() => {
		setActiveId((current) => {
			if (current && plan?.chapters.some((chapter) => chapter.id === current)) return current;
			if (initialChapterId && plan?.chapters.some((chapter) => chapter.id === initialChapterId)) {
				return initialChapterId;
			}
			return plan?.chapters[0]?.id ?? null;
		});
	}, [plan, initialChapterId]);

	// 切章只重置右栏自身的滚动位置：目录与正文各自滚动，页面滚动量不参与。
	useEffect(() => {
		contentTop.current?.scrollTo({ top: 0 });
	}, [activeId]);

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
	const chapters = plan.chapters;
	const activeChapter = plan.chapters.find((chapter) => chapter.id === activeId) ?? null;

	// 点目录项一律把正文栏滚回顶部，包括重复点选当前章；换章由 effect 兜住上一章/下一章等入口。
	function selectChapter(chapterId: string) {
		setActiveId(chapterId);
		contentTop.current?.scrollTo({ top: 0 });
	}

	// 队列可入队的章节：还没有正文，或已有完整草稿待接受；生成中、已接受与中断章仍走各自的单章操作。
	function queueableReason(chapterId: string): string | null {
		const draft = drafts.get(chapterId);
		if (!draft) return null;
		if (draft.status === "draft") return null;
		if (draft.status === "generating") return "本章正在生成，完成后可入队。";
		if (draft.status === "accepted") return "本章已接受，无需入队。";
		return "本章生成中断或状态未知，请先在目录内核对并继续生成。";
	}

	const orderedQueueable = chapters.filter((chapter) => !queueableReason(chapter.id)).map((chapter) => chapter.id);
	const selectedIds = chapters.filter((chapter) => selected[chapter.id] === true).map((chapter) => chapter.id);
	// 多选框同时服务批量生成与两类重新生成，因此启动队列时按可入队条件过滤，而不是禁止勾选。
	const queueSelection = selectedIds.filter((chapterId) => !queueableReason(chapterId));

	// 服务端顺序门禁要求前序章节都已接受；既未接受又不在队列里的前章会让队列在该章停下。
	function hasUnresolvedPrevious(index: number) {
		return !chapters.slice(0, index).every((previous) => {
			const prior = drafts.get(previous.id);
			return Boolean(prior && prior.status === "accepted" && prior.needsReview !== 1) || selected[previous.id] === true;
		});
	}

	const firstBlockedAt = chapters.findIndex((chapter, index) => selected[chapter.id] === true && hasUnresolvedPrevious(index));
	const queueGate = !story.approvalMatches
		? "本章节目录已改版或计费口径变化，请先在本页重新确认方案。"
		: story.dirty
			? "有未保存的目录修改；请先保存章节目录再启动队列。"
			: story.hasRunningChapter || story.busyChapter !== null
				? "已有章节正在生成，请等待本次任务结束。"
				: story.evidenceIssues.length > 0 || story.data?.proposalIssue
					? "方案仍依赖待复核证据或提案绑定，请先在左侧核对。"
					: firstBlockedAt >= 0
						? `第 ${firstBlockedAt + 1} 章之前还有既未接受、也未入队的章节，队列会在该章停止。`
						: "";
	const canStartQueue = queueSelection.length > 0 && queueConfirmed && !story.queueRunning && !queueGate;

	function queueMark(chapterId: string) {
		const at = story.queue.ids.indexOf(chapterId);
		if (at < 0 || story.queue.phase === "idle") return null;
		if (at < story.queue.index) return { text: "队列已完成", variant: "success" as const };
		if (at > story.queue.index) {
			return story.queue.phase === "done" || story.queue.phase === "stopped" ? null : { text: "排队中", variant: "secondary" as const };
		}
		if (story.queue.phase === "done") return { text: "队列已完成", variant: "success" as const };
		if (story.queue.phase === "stopped") return { text: "队列停在此章", variant: "warning" as const };
		return { text: queuePhaseLabel[story.queue.phase] ?? "队列处理中", variant: "secondary" as const };
	}

	function toggleSelected(chapterId: string) {
		setSelected((current) => ({ ...current, [chapterId]: !current[chapterId] }));
	}

	function selectAllQueueable() {
		setSelected(Object.fromEntries(orderedQueueable.map((chapterId) => [chapterId, true])));
	}

	function clearSelection() {
		setSelected({});
	}

	function selectAll() {
		setSelected(Object.fromEntries(chapters.map((chapter) => [chapter.id, true])));
	}

	function startQueue() {
		if (!canStartQueue) return;
		// 队列只处理可入队章节：即便作者在多选后改了目录，也不把生成中/已接受的章混进请求。
		setActiveId(queueSelection[0]);
		void story.startQueue(queueSelection, { autoAccept: queueConfirmed });
	}

	// REQ-060：正文重生成的可覆盖范围——已有可覆盖草稿（待审阅或已接受）的章节。
	// 没有正文的章节谈不上覆盖，生成中与中断章各有自己的恢复入口，不能被整章覆盖掉。
	function overwriteReason(chapterId: string): string | null {
		const draft = drafts.get(chapterId);
		if (!draft) return "本章还没有已保存正文，直接用「生成本章」即可。";
		if (draft.status === "generating") return "本章正在生成，请等待本次任务结束。";
		if (draft.status === "failed-or-unknown") return "本章生成中断或状态未知，请先从已保存处继续生成或人工补全。";
		return null;
	}

	const orderedOverwritable = chapters.filter((chapter) => !overwriteReason(chapter.id)).map((chapter) => chapter.id);
	// 「全部」按目录顺序取全部章节：已有正文的覆盖重写（旧文归档），还没有正文的直接生成。
	const allChapterIds = chapters.map((chapter) => chapter.id);
	const firstBodyBlockedAt = chapters.findIndex(
		(chapter, index) => selectedIds.includes(chapter.id) && hasUnresolvedPrevious(index),
	);
	const regenGate = !story.approvalMatches
		? "本章节目录已改版或模型与计费口径变化，请先在本页重新确认方案。"
		: story.dirty
			? "有未保存的目录修改；请先保存章节目录，再发起重新生成。"
			: story.hasRunningChapter || story.busyChapter !== null
				? "已有章节正在生成，请等待本次任务结束。"
				: story.evidenceIssues.length > 0 || story.data?.proposalIssue
					? "方案仍依赖待复核证据或提案绑定，请先在左侧核对。"
					: "";
	const canRegen = (ids: string[]) => ids.length > 0 && !regenGate && !story.queueRunning && !story.planQueue.running;

	function selectAllOverwritable() {
		setSelected(Object.fromEntries(orderedOverwritable.map((chapterId) => [chapterId, true])));
	}

	function startBodyRegenerate(ids: string[]) {
		if (!canRegen(ids) || !bodyRegenConfirmed) return;
		setActiveId(ids[0]);
		void story.startQueue(ids, { regenerate: true, autoAccept: bodyRegenAutoAccept });
	}

	function startPlanRegenerate(ids: string[]) {
		if (!canRegen(ids) || !planRegenConfirmed) return;
		void story.regenerateChapterPlans(ids);
	}

	async function confirmPlanHere() {
		if (await story.approvePlan({ allowExternalTransfer: true, evidenceConfirmed: true })) setApprovalConfirmed(false);
	}

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
			if (current.chapters.length >= MAX_PLAN_CHAPTERS) return current;
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
		if (!projectId || !plan || planning || story.queueRunning) return;
		if (plan.chapters.length >= MAX_PLAN_CHAPTERS) return;
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
		<div className={cn("flex flex-col gap-4", view === "reading" && "min-h-0 flex-1")}>
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

			{view === "outline" && !story.approvalMatches && (
				<Alert className="mb-1">
					<AlertDescription className="flex flex-col gap-2">
						<p>章节目录已存为新版（或模型与计费口径变化），方案级人工确认随之失效；已接受章节的正文与故事状态保留不变，不需要重新生成。</p>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={approvalConfirmed} onCheckedChange={(value) => setApprovalConfirmed(value === true)} />
							<span>我确认在本页重新确认沿用上一版的史料核对与资料外发口径</span>
						</label>
						<Button
							size="sm"
							variant="outline"
							className="self-start"
							disabled={
								!approvalConfirmed ||
								story.busy ||
								story.dirty ||
								story.queueRunning ||
								story.evidenceIssues.length > 0 ||
								Boolean(story.data?.proposalIssue)
							}
							onClick={() => void confirmPlanHere()}
						>
							<Check size={15} /> 就地确认方案与资料外发
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{view === "outline" && (
				<section className="flex flex-col gap-2 rounded-md border border-border bg-card px-4 py-3" aria-label="章节生成队列">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[12px] font-medium text-foreground">批量队列</span>
						<span className="text-[11px] text-muted-foreground">
							已选 {selectedIds.length} 章（可入队 {queueSelection.length} 章）· 按目录顺序逐章生成，每章仍是一次独立请求
						</span>
						<Button variant="ghost" size="xs" disabled={story.queueRunning || chapters.length === 0} onClick={selectAll}>
							全选
						</Button>
						<Button variant="ghost" size="xs" disabled={story.queueRunning || orderedQueueable.length === 0} onClick={selectAllQueueable}>
							全选可入队
						</Button>
						<Button variant="ghost" size="xs" disabled={story.queueRunning || orderedOverwritable.length === 0} onClick={selectAllOverwritable}>
							全选有正文
						</Button>
						<Button variant="ghost" size="xs" disabled={story.queueRunning || selectedIds.length === 0} onClick={clearSelection}>
							清空选择
						</Button>
					</div>
					<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
						<Checkbox className="mt-0.5" checked={queueConfirmed} onCheckedChange={(value) => setQueueConfirmed(value === true)} />
						<span>我确认队列在每章草稿完整后立即自动接受该章并固化故事状态；草稿不完整或状态未知的章节会停止队列，不跳过也不重发。</span>
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" disabled={!canStartQueue} onClick={startQueue}>
							<ListChecks size={15} /> {story.queueRunning && !story.queue.regenerate ? "队列进行中…" : "批量生成并自动接受"}
						</Button>
						{story.queueRunning && !story.queue.regenerate && (
							<Button variant="outline" size="sm" onClick={story.stopQueue}>
								<CircleStop size={15} /> 停止队列
							</Button>
						)}
						{story.queueRunning && !story.queue.regenerate && (
							<span role="status" className="text-[11px] text-muted-foreground">
								第 {story.queue.index + 1} / {story.queue.ids.length} 章 · {queuePhaseLabel[story.queue.phase] ?? "处理中"}
							</span>
						)}
					</div>
					{!story.queueRunning && selectedIds.length > 0 && queueGate && (
						<p role="status" className="text-[11px] leading-relaxed text-warning">
							{queueGate}
						</p>
					)}
					{!story.queue.regenerate && story.queue.reason && (
						<p role="status" className="text-[11px] leading-relaxed text-warning">
							{story.queue.reason}
						</p>
					)}
				</section>
			)}

			{view === "outline" && (
				<section className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 px-4 py-3" aria-label="重新生成">
					<div className="flex flex-wrap items-center gap-2">
						<RefreshCw size={14} className="text-muted-foreground" aria-hidden />
						<span className="text-[12px] font-medium text-foreground">剧情调整后的重新生成</span>
						<span className="text-[11px] text-muted-foreground">
							章纲设定与正文都支持全部重生成或按所选章节重生成；两类调用都严格一次一章，不合并生成。
						</span>
					</div>

					<div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
						<p className="text-[11px] leading-relaxed text-muted-foreground">
							章纲重生成只重写所选章节的设定（时间、情节节点、史料依据、章末钩子），其余章节原样保留；结果先进入待保存草稿，逐章审阅后由「保存章节目录」产生新版本。
						</p>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={planRegenConfirmed} onCheckedChange={(value) => setPlanRegenConfirmed(value === true)} />
							<span>我确认把已核定的史料片段发送到百炼，并按章重写所选章节的章纲设定。</span>
						</label>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={!canRegen(allChapterIds) || !planRegenConfirmed}
								onClick={() => startPlanRegenerate(allChapterIds)}
							>
								<Layers size={15} /> {story.planQueue.running ? "章纲重生成进行中…" : `重生成全部 ${chapters.length} 章章纲`}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canRegen(selectedIds) || !planRegenConfirmed}
								onClick={() => startPlanRegenerate(selectedIds)}
							>
								<Layers size={15} /> 重生成所选 {selectedIds.length} 章章纲
							</Button>
							{story.planQueue.running && (
								<Button variant="ghost" size="sm" onClick={story.stopPlanQueue}>
									<CircleStop size={15} /> 停止
								</Button>
							)}
							{story.planQueue.running && (
								<span role="status" className="text-[11px] text-muted-foreground">
									第 {story.planQueue.index + 1} / {story.planQueue.ids.length} 章 · 已重生成 {story.planQueue.done} 章
								</span>
							)}
							{!story.planQueue.running && story.planQueue.done > 0 && (
								<span role="status" className="text-[11px] text-muted-foreground">
									已重生成 {story.planQueue.done} 章章纲，尚未保存。
								</span>
							)}
						</div>
					</div>

					<div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
						<p className="text-[11px] leading-relaxed text-muted-foreground">
							正文重生成逐章覆盖本章正文，覆盖前旧正文自动归档、可在章节卡片里查看并恢复为上一版；还没有正文的章节按普通生成补齐。重生成会把其后章节标为待复核，因此必须自前往后逐章推进。
						</p>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={bodyRegenConfirmed} onCheckedChange={(value) => setBodyRegenConfirmed(value === true)} />
							<span>我确认用新正文覆盖所选章节的已保存正文（覆盖前归档，可恢复），并知悉其后章节会转为待复核。</span>
						</label>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={bodyRegenAutoAccept} onCheckedChange={(value) => setBodyRegenAutoAccept(value === true)} />
							<span>我确认每章正文完整后立即自动接受并固化故事状态，队列继续下一章；不勾选时队列在第一章重生成后停下，等人工审阅接受。</span>
						</label>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={!canRegen(allChapterIds) || !bodyRegenConfirmed}
								onClick={() => startBodyRegenerate(allChapterIds)}
							>
								<RefreshCw size={15} /> {story.queueRunning && story.queue.regenerate ? "正文重生成进行中…" : "重生成全部章节正文"}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canRegen(selectedIds) || !bodyRegenConfirmed}
								onClick={() => startBodyRegenerate(selectedIds)}
							>
								<RefreshCw size={15} /> 重生成所选 {selectedIds.length} 章正文
							</Button>
							{story.queueRunning && story.queue.regenerate && (
								<Button variant="ghost" size="sm" onClick={story.stopQueue}>
									<CircleStop size={15} /> 停止
								</Button>
							)}
							{story.queueRunning && story.queue.regenerate && (
								<span role="status" className="text-[11px] text-muted-foreground">
									第 {story.queue.index + 1} / {story.queue.ids.length} 章 · {queuePhaseLabel[story.queue.phase] ?? "处理中"}
								</span>
							)}
						</div>
						{regenGate && <p role="status" className="text-[11px] leading-relaxed text-warning">{regenGate}</p>}
						{!regenGate && firstBodyBlockedAt >= 0 && selectedIds.length > 0 && (
							<p role="status" className="text-[11px] leading-relaxed text-warning">
								第 {firstBodyBlockedAt + 1} 章之前还有既未接受、也未选中的章节，正文重生成会在该章停下。
							</p>
						)}
						{story.queue.regenerate && story.queue.reason && (
							<p role="status" className="text-[11px] leading-relaxed text-warning">
								{story.queue.reason}
							</p>
						)}
					</div>
				</section>
			)}

			{view === "outline" &&
				plan.chapters.map((chapter, index) => {
					const draft = drafts.get(chapter.id);
					const previousAccepted = plan.chapters
						.slice(0, index)
						.every((previous) => drafts.get(previous.id)?.status === "accepted");
					const canGenerate =
						story.approvalMatches &&
						!story.dirty &&
						!story.hasRunningChapter &&
						!story.queueRunning &&
						previousAccepted &&
						story.evidenceIssues.length === 0 &&
						!story.data?.proposalIssue;
					const estimate = data.estimate?.chapters.find((item) => item.chapterId === chapter.id);
					const mark = draft ? statusLabel[draft.status] : null;
					const queueNote = queueableReason(chapter.id);
					const queued = queueMark(chapter.id);
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
								<Checkbox
									aria-label={`选中第 ${index + 1} 章`}
									title={queueNote ?? "加入批量生成队列，或作为重新生成的指定章节"}
									checked={selected[chapter.id] === true}
									onCheckedChange={() => toggleSelected(chapter.id)}
								/>
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
								{queued && <Badge variant={queued.variant}>{queued.text}</Badge>}
								{draft?.needsReview === 1 && <Badge variant="warning">前文变更待复核</Badge>}
								<Button variant="ghost" size="icon-xs" aria-label="上移章节" disabled={index === 0 || story.busy || story.queueRunning} onClick={() => moveChapter(index, -1)}>
									<ArrowUp />
								</Button>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="下移章节"
									disabled={index === plan.chapters.length - 1 || story.busy || story.queueRunning}
									onClick={() => moveChapter(index, 1)}
								>
									<ArrowDown />
								</Button>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="删除章节"
									disabled={plan.chapters.length <= 1 || story.busy || story.queueRunning}
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
											story.queueRunning ||
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
							<DraftBackup chapterId={chapter.id} summary={draft} />
							</CollapsibleContent>
						</Collapsible>
					);
				})}

			{view === "outline" && (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="outline" size="sm" disabled={story.busy || story.queueRunning || plan.chapters.length >= MAX_PLAN_CHAPTERS} onClick={addChapter}>
							<Plus size={15} /> 添加章节
						</Button>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={planTransfer} onCheckedChange={(value) => setPlanTransfer(value === true)} />
							<span>我确认将已核定史料片段发送到百炼，基于上一章的钩子、情节与史料生成下一章设定</span>
						</label>
						<Button
							variant="outline"
							size="sm"
							disabled={planning || story.busy || story.queueRunning || plan.chapters.length >= MAX_PLAN_CHAPTERS || !planTransfer}
							onClick={() => void generateNextChapterPlan()}
						>
							{planning ? <LoaderCircle size={15} className="animate-spin" /> : <Wand2 size={15} />}
							{planning ? "生成中…" : "AI 续设下一章"}
						</Button>
						{story.dirty && (
							<Button size="sm" disabled={story.busy || story.hasRunningChapter || story.queueRunning} onClick={() => void story.savePlan()}>
								<Save size={15} /> 保存章节目录
							</Button>
						)}
						{story.dirty && (
							<span className="text-[11px] leading-relaxed text-warning">
								有未保存的目录修改；保存后已接受的正文与故事状态按章节保留，方案级确认需在本页重做一次。
							</span>
						)}
					</div>
					{planError && (
						<Alert variant="destructive">
							<AlertDescription>{planError}</AlertDescription>
						</Alert>
					)}
				</div>
			)}

			{view === "reading" && activeChapter && (
				<div className="flex min-h-0 flex-1 gap-4">
					{/* 正文视图左右两栏各占一条纵向滚动：滚正文不动目录，目录超出只在自己内部滚；640px 以下回退为折叠章节条。 */}
					<aside className="sticky top-0 hidden min-h-0 w-40 shrink-0 flex-col gap-1.5 sm:flex lg:w-56">
						<p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">正文目录 · {plan.chapters.length} 章</p>
						<nav aria-label="正文章节目录" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
							{plan.chapters.map((chapter, index) => (
								<ChapterJump
									key={chapter.id}
									chapter={chapter}
									index={index}
									layout="rail"
									active={activeId === chapter.id}
									accepted={drafts.get(chapter.id)?.status === "accepted"}
									onSelect={() => selectChapter(chapter.id)}
								/>
							))}
						</nav>
					</aside>
					<div ref={contentTop} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1">
						<Collapsible open={tocOpen} onOpenChange={setTocOpen} className="sticky top-0 z-10 -mx-1 hidden flex-col gap-1.5 bg-background px-1 pb-1.5 max-sm:flex">
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
									{plan.chapters.map((chapter, index) => (
										<ChapterJump
											key={chapter.id}
											chapter={chapter}
											index={index}
											layout="chips"
											active={activeId === chapter.id}
											accepted={drafts.get(chapter.id)?.status === "accepted"}
											onSelect={() => selectChapter(chapter.id)}
										/>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
						<ReadingPane chapter={activeChapter} size={readingSize} />
					</div>
				</div>
			)}

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

// REQ-060：正文重新生成覆盖前把旧文归档，这里只展示最近一版并可恢复；
// 恢复动作同样先把当前正文归档，因此任何一次点击都不会静默丢字。
function DraftBackup({ chapterId, summary }: { chapterId: string; summary?: ChapterDraft }) {
	const story = useStory();
	const readBackup = story.readChapterBackup;
	const [open, setOpen] = useState(false);
	const [backup, setBackup] = useState<ChapterBackup | null>(null);
	const [loading, setLoading] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [error, setError] = useState("");
	const count = summary?.backupCount ?? 0;

	useEffect(() => {
		if (!open) return;
		let active = true;
		setLoading(true);
		setError("");
		readBackup(chapterId)
			.then((result) => {
				if (active) setBackup(result);
			})
			.catch((cause) => {
				if (active) setError(cause instanceof Error ? cause.message : "无法读取归档正文。");
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [chapterId, open, readBackup]);

	if (!count) return null;

	const busy = story.busy || story.queueRunning || story.planQueue.running || story.hasRunningChapter || story.busyChapter !== null;

	async function restore() {
		setRestoring(true);
		setError("");
		const result = await story.restoreChapter(chapterId);
		setRestoring(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setConfirmed(false);
		setOpen(false);
		setBackup(null);
	}

	return (
		<Collapsible className="rounded-md border border-border bg-muted/30 px-3 py-2.5" open={open} onOpenChange={setOpen}>
			<div className="flex flex-wrap items-center gap-2">
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="xs">
						<History size={14} /> {open ? "收起上一版正文" : `查看上一版正文（已归档 ${count} 次）`}
					</Button>
				</CollapsibleTrigger>
				<span className="text-[11px] text-muted-foreground">
					最近归档 {backup ? new Date(backup.archivedAt).toLocaleString("zh-CN") : (summary?.backupAt ? new Date(summary.backupAt).toLocaleString("zh-CN") : "")} ·{" "}
					{(summary?.backupChars ?? backup?.content.length ?? 0).toLocaleString()} 字符
				</span>
			</div>
			<CollapsibleContent className="flex flex-col gap-2 pt-2">
				{loading && <Skeleton className="h-24" />}
				{!loading && error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				{!loading && !backup && !error && <p className="text-[11px] text-muted-foreground">读取不到归档正文，请刷新后重试。</p>}
				{!loading && backup && (
					<>
						<p className="text-[11px] leading-relaxed text-muted-foreground">
							归档原因：{backup.reason || "正文被覆盖"} · 归档时本章状态为 {statusLabel[backup.status]?.text ?? backup.status}
						</p>
						<div
							className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-serif text-[13px] leading-relaxed"
							aria-label="上一版正文"
						>
							{backup.content}
						</div>
						<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
							<Checkbox className="mt-0.5" checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
							<span>我确认用这一版覆盖本章当前正文；当前正文会先归档，本章及其后章节转为待复核，需要重新接受。</span>
						</label>
						<Button variant="outline" size="sm" className="self-start" disabled={!confirmed || restoring || busy} onClick={() => void restore()}>
							<RotateCcw size={15} /> {restoring ? "恢复中…" : "恢复为当前正文"}
						</Button>
					</>
				)}
			</CollapsibleContent>
		</Collapsible>
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

/** 正文视图的章节跳转按钮：左侧目录竖排（rail），窄屏横向折行（chips）。 */
function ChapterJump({
	chapter,
	index,
	active,
	accepted,
	layout,
	onSelect,
}: {
	chapter: Chapter;
	index: number;
	active: boolean;
	accepted: boolean;
	layout: "rail" | "chips";
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={active}
			className={cn(
				"flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[12px] transition-colors",
				layout === "rail" && "w-full text-left",
				active ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
			)}
		>
			<span className="font-mono text-[10px]">{String(index + 1).padStart(2, "0")}</span>
			<span className={cn("truncate", layout === "rail" ? "min-w-0 flex-1" : "max-w-[9rem]")}>{chapter.title || "未命名章节"}</span>
			{accepted && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
		</button>
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
							<Button variant="outline" size="sm" disabled={story.busy || story.hasRunningChapter || story.queueRunning} onClick={() => setRevising(true)}>
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
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" disabled={story.busy || story.queueRunning} onClick={() => void story.saveChapter(chapterId, value)}>
					<Save size={15} /> 保存修改
				</Button>
				<Button size="sm" disabled={story.busy || story.queueRunning} onClick={() => void story.acceptChapter(chapterId)}>
					<Check size={15} /> 接受本章
				</Button>
				{story.queueRunning && (
					<span role="status" className="text-[11px] leading-relaxed text-muted-foreground">
						批量队列进行中，本页暂不修改草稿或接受章节；队列停下后再人工处理。
					</span>
				)}
			</div>
		</div>
	);
}
