"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, Plus, RotateCcw, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type Participant = { id: string; name: string; participation: string };
type PlotEvent = {
	id: string | null;
	sourceKey: string | null;
	title: string;
	summary: string;
	kind: "historical" | "fiction";
	status: "candidate" | "adopted" | "rejected";
	origin: "derived" | "manual";
	needsReview: boolean;
	documentId: string | null;
	documentTitle: string | null;
	evidence: string;
	region: string;
	start: number;
	end: number;
	participants: Participant[];
};
type Data = {
	scope: { startYear: number; endYear: number; region: string; regions: string[] } | null;
	events: PlotEvent[];
	candidates: PlotEvent[];
	people: Array<{ id: string; name: string; selected: number }>;
	sources: Array<{ id: string; title: string }>;
};

const statusText: Record<PlotEvent["status"], string> = { candidate: "待核对", adopted: "已采用", rejected: "已排除" };
const statusVariant: Record<PlotEvent["status"], "success" | "warning" | "outline"> = {
	candidate: "warning",
	adopted: "success",
	rejected: "outline",
};

function inScope(event: PlotEvent, scope: Data["scope"]) {
	if (!scope) return true;
	return event.end >= scope.startYear && event.start <= scope.endYear;
}

type Draft = {
	id: string;
	sourceKey: string | null;
	title: string;
	summary: string;
	kind: "historical" | "fiction";
	region: string;
	start: string;
	end: string;
	documentId: string;
	evidence: string;
	confirmed: boolean;
	participants: string[];
};

const blank: Draft = {
	id: "",
	sourceKey: null,
	title: "",
	summary: "",
	kind: "historical",
	region: "",
	start: "",
	end: "",
	documentId: "",
	evidence: "",
	confirmed: false,
	participants: [],
};

function toDraft(event: PlotEvent): Draft {
	return {
		id: event.id ?? "",
		sourceKey: event.sourceKey,
		title: event.title,
		summary: event.summary,
		kind: event.kind,
		region: event.region,
		start: String(event.start),
		end: String(event.end),
		documentId: event.documentId ?? "",
		evidence: event.evidence,
		// 采用与复核都必须显式勾选核对，不因已有证据而预勾选。
		confirmed: false,
		participants: event.participants.map((person) => person.id),
	};
}

