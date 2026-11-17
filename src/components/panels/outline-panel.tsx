"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, ListTree, LoaderCircle, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStory, type StoryPlan } from "@/components/story-provider";

type OutlineState = {
	blocked: string | null;
	evidence: Array<{ id: string; title: string }>;
	model: string;
	billingMode: string;
	configured: boolean;
	plan: { version: number; origin: "local" | "model" | "manual"; chapters: number; proposal: { slot: number; revision: number } | null } | null;
	reference: { series: string; specChars: number; drift: string | null } | null;
};
type Preview = { estimate: { inputTokenAllowance: number; maxOutputTokens: number; tokenAllowance: number; ceilingCny: number | null } };
type Generated = { plan: StoryPlan; issues: string[]; accepted: boolean; usage: { promptTokens: number | null; completionTokens: number | null } | null };

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
		load().catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : "无法读取大纲状态。"));
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

			{state.blocked ? (
				<Alert>
					<AlertDescription>{state.blocked}</AlertDescription>
				</Alert>
			) : (
				<>
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
								max={24}
								value={plannedChapters}
								onChange={(event) => setPlannedChapters(event.target.value)}
							/>
						</label>
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null || !Number.isInteger(chapters) || chapters < 1 || chapters > 24}
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
							disabled={busy !== null || !Number.isInteger(chapters) || chapters < 1 || chapters > 24}
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
							输入约 {preview.estimate.inputTokenAllowance.toLocaleString()} · 输出上限{" "}
							{preview.estimate.maxOutputTokens.toLocaleString()} · 合计工作量{" "}
							{preview.estimate.tokenAllowance.toLocaleString()} Token
							{tokenPlan
								? "；Token Plan 不折算人民币，实际消耗以百炼控制台为准。"
								: `；费用上限约 ¥${(preview.estimate.ceilingCny ?? 0).toFixed(3)}。`}
						</p>
					)}

					<label className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
						<Checkbox className="mt-0.5" checked={allowExternalTransfer} onCheckedChange={(value) => setAllowExternalTransfer(value === true)} />
						我确认将上述已核定事件的原文片段发送到百炼生成大纲。
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={busy !== null || !allowExternalTransfer || !state.configured}
							onClick={async () => {
								const result = await request({ action: "generate", plannedChapters: chapters, allowExternalTransfer: true }, "generate");
								if (result) {
									setDraft(result as unknown as Generated);
									if ((result as unknown as Generated).accepted) toast.success("大纲已生成，检查后再保存。");
								}
							}}
						>
							{busy === "generate" ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />} 生成大纲
						</Button>
						{story.data?.version ? (
							<span className="text-[11px] text-muted-foreground">当前第 {story.data.version} 版；保存会生成新版本并使旧确认失效。</span>
						) : null}
					</div>
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
