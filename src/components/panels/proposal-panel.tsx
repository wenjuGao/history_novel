"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Eye, LoaderCircle, Save, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useStory } from "@/components/story-provider";

type Source = "local" | "model" | "manual";
type Proposal = {
	slot: number;
	revision: number;
	inputHash: string;
	title: string;
	viewpoint: string;
	mainLine: string;
	synopsis: string;
	conflicts: string[];
	fiction: string[];
	evidence: string[];
	source: Source;
	status: "draft" | "selected" | "superseded";
	modelRequestId: string | null;
	specVersion: number | null;
	updatedAt: string;
};
type Draft = { title: string; viewpoint: string; mainLine: string; synopsis: string; conflicts: string; fiction: string; evidence: string[] };
type State = {
	blocked: string | null;
	inputHash: string | null;
	evidence: Array<{ id: string; title: string }>;
	proposals: Proposal[];
	selected: Proposal | null;
	history: Array<{ slot: number; revisions: Proposal[] }>;
	model: string | null;
	billingMode: string;
	configured: boolean;
	estimate: { inputTokenAllowance: number; maxOutputTokens: number; tokenAllowance: number; ceilingCny: number | null } | null;
	specVersion: number | null;
};
type Preview = { prompt: { system: string; user: Record<string, unknown> }; estimate: State["estimate"] };

const sourceLabels: Record<Source, string> = { local: "本地拼装", model: "模型生成", manual: "人工改写" };

function toDraft(proposal: Proposal): Draft {
	return {
		title: proposal.title,
		viewpoint: proposal.viewpoint,
		mainLine: proposal.mainLine,
		synopsis: proposal.synopsis,
		conflicts: proposal.conflicts.join("\n"),
		fiction: proposal.fiction.join("\n"),
		evidence: proposal.evidence,
	};
}

function fromDraft(draft: Draft) {
	const lines = (value: string) =>
		value
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean);
	return {
		title: draft.title.trim(),
		viewpoint: draft.viewpoint.trim(),
		mainLine: draft.mainLine.trim(),
		synopsis: draft.synopsis.trim(),
		conflicts: lines(draft.conflicts),
		fiction: lines(draft.fiction),
		evidence: draft.evidence,
	};
}

