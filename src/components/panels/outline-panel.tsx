"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleStop, Eye, ListTree, LoaderCircle, RefreshCw, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStory, type StoryPlan } from "@/components/story-provider";
import { MAX_PLAN_CHAPTERS, OUTLINE_GROUP_SIZE } from "@/lib/plan-limits";

type OutlineState = {
	blocked: string | null;
	proposalIssue: string | null;
	proposalBlocked: boolean;
	evidence: Array<{ id: string; title: string }>;
	model: string;
	billingMode: string;
	configured: boolean;
	plan: { version: number; origin: "local" | "model" | "manual"; chapters: number; proposal: { slot: number; revision: number } | null } | null;
	reference: { series: string; specChars: number; drift: string | null } | null;
};
type Preview = { estimate: { inputTokenAllowance: number; maxOutputTokens: number; tokenAllowance: number; ceilingCny: number | null }; groups?: number };
type Generated = { plan: StoryPlan; issues: string[]; accepted: boolean; usage: { promptTokens: number | null; completionTokens: number | null } | null };
type PlanChapter = StoryPlan["chapters"][number];
type BookFrame = Pick<StoryPlan, "title" | "synopsis" | "centralQuestion" | "historicalAnchors" | "fictionBoundary" | "humanReviewQuestions">;
type GroupUsage = { promptTokens: number | null; completionTokens: number | null } | null | undefined;
type GroupResponse = {
	chapters?: PlanChapter[];
	book?: BookFrame | null;
	plan?: StoryPlan;
	issues?: string[];
	accepted?: boolean;
	usage?: GroupUsage;
	generated?: number;
	groups?: number;
};
/** 逐组生成的中间态：已生成章节只留在浏览器里，某组失败或作者停笔都不丢。 */
type GroupRun = { planned: number; chapters: PlanChapter[]; book: BookFrame | null; calls: number; usage: { promptTokens: number; completionTokens: number } | null };

/** 计划章数折算的调用组数：每组最多 OUTLINE_GROUP_SIZE 章。 */
function groupTotal(planned: number) {
	return Math.max(1, Math.ceil(planned / OUTLINE_GROUP_SIZE));
}

function addUsage(total: GroupRun["usage"], next: GroupUsage): GroupRun["usage"] {
	if (!next || (next.promptTokens === null && next.completionTokens === null)) return total;
	return {
		promptTokens: (total?.promptTokens ?? 0) + (next.promptTokens ?? 0),
		completionTokens: (total?.completionTokens ?? 0) + (next.completionTokens ?? 0),
	};
}

const originLabels: Record<"local" | "model" | "manual", string> = {
	local: "本地骨架大纲",
	model: "模型大纲",
	manual: "人工编辑大纲",
};