export function EventPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
	const [data, setData] = useState<Data | null>(null);
	const [failed, setFailed] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [verifyTarget, setVerifyTarget] = useState<PlotEvent | null>(null);
	const [verifyConfirmed, setVerifyConfirmed] = useState(false);

	function toggleChecked(key: string) {
		setChecked((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const response = await fetch(`/api/projects/${projectId}/events`, { cache: "no-store", signal });
			const result = (await response.json()) as Data & { error?: string };
			if (!response.ok) throw new Error(result.error ?? "无法读取剧情事件。");
			setData(result);
			setFailed("");
		},
		[projectId],
	);

	useEffect(() => {
		const controller = new AbortController();
		setData(null);
		load(controller.signal).catch((cause: unknown) => {
			if (cause instanceof Error && cause.name === "AbortError") return;
			setFailed(cause instanceof Error ? cause.message : "无法读取剧情事件。");
		});
		return () => controller.abort();
	}, [projectId, load]);

	async function send(payload: Record<string, unknown>, key: string) {
		setBusy(key);
		try {
			const response = await fetch(`/api/projects/${projectId}/events`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json()) as { events?: PlotEvent[]; candidates?: PlotEvent[]; error?: string };
			if (!response.ok) throw new Error(result.error ?? "保存失败。");
			setData((current) => (current ? { ...current, events: result.events ?? [], candidates: result.candidates ?? [] } : current));
			onChanged?.();
			return true;
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "保存失败。");
			return false;
		} finally {
			setBusy(null);
		}
	}

	async function submit() {
		if (!draft) return;
		setSaving(true);
		const payload = {
			action: draft.id ? "update" : "add",
			id: draft.id || undefined,
			sourceKey: draft.id ? undefined : (draft.sourceKey ?? undefined),
			title: draft.title,
			summary: draft.summary,
			kind: draft.kind,
			region: draft.region,
			start: draft.start,
			end: draft.end,
			documentId: draft.documentId || undefined,
			evidence: draft.evidence,
			confirmed: draft.confirmed,
			participants: draft.participants,
			status: "adopted",
		};
		const ok = await send(payload, "form");
		setSaving(false);
		if (ok) {
			setDraft(null);
			toast.success(draft.id ? "事件已更新并采用。" : "事件已新增并采用。");
		}
	}

	if (failed) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{failed}</AlertDescription>
			</Alert>
		);
	}
	if (!data) {
		return (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-16" />
				<Skeleton className="h-16" />
				<Skeleton className="h-16" />
			</div>
		);
	}

	const adopted = data.events.filter((event) => event.status === "adopted" && event.kind === "historical").length;

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				候选来自已核定的人物活动与已核对关系，采用前须逐条核对原文；旧派生事件在复核确认前不用于新章纲与正文。范围：
				{data.scope ? `${data.scope.startYear} 至 ${data.scope.endYear} 年 · ${data.scope.region}` : "尚未设定"}。
			</p>

			<div className="flex items-center justify-between gap-2">
				<p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">已采用 {adopted} 条历史事件</p>
				<Button size="sm" variant="outline" onClick={() => setDraft({ ...blank, region: data.scope?.region ?? "" })}>
					<Plus size={14} /> 新增事件
				</Button>
			</div>

			{data.candidates.length > 0 && (
				<section className="flex flex-col gap-1.5">
					<h4 className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">候选 {data.candidates.length}</h4>
					<ul className="flex flex-col gap-1.5">
						{data.candidates.map((candidate) => {
							const withinRange = inScope(candidate, data.scope);
							const key = candidate.sourceKey ?? candidate.title;
							const verified = checked.has(key);
							return (
								<li key={key} className="flex flex-col gap-1.5 rounded-sm border border-border bg-surface px-2.5 py-2">
									<div className="flex items-start justify-between gap-2">
										<p className="min-w-0 text-[12.5px] leading-snug text-foreground">{candidate.title}</p>
										{!withinRange && <Badge variant="warning">超出范围</Badge>}
									</div>
									<p className="text-[11px] text-muted-foreground">
										{candidate.start === candidate.end ? `${candidate.start} 年` : `${candidate.start}—${candidate.end} 年`}
										{candidate.region ? ` · ${candidate.region}` : ""}
										{candidate.documentTitle ? ` · 出自《${candidate.documentTitle}》` : ""}
									</p>
									{candidate.evidence && (
										<p className="border-l-2 border-input pl-2 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
											{candidate.evidence}
										</p>
									)}
									<div className="flex flex-wrap items-center gap-1.5">
										<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
											<Checkbox checked={verified} onCheckedChange={() => toggleChecked(key)} />
											已核对原文确实支持该事件
										</label>
										<Button
											size="xs"
											disabled={busy === key || !withinRange || !verified}
											onClick={() => {
												void send({ action: "adopt", sourceKey: candidate.sourceKey, confirmed: true }, key).then((ok) => ok && toast.success("已采用该事件。"));
											}}
										>
											{busy === key ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />} 采用
										</Button>
										<Button size="xs" variant="ghost" onClick={() => setDraft(toDraft(candidate))}>
											修改后采用
										</Button>
									</div>
									{!withinRange && (
										<p className="text-[11px] leading-relaxed text-muted-foreground">
											活动证据落在当前范围之外。可调整第 01 步的范围，或改写年份后采用。
										</p>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			)}

			<section className="flex flex-col gap-1.5">
				{data.events.length === 0 ? (
					<p className="rounded-sm border border-dashed border-input px-3 py-6 text-center text-[12px] text-muted-foreground">
						还没有事件。先在第 03 步核定人物活动，或直接新增。
					</p>
				) : (
					<ul className="flex flex-col gap-1.5">
						{data.events.map((event) => {
							const withinRange = inScope(event, data.scope);
							return (
							<li key={event.id} className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-2.5 py-2">
								<div className="flex items-start justify-between gap-2">
									<p className="min-w-0 text-[12.5px] leading-snug text-foreground">{event.title}</p>
									<span className="flex shrink-0 items-center gap-1">
										{event.needsReview && event.status === "adopted" && <Badge variant="warning">待复核</Badge>}
										<Badge variant={statusVariant[event.status]}>{statusText[event.status]}</Badge>
									</span>
								</div>
								<p className="text-[11px] text-muted-foreground">
									{event.kind === "historical" ? "历史" : "虚构"} ·{" "}
									{event.start === event.end ? `${event.start} 年` : `${event.start}—${event.end} 年`}
									{event.region ? ` · ${event.region}` : ""} · {event.origin === "derived" ? "由证据推导" : "手工记录"}{!withinRange ? " · 超出当前范围" : ""}
								</p>
								{event.participants.length > 0 && (
									<div className="flex flex-wrap gap-1">
										{event.participants.map((person) => (
											<Badge key={person.id} variant="secondary">
												{person.name}
											</Badge>
										))}
									</div>
								)}
								{event.evidence && (
									<p className="border-l-2 border-input pl-2 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
										{event.evidence}
									</p>
								)}
								<div className="flex flex-wrap items-center gap-1.5">
									{event.status === "candidate" && (
										<>
											<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
												<Checkbox checked={checked.has(event.id ?? "")} onCheckedChange={() => toggleChecked(event.id ?? "")} />
												已核对原文
											</label>
											<Button
												size="xs"
												disabled={!checked.has(event.id ?? "")}
												onClick={() => {
													void (withinRange
														? send({ action: "update", id: event.id, status: "adopt", confirmed: true }, `adopt-${event.id}`).then((ok) => ok && toast.success("已采用。"))
														: Promise.resolve(toast.error("事件时间超出当前历史范围，请先编辑年份或调整第 01 步范围。")));
												}}
											>
												<Check size={12} /> 采用
											</Button>
										</>
									)}
									{event.status === "adopted" && event.needsReview && (
										<Button
											size="xs"
											variant="outline"
											onClick={() => {
												setVerifyConfirmed(false);
												setVerifyTarget(event);
											}}
										>
											<ShieldCheck size={12} /> 核对确认
										</Button>
									)}
									{event.status === "adopted" && (
										<Button
											size="xs"
											variant="ghost"
											onClick={() => {
												void send({ action: "update", id: event.id, status: "reject" }, `reject-${event.id}`);
											}}
										>
											<Undo2 size={12} /> 排除
										</Button>
									)}
									{event.status === "rejected" && (
										<Button
											size="xs"
											variant="ghost"
											onClick={() => {
												void send({ action: "update", id: event.id, status: "restore" }, `restore-${event.id}`);
											}}
										>
											<RotateCcw size={12} /> 恢复
										</Button>
									)}
									<Button size="xs" variant="ghost" onClick={() => setDraft(toDraft(event))}>
										编辑
									</Button>
									<Button
										size="xs"
										variant="ghost"
										className="text-destructive"
										onClick={() => {
											void send({ action: "remove", id: event.id }, `remove-${event.id}`).then((ok) => ok && toast.success("事件已删除。"));
										}}
									>
											<Trash2 size={12} /> 删除
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</section>

			{draft && (
				<Dialog open onOpenChange={(open) => !open && setDraft(null)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{draft.id ? "编辑事件" : "新增事件"}</DialogTitle>
							<DialogDescription>历史事件需要原文证据；虚构事件单独标记，不改写史实。</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-3">
							<label className="flex flex-col gap-1.5">
								<Label htmlFor="event-title">事件名称</Label>
								<Input
									id="event-title"
									autoFocus
									maxLength={120}
									value={draft.title}
									placeholder="例如：朱全忠入汴受禅"
									onChange={(event) => setDraft({ ...draft, title: event.target.value })}
								/>
							</label>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1.5">
									<Label htmlFor="event-kind">类型</Label>
									<Select value={draft.kind} onValueChange={(value) => setDraft({ ...draft, kind: value as Draft["kind"] })}>
										<SelectTrigger id="event-kind" className="h-9">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="historical">历史</SelectItem>
											<SelectItem value="fiction">虚构</SelectItem>
										</SelectContent>
									</Select>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor="event-start">起始年</Label>
									<Input
										id="event-start"
										type="number"
										maxLength={8}
										value={draft.start}
										onChange={(event) => setDraft({ ...draft, start: event.target.value })}
									/>
								</label>
								<label className="flex flex-col gap-1.5">
									<Label htmlFor="event-end">结束年</Label>
									<Input
										id="event-end"
										type="number"
										maxLength={8}
										value={draft.end}
										onChange={(event) => setDraft({ ...draft, end: event.target.value })}
									/>
								</label>
							</div>
							<label className="flex flex-col gap-1.5">
								<Label htmlFor="event-region">区域</Label>
								<Input id="event-region" maxLength={200} value={draft.region} onChange={(event) => setDraft({ ...draft, region: event.target.value })} />
							</label>
							<label className="flex flex-col gap-1.5">
								<Label htmlFor="event-summary">本章要写什么</Label>
								<Textarea
									id="event-summary"
									rows={3}
									maxLength={4000}
									value={draft.summary}
									placeholder="用一两句话说明事件在故事中的作用。"
									onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
								/>
							</label>
							{draft.kind === "historical" && (
								<div className="flex flex-col gap-2">
									<Separator />
									<label className="flex flex-col gap-1.5">
										<Label htmlFor="event-source">出处资料</Label>
										<Select
											value={draft.documentId || undefined}
											onValueChange={(value) => setDraft({ ...draft, documentId: value, confirmed: false })}
										>
											<SelectTrigger id="event-source" className="h-9">
												<SelectValue placeholder={data.sources.length ? "选择历史资料" : "尚无历史资料"} />
											</SelectTrigger>
											<SelectContent>
												{data.sources.map((source) => (
													<SelectItem key={source.id} value={source.id}>
														{source.title}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</label>
									<label className="flex flex-col gap-1.5">
										<Label htmlFor="event-evidence">原文证据</Label>
										<Textarea
											id="event-evidence"
											rows={3}
											value={draft.evidence}
											placeholder="从资料原文逐字粘贴支撑该事件的句子。"
											onChange={(event) => setDraft({ ...draft, evidence: event.target.value, confirmed: false })}
										/>
									</label>
								</div>
							)}
							{data.people.length > 0 && (
								<fieldset className="flex flex-col gap-1.5">
									<legend className="text-[12px] text-foreground">参与人物</legend>
									<div className="flex flex-wrap gap-x-3 gap-y-1.5">
										{data.people.map((person) => (
											<label key={person.id} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
												<Checkbox
													checked={draft.participants.includes(person.id)}
													onCheckedChange={(checked) =>
														setDraft({
															...draft,
															participants: checked ? [...draft.participants, person.id] : draft.participants.filter((id) => id !== person.id),
														})
													}
												/>
												{person.name}
											</label>
										))}
									</div>
								</fieldset>
							)}
							{draft.kind === "historical" && (
								<label className="flex items-start gap-2 text-[12px] text-muted-foreground">
									<Checkbox checked={draft.confirmed} onCheckedChange={(checked) => setDraft({ ...draft, confirmed: checked === true })} />
									已核对原文确实支持该事件的时间、地点与人物。
								</label>
							)}
						</div>
						<DialogFooter>
							<Button variant="ghost" onClick={() => setDraft(null)}>
								取消
							</Button>
							<Button disabled={saving || !draft.title.trim() || !draft.start || !draft.end} onClick={() => void submit()}>
								{saving ? "保存中…" : "保存并采用"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
			{verifyTarget && (
				<Dialog open onOpenChange={(open) => !open && setVerifyTarget(null)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>核对旧派生事件</DialogTitle>
							<DialogDescription>
								该事件缺少可验证的人工确认记录。核对原文确实支持其内容、年代与参与人物后确认，才重新用作新章纲与正文的依据。
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-3">
							<p className="text-[12.5px] font-medium text-foreground">{verifyTarget.title}</p>
							<p className="text-[11px] text-muted-foreground">
								{verifyTarget.start === verifyTarget.end ? `${verifyTarget.start} 年` : `${verifyTarget.start}—${verifyTarget.end} 年`}
								{verifyTarget.region ? ` · ${verifyTarget.region}` : ""}
								{verifyTarget.documentTitle ? ` · 出自《${verifyTarget.documentTitle}》` : ""}
							</p>
							{verifyTarget.participants.length > 0 && (
								<div className="flex flex-wrap gap-1">
									{verifyTarget.participants.map((person) => (
										<Badge key={person.id} variant="secondary">
											{person.name}
										</Badge>
									))}
								</div>
							)}
							<p className="border-l-2 border-input pl-2 text-[11px] leading-relaxed text-muted-foreground">
								{verifyTarget.evidence || "（无证据摘录，请先编辑补齐。）"}
							</p>
							<label className="flex items-start gap-2 text-[12px] text-muted-foreground">
								<Checkbox checked={verifyConfirmed} onCheckedChange={(checked) => setVerifyConfirmed(checked === true)} />
								已核对原文确实支持该事件的内容、年代与参与人物，且仍适用当前范围与所选史料。
							</label>
						</div>
						<DialogFooter>
							<Button variant="ghost" onClick={() => setVerifyTarget(null)}>
								取消
							</Button>
							<Button
								disabled={!verifyConfirmed || busy === `verify-${verifyTarget.id}`}
								onClick={() => {
									void send({ action: "verify", id: verifyTarget.id, confirmed: true }, `verify-${verifyTarget.id}`).then((ok) => {
										if (ok) {
											setVerifyTarget(null);
											toast.success("已确认，该事件重新可用作大纲与正文依据。");
										}
									});
								}}
							>
								{busy === `verify-${verifyTarget.id}` ? "确认中…" : "确认核对结果"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