export function ProposalPanel({ projectId, onSaved }: { projectId: string; onSaved?: () => void }) {
	const story = useStory();
	const [state, setState] = useState<State | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [editing, setEditing] = useState<{ slot: number; draft: Draft } | null>(null);
	const [allowExternalTransfer, setAllowExternalTransfer] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [failed, setFailed] = useState("");

	const load = useCallback(async () => {
		if (!projectId) return;
		const response = await fetch(`/api/projects/${projectId}/proposals`, { cache: "no-store" });
		const result = (await response.json()) as State & { error?: string };
		if (!response.ok) throw new Error(result.error ?? "无法读取剧情提案。");
		setState(result);
	}, [projectId]);

	useEffect(() => {
		setState(null);
		setPreview(null);
		setEditing(null);
		load().catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : "无法读取剧情提案。"));
	}, [load]);

	async function request(payload: Record<string, unknown>, key: string) {
		if (!projectId) return null;
		setBusy(key);
		setFailed("");
		try {
			const response = await fetch(`/api/projects/${projectId}/proposals`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json()) as Record<string, unknown> & { error?: string };
			if (!response.ok) throw new Error(result.error ?? "剧情提案请求失败。");
			return result;
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "剧情提案请求失败。");
			return null;
		} finally {
			setBusy(null);
		}
	}

	// 提案与章纲共用同一条链路：选定后章纲步骤才解锁，因此选定/取消都要让外层刷新门禁。
	async function act(payload: Record<string, unknown>, key: string, done: string) {
		const result = await request(payload, key);
		if (!result) return;
		await load();
		await story.reload();
		setEditing(null);
		onSaved?.();
		toast.success(done);
	}

	if (failed && !state) return <Alert variant="destructive"><AlertDescription>{failed}</AlertDescription></Alert>;
	if (!state) {
		return (
			<div className="flex flex-col gap-2" aria-label="正在读取剧情提案">
				<div className="h-8 animate-pulse rounded-md bg-muted" />
				<div className="h-24 animate-pulse rounded-md bg-muted" />
			</div>
		);
	}

	const tokenPlan = state.billingMode === "token-plan";
	const stale = (proposal: Proposal) => state.inputHash !== null && proposal.inputHash !== state.inputHash;

	return (
		<section className="flex flex-col gap-3" aria-label="剧情提案">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={state.evidence.length ? "success" : "warning"}>{state.evidence.length} 条已采用史实</Badge>
				{state.selected ? (
					<Badge variant="success">{`已选定第 ${state.selected.slot} 份 · r${state.selected.revision} · ${sourceLabels[state.selected.source]}`}</Badge>
				) : (
					<Badge variant="warning">未选定提案，章纲步骤锁定</Badge>
				)}
				{state.specVersion !== null && <Badge variant="outline">写作规格 v{state.specVersion}</Badge>}
				{state.model && <Badge variant="outline">{state.model}</Badge>}
				<Badge variant="outline">{tokenPlan ? "Token Plan" : "按量计费"}</Badge>
				{!state.configured && <Badge variant="warning">未配置 API Key</Badge>}
			</div>

			{state.blocked ? (
				<Alert>
					<AlertDescription>{state.blocked}</AlertDescription>
				</Alert>
			) : (
				<>
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						三份提案来自同一组已采用史实，只区分视角、主线、冲突与虚构边界，不含章节表。本地提案零 Token、不外发；
						重新生成只替换未选定的提案，选定的一份保持不动。
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null}
							onClick={() => void act({ action: "local" }, "local", "已按已采用史实拼装本地提案，未选定的槽位已替换为新版。")}
						>
							{busy === "local" ? <LoaderCircle size={14} className="animate-spin" /> : <Wand2 size={14} />} 本地提案
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null}
							onClick={async () => {
								const result = await request({}, "preview");
								if (result) {
									setPreview(result as unknown as Preview);
									toast.success("已展开将要外发的内容与用量上限，未发送任何内容。");
								}
							}}
						>
							<Eye size={14} /> 预览外发内容
						</Button>
						<Button
							size="sm"
							disabled={busy !== null || !allowExternalTransfer || !state.configured}
							onClick={() => void act({ action: "generate", allowExternalTransfer: true }, "generate", "模型提案已写入未选定槽位，逐份核对后再选定。")}
						>
							{busy === "generate" ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />} 生成模型提案
						</Button>
						<label className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
							<Checkbox className="mt-0.5" checked={allowExternalTransfer} onCheckedChange={(value) => setAllowExternalTransfer(value === true)} />
							我确认把上述已核定史实与写作规格发送到百炼生成提案。
						</label>
					</div>

					{preview?.estimate && (
						<p className="rounded-sm border border-border bg-surface-sunken/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
							输入约 {preview.estimate.inputTokenAllowance.toLocaleString()} · 输出上限{" "}
							{preview.estimate.maxOutputTokens.toLocaleString()} · 合计工作量{" "}
							{preview.estimate.tokenAllowance.toLocaleString()} Token
							{tokenPlan ? "；Token Plan 不折算人民币，实际消耗以百炼控制台为准。" : `；费用上限约 ¥${(preview.estimate.ceilingCny ?? 0).toFixed(3)}。`}
						</p>
					)}
					{preview && (
						<details className="rounded-sm border border-border bg-surface-sunken/60 px-2.5 py-2">
							<summary className="cursor-pointer text-[11px] text-muted-foreground">查看完整提示词与资料</summary>
							<pre className="mt-2 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
								{preview.prompt.system}
							</pre>
							<pre className="mt-2 max-h-96 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
								{JSON.stringify(preview.prompt.user, null, 2)}
							</pre>
						</details>
					)}
				</>
			)}

			{state.proposals.length === 0 && !state.blocked && (
				<p className="text-[12px] leading-relaxed text-muted-foreground">还没有提案，先点「本地提案」零成本生成三份，或核对预览后调用模型。</p>
			)}

			{state.proposals.map((proposal) => {
				const isEditing = editing?.slot === proposal.slot;
				const draft = isEditing ? editing.draft : null;
				const outdated = stale(proposal);
				return (
					<article key={proposal.slot} className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-2.5 py-2">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-[10px] text-muted-foreground">#{String(proposal.slot).padStart(2, "0")}</span>
							<strong className="text-[12.5px] text-foreground">{proposal.title}</strong>
							<Badge variant="outline">{sourceLabels[proposal.source]}</Badge>
							<Badge variant="outline">{`r${proposal.revision}`}</Badge>
							{proposal.status === "selected" && <Badge variant="success">已选定</Badge>}
							{outdated && <Badge variant="warning">依据的史实已变化</Badge>}
							{proposal.specVersion !== null && <Badge variant="outline">规格 v{proposal.specVersion}</Badge>}
						</div>

						{isEditing && draft ? (
							<div className="flex flex-col gap-2">
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-title-${proposal.slot}`}>标题</Label>
									<Input
										id={`proposal-title-${proposal.slot}`}
										maxLength={120}
										value={draft.title}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, title: event.target.value } })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-viewpoint-${proposal.slot}`}>叙述视角</Label>
									<Textarea
										id={`proposal-viewpoint-${proposal.slot}`}
										rows={2}
										maxLength={300}
										value={draft.viewpoint}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, viewpoint: event.target.value } })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-mainline-${proposal.slot}`}>主线</Label>
									<Textarea
										id={`proposal-mainline-${proposal.slot}`}
										rows={4}
										maxLength={4000}
										value={draft.mainLine}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, mainLine: event.target.value } })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-synopsis-${proposal.slot}`}>梗概</Label>
									<Textarea
										id={`proposal-synopsis-${proposal.slot}`}
										rows={3}
										maxLength={6000}
										value={draft.synopsis}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, synopsis: event.target.value } })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-conflicts-${proposal.slot}`}>主要冲突（每行一条）</Label>
									<Textarea
										id={`proposal-conflicts-${proposal.slot}`}
										rows={3}
										value={draft.conflicts}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, conflicts: event.target.value } })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor={`proposal-fiction-${proposal.slot}`}>虚构边界（每行一条）</Label>
									<Textarea
										id={`proposal-fiction-${proposal.slot}`}
										rows={3}
										value={draft.fiction}
										onChange={(event) => setEditing({ slot: proposal.slot, draft: { ...draft, fiction: event.target.value } })}
									/>
								</label>
								<div className="flex flex-col gap-1.5">
									<Label>依据的证据编号</Label>
									<div className="flex flex-wrap gap-x-3 gap-y-1">
										{state.evidence.map((item) => {
											const checked = draft.evidence.includes(item.id);
											return (
												<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" key={item.id} title={item.title}>
													<Checkbox
														checked={checked}
														onCheckedChange={(value) =>
															setEditing({
																slot: proposal.slot,
																draft: {
																	...draft,
																	evidence: value === true ? [...draft.evidence, item.id] : draft.evidence.filter((id) => id !== item.id),
																},
															})
														}
													/>
													<span className="font-mono">{item.id}</span>
												</label>
											);
										})}
									</div>
								</div>
								<div className="flex items-center gap-2">
									<Button
										size="sm"
										disabled={busy !== null}
										onClick={() =>
											void act({ action: "save", slot: proposal.slot, proposal: fromDraft(draft) }, `save-${proposal.slot}`, "提案修改已另存为新版本。")
										}
									>
										{busy === `save-${proposal.slot}` ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />} 保存修改
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
										<X size={14} /> 取消
									</Button>
								</div>
							</div>
						) : (
							<>
								<p className="text-[11px] leading-relaxed text-muted-foreground">
									<strong className="text-foreground">视角：</strong>
									{proposal.viewpoint}
								</p>
								<p className="text-[11px] leading-relaxed text-muted-foreground">
									<strong className="text-foreground">主线：</strong>
									{proposal.mainLine}
								</p>
								{proposal.synopsis && (
									<p className="text-[11px] leading-relaxed text-muted-foreground">
										<strong className="text-foreground">梗概：</strong>
										{proposal.synopsis}
									</p>
								)}
								<ul className="flex flex-col gap-0.5">
									{proposal.conflicts.map((item, index) => (
										<li className="text-[11px] leading-relaxed text-muted-foreground" key={index}>
											<strong className="text-foreground">冲突：</strong>
											{item}
										</li>
									))}
									{proposal.fiction.map((item, index) => (
										<li className="text-[11px] leading-relaxed text-muted-foreground" key={`fiction-${index}`}>
											<strong className="text-foreground">虚构：</strong>
											{item}
										</li>
									))}
								</ul>
								<p className="text-[11px] leading-relaxed text-muted-foreground">
									<strong className="text-foreground">依据：</strong>
									{proposal.evidence.join("、") || "无"}
								</p>

								<div className="flex flex-wrap items-center gap-2">
									{proposal.status === "selected" ? (
										<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act({ action: "unselect", slot: proposal.slot }, `unselect-${proposal.slot}`, "已取消选定，章纲需重新选定提案后才能生成。")}>
											<X size={14} /> 取消选定
										</Button>
									) : (
										<Button
											size="sm"
											disabled={busy !== null || outdated}
											title={outdated ? "该提案依据的史实已变化，请重新生成后再选定。" : undefined}
											onClick={() => void act({ action: "select", slot: proposal.slot }, `select-${proposal.slot}`, `已选定第 ${proposal.slot} 份提案，可进入章纲步骤。`)}
										>
											{busy === `select-${proposal.slot}` ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} 选定此方案
										</Button>
									)}
									<Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing({ slot: proposal.slot, draft: toDraft(proposal) })}>
										<Save size={14} /> 编辑
									</Button>
								</div>

								{(() => {
									const earlier = (state.history.find((item) => item.slot === proposal.slot)?.revisions ?? []).filter((item) => item.revision !== proposal.revision);
									if (!earlier.length) return null;
									return (
										<details className="text-[11px] text-muted-foreground">
											<summary className="cursor-pointer">历史版本（{earlier.length + 1}）</summary>
											<ul className="mt-1 flex flex-col gap-1">
												{earlier.map((item) => (
													<li className="flex flex-col gap-0.5 rounded-sm border border-border bg-surface-sunken/60 px-2 py-1.5" key={item.revision}>
														<span className="flex flex-wrap items-center gap-2">
															<span className="font-mono text-[10px]">{`r${item.revision}`}</span>
															<strong className="text-foreground">{item.title}</strong>
															<Badge variant="outline">{sourceLabels[item.source]}</Badge>
															<span>{item.status === "superseded" ? "已被新版替换" : item.status === "selected" ? "当前选定" : "草稿"}</span>
															<span>{`规格 ${item.specVersion === null ? "未记录" : `v${item.specVersion}`}`}</span>
														</span>
														<span>{`视角：${item.viewpoint}`}</span>
														<span>{`主线：${item.mainLine}`}</span>
														{item.synopsis && <span>{`梗概：${item.synopsis}`}</span>}
														{item.conflicts.map((line, index) => (
															<span key={`conflict-${index}`}>{`冲突：${line}`}</span>
														))}
														{item.fiction.map((line, index) => (
															<span key={`fiction-${index}`}>{`虚构：${line}`}</span>
														))}
														<span>{`依据：${item.evidence.join("、") || "无"}`}</span>
													</li>
												))}
											</ul>
										</details>
									);
								})()}
							</>
						)}
					</article>
				);
			})}

			{failed && state.blocked === null && (
				<Alert variant="destructive"><AlertDescription>{failed}</AlertDescription></Alert>
			)}
		</section>
	);
}