export function OutlinePanel({ projectId, onSaved }: { projectId: string; onSaved?: () => void }) {
	const story = useStory();
	const [state, setState] = useState<OutlineState | null>(null);
	const [plannedChapters, setPlannedChapters] = useState("8");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [draft, setDraft] = useState<Generated | null>(null);
	const [allowExternalTransfer, setAllowExternalTransfer] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [failed, setFailed] = useState("");
	// 逐组生成的进度：计划章数不限制，每 OUTLINE_GROUP_SIZE 章一次调用，界面上能看到第几组与已生成章数。
	const [run, setRun] = useState<GroupRun | null>(null);
	const stopRun = useRef(false);

	const load = useCallback(async () => {
		if (!projectId) return;
		const response = await fetch(`/api/projects/${projectId}/outline`, { cache: "no-store" });
		const result = (await response.json()) as OutlineState & { error?: string };
		if (!response.ok) throw new Error(result.error ?? "无法读取大纲状态。");
		setState(result);
	}, [projectId]);

	useEffect(() => {
		setState(null);
		setDraft(null);
		setPreview(null);
		setRun(null);
		load().catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : "无法读取大纲状态。"));
		// 离开本页或切换作品时停下逐组循环，避免继续在模型上花费未审阅的章节。
		return () => {
			stopRun.current = true;
		};
	}, [load]);

	async function request(payload: Record<string, unknown>, key: string) {
		if (!projectId) return null;
		setBusy(key);
		setFailed("");
		try {
			const response = await fetch(`/api/projects/${projectId}/outline`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json()) as Record<string, unknown> & { error?: string };
			if (!response.ok) throw new Error(result.error ?? "大纲请求失败。");
			return result;
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "大纲请求失败。");
			return null;
		} finally {
			setBusy(null);
		}
	}

	/** 一次调用只生成一组（最多 OUTLINE_GROUP_SIZE 章）；失败抛出交给调用方停下并保留已生成章节。 */
	async function postGroup(payload: Record<string, unknown>) {
		const response = await fetch(`/api/projects/${projectId}/outline`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const result = (await response.json()) as GroupResponse & { error?: string };
		if (!response.ok) throw new Error(result.error ?? "章纲分组生成失败。");
		return result;
	}

	/** 用已生成的章节成稿：中途停笔或某组持续失败时，不必把已写好的章纲丢掉重来。 */
	async function finalizeRun(current: GroupRun) {
		const result = await postGroup({ action: "finalize", plannedChapters: current.planned, accumulated: current.chapters, book: current.book });
		if (!result.plan) throw new Error("服务端未返回可保存的章纲。");
		setDraft({ plan: result.plan, issues: result.issues ?? [], accepted: result.accepted !== false, usage: current.usage });
		setRun(null);
		toast.success(`已用生成的 ${current.chapters.length} 章组成章纲，检查后再保存。`);
	}

	async function generateGroups(start?: GroupRun | null) {
		if (!projectId) return;
		stopRun.current = false;
		setBusy("generate");
		setFailed("");
		setDraft(null);
		let current: GroupRun = start ? { ...start } : { planned: Number(plannedChapters), chapters: [], book: null, calls: 0, usage: null };
		setRun(current);
		try {
			while (current.chapters.length < current.planned) {
				const result = await postGroup({
					action: "generate-group",
					plannedChapters: current.planned,
					from: current.chapters.length + 1,
					accumulated: current.chapters,
					book: current.book,
					allowExternalTransfer: true,
				});
				const produced = result.chapters ?? [];
				current = {
					...current,
					chapters: [...current.chapters, ...produced],
					book: current.book ?? result.book ?? null,
					calls: current.calls + 1,
					usage: addUsage(current.usage, result.usage),
				};
				setRun(current);
				// 补齐计划章数的那一次调用直接返回整本规划，界面随即进入既有的检查—保存流程。
				if (result.plan) {
					setDraft({ plan: result.plan, issues: result.issues ?? [], accepted: result.accepted !== false, usage: current.usage });
					setRun(null);
					toast.success(`${result.plan.chapters.length} 章章纲已生成，检查后再保存。`);
					return;
				}
				if (!produced.length) throw new Error(`模型没有返回第 ${current.chapters.length + 1} 章起的章节，请先核对已采用事件是否足够。`);
				if (stopRun.current) break;
			}
			if (current.chapters.length) await finalizeRun(current);
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "章纲分组生成失败。");
		} finally {
			setBusy(null);
		}
	}

	async function saveDraft() {
		if (!projectId || !draft) return;
		setBusy("save");
		setFailed("");
		try {
			const response = await fetch(`/api/projects/${projectId}/outline`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedVersion: story.data?.version ?? 0, plan: draft.plan }),
			});
			const result = (await response.json()) as { version?: number; evidenceShift?: string[]; error?: string };
			if (!response.ok) throw new Error(result.error ?? "无法保存章节目录。");
			await story.reload();
			setDraft(null);
			onSaved?.();
			toast.success(`章节目录已保存为第 ${result.version} 版；人工确认需重新进行。`);
			if (result.evidenceShift?.length) {
				toast.warning(`证据编号已重指向，请逐条核对引用：${result.evidenceShift.join("；")}`, { duration: 12000 });
			}
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "无法保存章节目录。");
		} finally {
			setBusy(null);
		}
	}

	if (failed && !state) return <Alert variant="destructive"><AlertDescription>{failed}</AlertDescription></Alert>;
	if (!state) {
		return (
			<div className="flex flex-col gap-2">
				<div className="h-8 animate-pulse rounded-md bg-muted" />
				<div className="h-8 animate-pulse rounded-md bg-muted" />
			</div>
		);
	}

	const chapters = Number(plannedChapters);
	const chaptersReady = Number.isInteger(chapters) && chapters >= 1 && chapters <= MAX_PLAN_CHAPTERS;
	const groupCount = groupTotal(chapters);
	const tokenPlan = state.billingMode === "token-plan";

	return (
		<section className="flex flex-col gap-3" aria-label="大纲生成">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={state.evidence.length ? "success" : "warning"}>{state.evidence.length} 条证据</Badge>
				<Badge variant="outline">{state.model}</Badge>
				<Badge variant="outline">{tokenPlan ? "Token Plan" : "按量计费"}</Badge>
				{state.plan && <Badge variant={state.plan.origin === "local" ? "warning" : "success"}>{`v${state.plan.version} ${originLabels[state.plan.origin]} · ${state.plan.chapters} 章`}</Badge>}
				{state.reference ? (
					<Badge variant={state.reference.drift ? "warning" : "outline"}>
						参考《{state.reference.series}》写作规格 {state.reference.specChars.toLocaleString()} 字
					</Badge>
				) : (
					<Badge variant="outline">未固定参考小说</Badge>
				)}
				{!state.configured && <Badge variant="warning">未配置 API Key</Badge>}
			</div>

			{state.reference?.drift && (
				<Alert variant="destructive">
					<AlertDescription>{`参考小说与登记内容不一致：${state.reference.drift}；请重新运行 npm run refs:register。`}</AlertDescription>
				</Alert>
			)}

			{state.blocked && !state.proposalBlocked ? (
				<Alert>
					<AlertDescription>{state.blocked}</AlertDescription>
				</Alert>
			) : (
				<>
					{/* REQ-060：提案类拦截不再收起操作区——章纲在这里可以整本重生成，也可以到章节工作台按章重生成。 */}
					{(state.blocked || state.proposalIssue) && (
						<Alert>
							<AlertDescription className="flex flex-col gap-2">
								<p>{state.blocked ?? state.proposalIssue}</p>
								{state.plan && (
									<p className="text-[11px] leading-relaxed text-muted-foreground">
										已保存的第 {state.plan.version} 版章纲（{state.plan.chapters} 章）因此失去有效绑定，逐章生成会被拦下。
										重新生成的新版仍按章节继承已接受正文，不删除任何已写文本；前序被改写的章节转为待复核。
									</p>
								)}
								<div className="flex flex-wrap items-center gap-2">
									<Button asChild size="xs" variant="outline">
										<Link href={`/projects/${projectId}/setup/proposals`}>
											<ListTree size={14} /> 去剧情提案步骤重新选定
										</Link>
									</Button>
									{state.plan && (
										<Button asChild size="xs" variant="outline">
											<Link href={`/projects/${projectId}/chapters`}>
												<RefreshCw size={14} /> 到章节工作台按章重生成
											</Link>
										</Button>
									)}
								</div>
							</AlertDescription>
						</Alert>
					)}
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						大纲只依据已采用的事件与其原文证据编排；预览不发送任何内容到模型，生成前会显示完整外发内容与用量上限。
					</p>
					<div className="flex items-end gap-2">
						<label className="flex flex-col gap-1.5">
							<Label htmlFor="outline-chapters">计划章节数</Label>
							<Input
								id="outline-chapters"
								className="w-24"
								type="number"
								min={1}
								max={MAX_PLAN_CHAPTERS}
								value={plannedChapters}
								onChange={(event) => setPlannedChapters(event.target.value)}
							/>
						</label>
						{/* 章数不限制：每次调用只写一组，界面按组串行推进，避免一次长请求超时后整本重来。 */}
						<p className="pb-2 text-[11px] leading-relaxed text-muted-foreground">
							{chaptersReady
								? `不超过 ${OUTLINE_GROUP_SIZE} 章一次调用生成；${chapters} 章分 ${groupCount} 次调用逐组生成。`
								: `计划章节数需为 1 至 ${MAX_PLAN_CHAPTERS} 的整数。`}
						</p>
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null || !chaptersReady}
							onClick={async () => {
								const result = await request({ plannedChapters: chapters }, "preview");
								if (result) {
									setPreview(result as unknown as Preview);
									toast.success("已按当前证据计算用量，未发送任何内容。");
								}
							}}
						>
							<Eye size={14} /> 预览
						</Button>
						{/* REQ-056：本地骨架只按已采用事件编排年代顺序，零 Token、不外发，仍需作者自行确认。 */}
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null || !chaptersReady}
							onClick={async () => {
								const result = await request({ action: "skeleton", plannedChapters: chapters }, "skeleton");
								if (!result) return;
								await story.reload();
								const written = (result as { committed?: boolean }).committed
									? `本地骨架章纲已保存为第 ${result.version} 版`
									: `与第 ${result.version} 版一致，未新增版本`;
								toast.success(`${written}；${(result as { chapters?: number }).chapters ?? 0} 章，尚未确认。`);
							}}
						>
							{busy === "skeleton" ? <LoaderCircle size={14} className="animate-spin" /> : <ListTree size={14} />} 本地骨架章纲
						</Button>
						{state.plan?.proposal && (
							<Badge variant="outline">{`绑定提案 #${String(state.plan.proposal.slot).padStart(2, "0")} · r${state.plan.proposal.revision}`}</Badge>
						)}
					</div>

					{preview && (
						<p className="rounded-sm border border-border bg-surface-sunken/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
							{`${preview.groups ?? 1} 次调用 · 输入约 `}
							{preview.estimate.inputTokenAllowance.toLocaleString()} · 输出上限{" "}
							{preview.estimate.maxOutputTokens.toLocaleString()} · 合计工作量{" "}
							{preview.estimate.tokenAllowance.toLocaleString()} Token
							{tokenPlan
								? "；Token Plan 不折算人民币，实际消耗以百炼控制台为准。"
								: `；费用上限约 ¥${(preview.estimate.ceilingCny ?? 0).toFixed(3)}。`}
						</p>
					)}

					<label className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
						<Checkbox className="mt-0.5" checked={allowExternalTransfer} onCheckedChange={(value) => setAllowExternalTransfer(value === true)} />
						我确认将上述已核定事件的原文片段发送到百炼{state.plan ? "重新生成整本章纲" : "生成大纲"}。
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={busy !== null || !allowExternalTransfer || !state.configured || !chaptersReady}
							onClick={() => void generateGroups()}
						>
							{busy === "generate" ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
							{state.plan ? "重新生成整本章纲" : "生成大纲"}
						</Button>
						{busy === "generate" && run && (
							<Button size="sm" variant="outline" onClick={() => { stopRun.current = true; }}>
								<CircleStop size={14} /> 停止并成稿
							</Button>
						)}
						{story.data?.version ? (
							<span className="text-[11px] leading-relaxed text-muted-foreground">
								当前第 {story.data.version} 版；保存会生成新版本并使旧确认失效。新版按章节继承已接受正文与故事状态，章纲有改动的章节转为待复核；
								只重写部分章节请到章节工作台按章重生成章纲。
							</span>
						) : null}
					</div>

					{/* 逐组生成的进度与中断出口：失败或停笔后已生成章节仍在本地，可续跑本组或直接成稿。 */}
					{run && (
						<div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-surface-sunken/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
							<span>{`第 ${Math.min(Math.floor(run.chapters.length / OUTLINE_GROUP_SIZE) + 1, groupTotal(run.planned))} / ${groupTotal(run.planned)} 组 · 已生成 ${run.chapters.length} / ${run.planned} 章 · 已调用 ${run.calls} 次`}</span>
							{busy === null && run.chapters.length > 0 && (
								<>
									<Button size="xs" variant="ghost" disabled={!allowExternalTransfer || !state.configured} onClick={() => void generateGroups(run)}>
										<RefreshCw size={12} /> 继续生成
									</Button>
									<Button size="xs" variant="ghost" onClick={() => void finalizeRun(run).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : "无法用已生成章节成稿。"))}>
										<Save size={12} /> 以已生成 {run.chapters.length} 章成稿
									</Button>
									<Button size="xs" variant="ghost" onClick={() => { setRun(null); setFailed(""); }}>
										放弃这批
									</Button>
								</>
							)}
						</div>
					)}
				</>
			)}

			{draft && (
				<div className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-2.5 py-2">
					<p className="text-[12.5px] text-foreground">
						《{draft.plan.title}》· {draft.plan.chapters.length} 章 ·{" "}
						{draft.usage ? `输入 ${draft.usage.promptTokens ?? "?"} / 输出 ${draft.usage.completionTokens ?? "?"} Token` : "用量未返回"}
					</p>
					<ol className="flex flex-col gap-1">
						{draft.plan.chapters.map((chapter, index) => (
							<li key={chapter.id} className="text-[11px] leading-relaxed text-muted-foreground">
								<strong className="text-foreground">{String(index + 1).padStart(2, "0")} {chapter.title}</strong>
								{chapter.historyEvidence.length ? ` · ${chapter.historyEvidence.join("、")}` : " · 无证据引用"}
								{chapter.fiction.length ? " · 含虚构" : ""}
							</li>
						))}
					</ol>
					{draft.issues.length > 0 ? (
						<Alert variant="destructive">
							<AlertDescription>{draft.issues.join(" ")}</AlertDescription>
						</Alert>
					) : (
						<p className="text-[11px] text-success">结构与证据编号校验通过。</p>
					)}
					<div className="flex items-center gap-2">
						<Button size="sm" disabled={busy !== null || !draft.accepted} onClick={() => void saveDraft()}>
							{busy === "save" ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />} 保存为章节目录
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
							丢弃
						</Button>
					</div>
				</div>
			)}

			{failed && state.blocked === null && (
				<Alert variant="destructive"><AlertDescription>{failed}</AlertDescription></Alert>
			)}
		</section>
	);
}
