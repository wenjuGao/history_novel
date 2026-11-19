"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Layers, LoaderCircle, Plus, RotateCcw, ShieldCheck, Trash2, Undo2, Users } from "lucide-react";
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
import { astronomicalToHistorical } from "@/lib/history-time";

type Participant = { id: string; name: string; participation: string };
type Cue = { kind: string; word: string; span: string };
type PlotEvent = {
	id: string | null;
	sourceKey: string | null;
	title: string;
	summary: string;
	reveal: string;
	cues: Cue[];
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
type Person = { id: string; name: string; selected: number };
type Data = {
	scope: { startYear: number; endYear: number; region: string; regions: string[] } | null;
	events: PlotEvent[];
	candidates: PlotEvent[];
	people: Person[];
	sources: Array<{ id: string; title: string }>;
};

/** 时间阶段内的史料记事：年份为天文纪年，展示时转历史纪年；tier 1 才带品性线索。 */
type StageEvent = {
	key: string;
	year: number;
	yearLabel: string;
	period: string;
	text: string;
	title: string;
	volume: string;
	bookName: string;
	documentId: string | null;
	url: string;
	names: string[];
	participantIds: string[];
	missingNames: string[];
	cues: Cue[];
	tier: number;
	adopted: boolean;
};
type StageResult = {
	ready: boolean;
	candidates: StageEvent[];
	note: string;
	total: number;
	kinds: Array<{ kind: string; count: number }>;
	people: number;
};
/** 勾选记事去重带出的人物预览。 */
type BroughtPerson = { name: string; characterId: string | null; eventCount: number; firstYear: number | null; lastYear: number | null };

const pageSize = 60;
const tierText: Record<number, string> = { 1: "体现性格与风貌", 2: "战政行动", 3: "除拜赠谥等事务" };
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

function yearLabel(event: { start: number; end: number }) {
	return event.start === event.end ? `${event.start} 年` : `${event.start}—${event.end} 年`;
}

type Draft = {
	id: string;
	sourceKey: string | null;
	title: string;
	summary: string;
	reveal: string;
	kind: "historical" | "fiction";
	region: string;
	start: string;
	end: string;
	documentId: string;
	evidence: string;
	cues: Cue[];
	confirmed: boolean;
	participants: string[];
};

const blank: Draft = {
	id: "",
	sourceKey: null,
	title: "",
	summary: "",
	reveal: "",
	kind: "historical",
	region: "",
	start: "",
	end: "",
	documentId: "",
	evidence: "",
	cues: [],
	confirmed: false,
	participants: [],
};

function toDraft(event: PlotEvent): Draft {
	return {
		id: event.id ?? "",
		sourceKey: event.sourceKey,
		title: event.title,
		summary: event.summary,
		reveal: event.reveal,
		kind: event.kind,
		region: event.region,
		start: String(event.start),
		end: String(event.end),
		documentId: event.documentId ?? "",
		evidence: event.evidence,
		cues: event.cues,
		// 采用与复核都必须显式勾选核对，不因已有证据而预勾选。
		confirmed: false,
		participants: event.participants.map((person) => person.id),
	};
}

/** 从记事直接起稿：证据与年代取本机史料，品性描述由线索落底，作者可在弹窗里改写。 */
function draftFromStage(item: StageEvent, scope: Data["scope"]): Draft {
	const year = String(astronomicalToHistorical(item.year));
	return {
		...blank,
		sourceKey: item.key,
		title: item.title,
		summary: item.text,
		reveal: item.cues.map((cue) => `${cue.kind}：${cue.span || cue.word}`).join("；"),
		region: scope?.region ?? "",
		start: year,
		end: year,
		documentId: item.documentId ?? "",
		evidence: item.text,
		cues: item.cues,
		participants: item.participantIds,
	};
}

export function EventPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
	const [data, setData] = useState<Data | null>(null);
	const [failed, setFailed] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	// 勾选即人工断言「已核对原文」，同时把这条记事选入批量采用；未勾选的条目不会写入。
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [verifyTarget, setVerifyTarget] = useState<PlotEvent | null>(null);
	const [verifyConfirmed, setVerifyConfirmed] = useState(false);
	const [stage, setStage] = useState<StageResult | null>(null);
	const [stageBusy, setStageBusy] = useState(false);
	const [stageMore, setStageMore] = useState(false);
	const [kind, setKind] = useState<string | null>(null);
	const [administrative, setAdministrative] = useState(false);
	const [brought, setBrought] = useState<BroughtPerson[] | null>(null);

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

	// 主列表＝第 01 步时间阶段内的史料记事；换范围或换筛选条件都从第一页重新取。
	const loadStage = useCallback(
		async (options: { offset?: number; kindFilter?: string | null; showAdministrative?: boolean } = {}, signal?: AbortSignal) => {
			const scope = data?.scope;
			if (!scope) return;
			const useOffset = options.offset ?? 0;
			const params = new URLSearchParams({ start: String(scope.startYear), end: String(scope.endYear), limit: String(pageSize), offset: String(useOffset) });
			const activeKind = options.kindFilter ?? kind;
			const activeAdmin = options.showAdministrative ?? administrative;
			if (activeKind) params.set("kind", activeKind);
			if (activeAdmin) params.set("administrative", "1");
			if (useOffset > 0) setStageMore(true);
			else setStageBusy(true);
			try {
				const response = await fetch(`/api/projects/${projectId}/events/candidates?${params.toString()}`, { cache: "no-store", signal });
				const result = (await response.json()) as StageResult & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "无法读取该时间阶段的史料记事。");
				setStage((current) => {
					const merged = useOffset > 0 && current ? [...current.candidates, ...result.candidates] : result.candidates;
					return { ...result, candidates: merged };
				});
			} catch (cause) {
				if (cause instanceof Error && cause.name === "AbortError") return;
				toast.error(cause instanceof Error ? cause.message : "无法读取该时间阶段的史料记事。");
			} finally {
				setStageBusy(false);
				setStageMore(false);
			}
		},
		[projectId, data?.scope, kind, administrative],
	);

	useEffect(() => {
		const controller = new AbortController();
		if (data?.scope) void loadStage({ offset: 0 }, controller.signal);
		return () => controller.abort();
	}, [data?.scope, kind, administrative, loadStage]);

	const selectedKeys = useMemo(() => [...checked], [checked]);

	// 选中的记事一变就回读去重后的人物，作者据此知道下一步会带出谁。
	useEffect(() => {
		if (!selectedKeys.length) {
			setBrought(null);
			return;
		}
		const controller = new AbortController();
		fetch(`/api/projects/${projectId}/events/persons?keys=${encodeURIComponent(selectedKeys.join(","))}`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => (response.ok ? ((await response.json()) as { persons: BroughtPerson[] }) : null))
			.then((result) => setBrought(result?.persons ?? null))
			.catch(() => undefined);
		return () => controller.abort();
	}, [projectId, selectedKeys.join(",")]);

	function toggleChecked(key: string) {
		setChecked((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	function markChecked(keys: string[], value: boolean) {
		setChecked((current) => {
			const next = new Set(current);
			for (const key of keys) {
				if (value) next.add(key);
				else next.delete(key);
			}
			return next;
		});
	}

	async function send(payload: Record<string, unknown>, key: string) {
		setBusy(key);
		try {
			const response = await fetch(`/api/projects/${projectId}/events`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json()) as Data & { persons?: Person[]; adoptedCount?: number; skipped?: Array<{ key: string; reason: string }>; error?: string };
			if (!response.ok) throw new Error(result.error ?? "保存失败。");
			setData((current) =>
				current ? { ...current, events: result.events ?? [], candidates: result.candidates ?? [], people: result.people ?? current.people } : current,
			);
			// 批量采用与记事补写都会新建人物，重新读一次才能拿到去重后的人物清单。
			if (payload.action === "adoptMany" || payload.action === "add") await load();
			setStage((current) =>
				current
					? {
							...current,
							candidates: current.candidates.map((item) =>
								selectedKeys.includes(item.key) || item.key === payload.sourceKey ? { ...item, adopted: true } : item,
							),
						}
					: current,
			);
			onChanged?.();
			return result;
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "保存失败。");
			return null;
		} finally {
			setBusy(null);
		}
	}

	async function adoptSelected() {
		const items = (stage?.candidates ?? [])
			.filter((item) => checked.has(item.key) && !item.adopted)
			.map((item) => ({ key: item.key, confirmed: true, title: item.title, summary: item.text, reveal: "", cues: item.cues }));
		if (!items.length) {
			toast.error("请先逐条勾选「已核对原文」。");
			return;
		}
		const result = await send({ action: "adoptMany", items }, "adoptMany");
		if (!result) return;
		const skipped = result.skipped ?? [];
		markChecked(skipped.map((item) => item.key), false);
		toast.success(
			skipped.length
				? `已采用 ${result.adoptedCount ?? 0} 条，跳过 ${skipped.length} 条（${skipped[0].reason}）。`
				: `已采用 ${result.adoptedCount ?? 0} 条事件，请到第 04 步配置人物性格与精神风貌。`,
		);
		setChecked(new Set());
		setBrought(null);
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
			reveal: draft.reveal,
			cues: draft.cues,
			kind: draft.kind,
			region: draft.region,
			start: draft.start,
			end: draft.end,
			documentId: draft.documentId || undefined,
			evidence: draft.evidence,
			confirmed: draft.confirmed,
			participants: draft.participants,
			// 记事里出现但本作尚未建档的人名，保存时一并带出为待核人物。
			bringPeople: !draft.id && Boolean(draft.sourceKey?.startsWith("corpus:")),
			status: "adopted",
		};
		const result = await send(payload, "form");
		setSaving(false);
		if (result) {
			setDraft(null);
			toast.success(draft.id ? "事件已更新并采用。" : "事件已采用，参与人物已带出。");
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
	const listed = stage?.candidates ?? [];
	const selectableKeys = listed.filter((item) => !item.adopted && Boolean(item.documentId)).map((item) => item.key);
	const selectableUnchecked = selectableKeys.filter((key) => !checked.has(key));
	const selectableChecked = selectableKeys.filter((key) => checked.has(key));
	const storedKeys = data.events.filter((event) => event.status === "candidate" && inScope(event, data.scope)).map((event) => event.id ?? "");
	const storedUnchecked = storedKeys.filter((key) => !checked.has(key));
	const storedChecked = storedKeys.filter((key) => checked.has(key));
	const selectedCount = selectableChecked.length;
	const newPeople = (brought ?? []).filter((person) => !person.characterId).length;
	// 服务端限制单条事件最多 12 位参与人物，全选只补到上限，避免保存时才报错。
	const participantAdds = draft
		? data.people
				.map((person) => person.id)
				.filter((id) => !draft.participants.includes(id))
				.slice(0, Math.max(12 - draft.participants.length, 0))
		: [];

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				以事件为主：先在第 01 步的时间阶段里挑出「史料已写出人物性格与精神风貌」的记事，逐条核对原文后批量采用；
				采用时按人名去重带出人物，再到第 04 步配置性格与风貌。范围：
				{data.scope ? `${data.scope.startYear} 至 ${data.scope.endYear} 年 · ${data.scope.region}` : "尚未设定，请先在第 01 步填写"}。
			</p>

			{!data.scope && (
				<Alert>
					<AlertDescription>还没有历史范围，无法列出该阶段的记事。</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="flex items-center gap-1.5 text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
					<Layers size={12} /> 时间阶段记事 {stage ? `${stage.total} 条` : ""} · 已采用 {adopted} 条
				</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						setDraft({ ...blank, region: data.scope?.region ?? "" });
					}}
				>
					<Plus size={14} /> 手工新增
				</Button>
			</div>

			{stage && stage.kinds.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<Button size="xs" variant={kind === null ? "secondary" : "ghost"} onClick={() => setKind(null)}>
						全部品性
					</Button>
					{stage.kinds.map((item) => (
						<Button key={item.kind} size="xs" variant={kind === item.kind ? "secondary" : "ghost"} onClick={() => setKind(item.kind === kind ? null : item.kind)}>
							{item.kind} {item.count}
						</Button>
					))}
					<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<Checkbox checked={administrative} onCheckedChange={(value) => setAdministrative(value === true)} />
						显示除拜赠谥等事务性记事
					</label>
				</div>
			)}

			<div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken px-2.5 py-2">
				<p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
					<Check size={12} /> 已选 <span className="text-foreground">{selectedCount}</span> 条
					{selectedCount > 0 && (
						<>
							<Users size={12} /> 去重带出 <span className="text-foreground">{brought?.length ?? "…"}</span> 位人物
							{brought && newPeople > 0 && <span>（新增 {newPeople} 位待核）</span>}
						</>
					)}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<Button variant="ghost" size="xs" disabled={selectableUnchecked.length === 0} onClick={() => markChecked(selectableKeys, true)}>
						全部标记已核对
					</Button>
					<Button variant="ghost" size="xs" disabled={selectableChecked.length === 0} onClick={() => markChecked(selectableKeys, false)}>
						清空
					</Button>
					<Button size="xs" disabled={selectedCount === 0 || busy === "adoptMany"} onClick={() => void adoptSelected()}>
						{busy === "adoptMany" ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />} 采用所选
					</Button>
				</div>
			</div>

			{stage?.note && <p className="text-[11px] leading-relaxed text-warning">{stage.note}</p>}
			{stage && !stage.ready && (
				<Alert>
					<AlertDescription>带年纪事尚未预处理，请在终端执行 npm run corpus:years 后刷新本页。</AlertDescription>
				</Alert>
			)}

			{stageBusy ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-16" />
					<Skeleton className="h-16" />
				</div>
			) : listed.length === 0 ? (
				<p className="rounded-sm border border-dashed border-input px-3 py-6 text-center text-[12px] text-muted-foreground">
					该时间阶段没有可列出的史料记事，可换品性类别筛选、显示事务性记事，或手工新增事件。
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{listed.map((item) => {
						const verified = checked.has(item.key);
						const cannotVerify = item.adopted || !item.documentId;
						return (
							<li
								key={item.key}
								className={`flex flex-col gap-1.5 rounded-sm border px-2.5 py-2 ${verified ? "border-primary/40 bg-surface" : "border-border bg-surface"}`}
							>
								<div className="flex items-start justify-between gap-2">
									<p className="min-w-0 text-[12.5px] leading-snug text-foreground">{item.title}</p>
									<span className="flex shrink-0 items-center gap-1">
										{item.adopted && <Badge variant="success">已采用</Badge>}
										{!item.adopted && item.tier >= 2 && <Badge variant="outline">{tierText[item.tier] ?? "记事"}</Badge>}
										{!item.documentId && <Badge variant="warning">资料未固定</Badge>}
									</span>
								</div>
								<p className="text-[11px] text-muted-foreground">
									<span className="text-foreground">{astronomicalToHistorical(item.year)} 年</span>
									{item.yearLabel ? ` · ${item.yearLabel}` : ""}
									{item.period ? ` · ${item.period}` : ""} · {item.bookName}·{item.volume}
								</p>
								{/* 事件简介＝该条史料记事原文，逐字可核对。 */}
								<p className="border-l-2 border-input pl-2 text-[11.5px] leading-relaxed text-foreground/90">{item.text}</p>
								{item.cues.length > 0 && (
									<div className="flex flex-col gap-1">
										{item.cues.map((cue) => (
											<p key={`${cue.kind}-${cue.word}`} className="text-[11px] leading-relaxed text-muted-foreground">
												<Badge variant="secondary" className="mr-1.5">
													{cue.kind}
												</Badge>
												命中「{cue.word}」
												{cue.span ? <span className="text-foreground/80"> · {cue.span}</span> : ""}
											</p>
										))}
									</div>
								)}
								{item.names.length > 0 && (
									<div className="flex flex-wrap items-center gap-1">
										<span className="text-[11px] text-muted-foreground">参与人物</span>
										{item.names.map((name) => (
											<Badge key={name} variant={item.missingNames.includes(name) ? "outline" : "secondary"}>
												{name}
												{item.missingNames.includes(name) ? "（待建）" : ""}
											</Badge>
										))}
									</div>
								)}
								<div className="flex flex-wrap items-center gap-1.5">
									<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
										<Checkbox checked={verified} disabled={cannotVerify} onCheckedChange={() => toggleChecked(item.key)} />
										已核对原文确实支持该事件
									</label>
									<Button size="xs" variant="ghost" onClick={() => setDraft(draftFromStage(item, data.scope))}>
										改写后采用
									</Button>
									{item.url && (
										<a className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2" href={item.url} target="_blank" rel="noreferrer">
											查原文
										</a>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}

			{stage && listed.length < stage.total && (
				<Button size="sm" variant="outline" disabled={stageMore} onClick={() => void loadStage({ offset: listed.length })}>
					{stageMore ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />} 再载入 {Math.min(pageSize, stage.total - listed.length)} 条
				</Button>
			)}

			<Separator />

			<div className="flex items-center justify-between gap-2">
				<p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">本作品已记录 {data.events.length} 条</p>
				<span className="text-[11px] text-muted-foreground">采用后的事件与人物供第 05 步剧情提案使用</span>
			</div>

			<section className="flex flex-col gap-1.5">
				{storedKeys.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-[11px] text-muted-foreground">待核对 {storedKeys.length} 条</span>
						{/* 与记事列表同一口径：批量标记只写核对状态，采用仍逐条确认。 */}
						<Button variant="ghost" size="xs" disabled={storedUnchecked.length === 0} onClick={() => markChecked(storedKeys, true)}>
							全部标记已核对
						</Button>
						<Button variant="ghost" size="xs" disabled={storedChecked.length === 0} onClick={() => markChecked(storedKeys, false)}>
							清空
						</Button>
					</div>
				)}
				{data.events.length === 0 ? (
					<p className="rounded-sm border border-dashed border-input px-3 py-6 text-center text-[12px] text-muted-foreground">
						还没有采用任何事件。在上方时间阶段记事里逐条核对后批量采用。
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
										{event.kind === "historical" ? "历史" : "虚构"} · {yearLabel(event)}
										{event.region ? ` · ${event.region}` : ""} · {event.origin === "derived" ? "由史料记事采用" : "手工记录"}
										{!withinRange ? " · 超出当前范围" : ""}
									</p>
									{event.summary && <p className="text-[11.5px] leading-relaxed text-foreground/90 line-clamp-3">{event.summary}</p>}
									{event.reveal && (
										<p className="text-[11px] leading-relaxed text-muted-foreground">
											<span className="text-foreground">性格与风貌：</span>
											{event.reveal}
										</p>
									)}
									{event.cues.length > 0 && (
										<div className="flex flex-wrap gap-1">
											{event.cues.map((cue) => (
												<Badge key={`${cue.kind}-${cue.word}`} variant="secondary">
													{cue.kind}·{cue.word}
												</Badge>
											))}
										</div>
									)}
									{event.participants.length > 0 && (
										<div className="flex flex-wrap gap-1">
											{event.participants.map((person) => (
												<Badge key={person.id} variant="outline">
													{person.name}
												</Badge>
											))}
										</div>
									)}
									{event.evidence && (
										<p className="border-l-2 border-input pl-2 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">{event.evidence}</p>
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
				<Dialog
					open
					onOpenChange={(open) => {
						if (open) return;
						setDraft(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{draft.id ? "编辑事件" : draft.sourceKey ? "改写并采用该条记事" : "手工新增事件"}</DialogTitle>
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
								<Label htmlFor="event-summary">事件简介</Label>
								<Textarea
									id="event-summary"
									rows={3}
									maxLength={4000}
									value={draft.summary}
									placeholder="用一两句话说明事件在故事中的作用。"
									onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
								/>
							</label>
							<label className="flex flex-col gap-1.5">
								<Label htmlFor="event-reveal">该事件体现的性格与精神风貌</Label>
								<Textarea
									id="event-reveal"
									rows={2}
									maxLength={4000}
									value={draft.reveal}
									placeholder="史料里已经写出的是什么，例如：临阵不怯、单骑入营、固辞不受。"
									onChange={(event) => setDraft({ ...draft, reveal: event.target.value })}
								/>
							</label>
							{draft.cues.length > 0 && (
								<div className="flex flex-wrap gap-1">
									{draft.cues.map((cue) => (
										<Badge key={`${cue.kind}-${cue.word}`} variant="secondary">
											{cue.kind}·{cue.word}
										</Badge>
									))}
								</div>
							)}
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
									<div className="flex flex-wrap items-center gap-1.5">
										<Button
											variant="ghost"
											size="xs"
											disabled={saving || participantAdds.length === 0}
											onClick={() => setDraft({ ...draft, participants: [...draft.participants, ...participantAdds] })}
										>
											全选
										</Button>
										<Button
											variant="ghost"
											size="xs"
											disabled={saving || draft.participants.length === 0}
											onClick={() => setDraft({ ...draft, participants: [] })}
										>
											清空
										</Button>
									</div>
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
								{yearLabel(verifyTarget)}
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
