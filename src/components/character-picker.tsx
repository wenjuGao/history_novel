"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { astronomicalToHistorical } from "@/lib/history-time";

type Person = {
	id: string;
	name: string;
	evidence: string;
	source: string;
	selected: number;
	match: boolean;
	region: string | null;
	start: number | null;
	end: number | null;
};
type Fiction = { id: string; kind: string; title: string; content: string };
type Relation = {
	id: string;
	from: string;
	to: string;
	label: string;
	evidence: string;
	sourceId: string;
	/** auto 线索无代填时间；核对确认后才补齐并进入关系图。 */
	start: number | null;
	end: number | null;
	reviewStatus: string;
};
type Report = {
	groups: string[][];
	pairs: Array<{ from: string; to: string; truncated: boolean; paths: Array<{ people: string[]; edges: string[] }> }>;
	note: string;
};
type Data = {
	people: Person[];
	scope: { start: number; end: number; region: string } | null;
	sources: Array<{ id: string; title: string }>;
	fiction: Fiction[];
	relations: Relation[];
	report: Report | null;
};

type EvidenceDraft = { documentId: string; evidence: string; start: string; end: string; confirmed: boolean };

type CorpusPerson = {
	name: string;
	mentions: number;
	volumeHits: number;
	bookCount: number;
	strong: boolean;
	evidence: string;
	evidenceBookName: string;
	evidenceVolume: string;
	evidenceUrl: string;
	imported: boolean;
};

type PersonsData = { defaults: string[]; blocked: string[]; candidates: CorpusPerson[] };
type AutoRun = { status: string; steps: Array<{ key: string; ok: boolean; detail: string }> };

const emptyEvidence: EvidenceDraft = { documentId: "", evidence: "", start: "", end: "", confirmed: false };
const blankFiction = { id: "", kind: "人物", title: "", content: "" };
const fictionKinds = ["人物", "关系", "对白", "心理", "日常场景"];

export function CharacterPicker({
	projectId,
	refresh = 0,
	onChanged,
}: {
	projectId: string;
	refresh?: number;
	onChanged?: () => void;
}) {
	const [data, setData] = useState<Data | null>(null);
	const [revision, setRevision] = useState(0);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [fiction, setFiction] = useState(blankFiction);
	const [person, setPerson] = useState({ name: "", region: "", ...emptyEvidence });
	const [relation, setRelation] = useState({ from: "", to: "", label: "", ...emptyEvidence });
	const [persons, setPersons] = useState<PersonsData | null>(null);
	const [picked, setPicked] = useState<string[]>([]);
	const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
	const [autoBusy, setAutoBusy] = useState(false);
	const [clueDrafts, setClueDrafts] = useState<Record<string, { start: string; end: string; confirmed: boolean }>>({});

	useEffect(() => {
		const controller = new AbortController();
		fetch(`/api/projects/${projectId}/setup`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const result = (await response.json()) as Data & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "读取失败。");
				return result;
			})
			.then((result) => {
				setData(result);
				setError("");
			})
			.catch((cause: unknown) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setError(cause instanceof Error ? cause.message : "读取失败，请刷新重试。");
			});
		return () => controller.abort();
	}, [projectId, revision, refresh]);

	useEffect(() => {
		const controller = new AbortController();
		fetch(`/api/projects/${projectId}/persons?limit=60`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const result = (await response.json()) as PersonsData & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "无法读取史料人物。");
				return result;
			})
			.then((result) => {
				setPersons(result);
				// 默认勾选索引判定为强关联的人物；已导入的不再留在勾选里。
				setPicked((current) =>
					current.length
						? current.filter((name) => result.candidates.some((item) => item.name === name && !item.imported))
						: result.defaults,
				);
			})
			.catch((cause: unknown) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setPersons(null);
			});
		return () => controller.abort();
	}, [projectId, revision, refresh]);

	const selectedCount = data?.people.filter((item) => item.selected).length ?? 0;

	const save = useCallback(
		async (body: Record<string, unknown>) => {
			setBusy(true);
			setMessage("");
			setError("");
			try {
				const response = await fetch(`/api/projects/${projectId}/setup`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const result = (await response.json()) as { error?: string };
				if (!response.ok) throw new Error(result.error ?? "保存失败。");
				setRevision((value) => value + 1);
				onChanged?.();
				setMessage("已保存到本机。");
				return true;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "保存失败。");
				return false;
			} finally {
				setBusy(false);
			}
		},
		[projectId, onChanged],
	);

	const postPersons = useCallback(
		async (body: Record<string, unknown>) => {
			setBusy(true);
			setMessage("");
			setError("");
			try {
				const response = await fetch(`/api/projects/${projectId}/persons`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const result = (await response.json()) as {
					inserted?: string[];
					skipped?: Array<{ name: string; reason: string }>;
					error?: string;
				};
				if (!response.ok) throw new Error(result.error ?? "史料人物操作失败。");
				setRevision((value) => value + 1);
				onChanged?.();
				setMessage(
					result.inserted
						? `已导入 ${result.inserted.length} 位史料人物${result.skipped?.length ? `，跳过 ${result.skipped.length} 位` : ""}。`
						: "史料人物列表已更新。",
				);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "史料人物操作失败。");
			} finally {
				setBusy(false);
			}
		},
		[projectId, onChanged],
	);

	const generateFromCorpus = useCallback(async () => {
		if (!data?.scope) {
			setError("请先在第 01 步保存历史范围。");
			return;
		}
		setAutoBusy(true);
		setMessage("");
		setError("");
		setAutoRun(null);
		try {
			const response = await fetch(`/api/projects/${projectId}/auto`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "generate",
					startYear: astronomicalToHistorical(data.scope.start),
					endYear: astronomicalToHistorical(data.scope.end),
					region: data.scope.region,
					characterNames: picked.length ? picked : undefined,
				}),
			});
			const result = (await response.json()) as { run?: AutoRun; error?: string };
			if (!response.ok) throw new Error(result.error ?? "自动生成失败。");
			setAutoRun(result.run ?? null);
			setRevision((value) => value + 1);
			onChanged?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "自动生成失败。");
		} finally {
			setAutoBusy(false);
		}
	}, [data, picked, projectId, onChanged]);

	const nameOf = (id: string) => data?.people.find((item) => item.id === id)?.name ?? id;
	const year = (value: number | null) => (value === null ? "未知" : String(astronomicalToHistorical(value)));
	const sourceTitle = (id: string) => data?.sources.find((item) => item.id === id)?.title ?? "未知";

	function evidenceBlock(
		idPrefix: string,
		draft: EvidenceDraft,
		patch: (next: Partial<EvidenceDraft>) => void,
	) {
		return (
			<>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-document`}>历史资料</Label>
					<Select value={draft.documentId || undefined} onValueChange={(value) => patch({ documentId: value })}>
						<SelectTrigger id={`${idPrefix}-document`} className="h-9">
							<SelectValue placeholder="选择资料" />
						</SelectTrigger>
						<SelectContent>
							{data?.sources.map((source) => (
								<SelectItem key={source.id} value={source.id}>
									{source.title}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-evidence`}>原文证据</Label>
					<Textarea
						id={`${idPrefix}-evidence`}
						rows={3}
						maxLength={1000}
						value={draft.evidence}
						onChange={(event) => patch({ evidence: event.target.value })}
					/>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${idPrefix}-start`}>起始年份</Label>
						<Input
							id={`${idPrefix}-start`}
							type="number"
							min={-10000}
							max={10000}
							value={draft.start}
							onChange={(event) => patch({ start: event.target.value })}
							className="h-9"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${idPrefix}-end`}>结束年份</Label>
						<Input
							id={`${idPrefix}-end`}
							type="number"
							min={-10000}
							max={10000}
							value={draft.end}
							onChange={(event) => patch({ end: event.target.value })}
							className="h-9"
						/>
					</div>
				</div>
				<label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
					<Checkbox
						className="mt-0.5"
						checked={draft.confirmed}
						onCheckedChange={(value) => patch({ confirmed: value === true })}
					/>
					<span>我已核对原文支持所填活动时间、区域或人物关系</span>
				</label>
			</>
		);
	}

	if (!data) {
		return (
			<div className="flex flex-col gap-2" role="status" aria-label="正在读取人物与关系">
				<Skeleton className="h-8" />
				<Skeleton className="h-20" />
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
			</div>
		);
	}

	const matched = data.people.filter((item) => item.match || item.selected);
	const unmatched = data.people.filter((item) => !item.match);
	const evidenceReady = (draft: EvidenceDraft) => Boolean(draft.documentId && draft.evidence.trim() && draft.start && draft.end && draft.confirmed);

	return (
		<div className="flex flex-col gap-4">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				候选人物来自你核定的活动证据。区域按名称匹配，多个区域用顿号分隔；公元前年份填负数，没有公元 0 年。
			</p>

			{message && <p role="status" className="text-[11px] text-success">{message}</p>}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{data.scope
					? `当前范围：${year(data.scope.start)} 至 ${year(data.scope.end)} 年 · ${data.scope.region}`
					: "请先在第 01 步保存历史范围。"}
			</p>

			<section className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken/60 p-3">
				<div className="flex items-center justify-between gap-2">
					<h4 className="text-[13px] font-medium">史料人物候选</h4>
					<Badge variant={persons ? "outline" : "warning"}>
						{persons ? `强关联 ${persons.candidates.filter((item) => item.strong).length} / ${persons.candidates.length}` : "索引未就绪"}
					</Badge>
				</div>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					由本机古籍索引按名称与动词邻接得到，零 Token；默认勾选存在强关联的人物。勾选与导入都只是候选，原文证据仍需人工核对。
				</p>

				{!persons ? (
					<Skeleton className="h-16" />
				) : persons.candidates.length === 0 ? (
					<p className="text-[12px] leading-relaxed text-muted-foreground">
						当前时间阶段没有史料人物候选，请在终端执行 npm run corpus:persons 后刷新。
					</p>
				) : (
					<ul className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto pr-1">
						{persons.candidates.map((item) => (
							<li className="rounded-md border border-border bg-surface p-2.5" key={item.name}>
								<label className="flex items-start gap-2">
									<Checkbox
										className="mt-0.5"
										disabled={busy || autoBusy || item.imported}
										checked={item.imported || picked.includes(item.name)}
										onCheckedChange={(value) =>
											setPicked((current) =>
												value === true ? [...new Set([...current, item.name])] : current.filter((name) => name !== item.name),
											)
										}
									/>
									<span className="min-w-0 flex-1 text-[12px] leading-snug">
										<strong className="font-medium">{item.name}</strong>
										<span className="text-muted-foreground">
											{" "}
											· 提及 {item.mentions} 次 / {item.volumeHits} 卷
											{item.bookCount > 1 ? ` / ${item.bookCount} 部` : ""}
										</span>
										{item.strong && (
											<Badge variant="success" className="ml-1.5 align-middle">
												强关联
											</Badge>
										)}
										{item.imported && (
											<Badge variant="outline" className="ml-1.5 align-middle">
												已导入
											</Badge>
										)}
									</span>
								</label>
								<p className="pl-6 pt-1 text-[11px] leading-relaxed text-muted-foreground">
									{item.evidence || "没有可比对的原文片段"}
									{item.evidenceBookName ? ` —— ${item.evidenceBookName}${item.evidenceVolume ? `·${item.evidenceVolume}` : ""}` : ""}
								</p>
								<div className="flex items-center gap-3 pl-6 pt-1">
									{item.evidenceUrl && (
										<a
											className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2"
											href={item.evidenceUrl}
											target="_blank"
											rel="noreferrer"
										>
											查原文
										</a>
									)}
									<button
										type="button"
										className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2"
										disabled={busy || autoBusy}
										onClick={() => void postPersons({ action: "block", names: [item.name] })}
									>
										不再显示
									</button>
								</div>
							</li>
						))}
					</ul>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy || autoBusy || picked.length === 0}
						onClick={() => void postPersons({ action: "import", names: picked, selectedNames: picked })}
					>
						导入勾选 {picked.length} 位
					</Button>
					<Button type="button" size="sm" disabled={busy || autoBusy || !data.scope || picked.length === 0} onClick={() => void generateFromCorpus()}>
						{autoBusy && <LoaderCircle size={14} className="animate-spin" />}
						确认范围与人物并自动生成
					</Button>
				</div>

				{autoRun && (
					<ul className="flex flex-col gap-1" aria-live="polite">
						{autoRun.steps.map((step) => (
							<li className="flex items-start gap-2 text-[11px] leading-relaxed" key={step.key}>
								<Badge variant={step.ok ? "success" : "warning"}>{step.key}</Badge>
								<span className="min-w-0 flex-1 text-muted-foreground">{step.detail}</span>
							</li>
						))}
						<li className="text-[11px] text-muted-foreground">
							自动生成只写人物、关系、事件与本地骨架大纲；章节正文仍需逐章人工批准。
						</li>
					</ul>
				)}

				{persons && persons.blocked.length > 0 && (
					<details className="rounded-md border border-border bg-surface px-3 py-2">
						<summary className="cursor-pointer text-[12px] text-muted-foreground">已忽略 {persons.blocked.length} 位候选</summary>
						<ul className="mt-2 flex flex-wrap gap-2">
							{persons.blocked.map((name) => (
								<li key={name}>
									<button
										type="button"
										className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2"
										disabled={busy || autoBusy}
										onClick={() => void postPersons({ action: "unblock", names: [name] })}
									>
										恢复 {name}
									</button>
								</li>
							))}
						</ul>
					</details>
				)}
			</section>

			<Separator />

			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<h4 className="text-[13px] font-medium">匹配当前范围的人物</h4>
					<Badge variant={selectedCount ? "success" : "outline"}>已选 {selectedCount}</Badge>
				</div>
				{matched.length === 0 && (
					<p className="text-[12px] leading-relaxed text-muted-foreground">
						当前资料没有匹配人物。请导入历史资料并补充活动证据；原文已采集不等于人物已经核定。
					</p>
				)}
				<ul className="flex flex-col gap-1.5">
					{matched.map((item) => (
						<li className="flex flex-col gap-1 rounded-md border border-border bg-surface p-2.5" key={item.id}>
							<label className="flex items-start gap-2">
								<Checkbox
									className="mt-0.5"
									disabled={busy}
									checked={!!item.selected}
									onCheckedChange={(value) => void save({ action: "select", id: item.id, selected: value === true })}
								/>
								<span className="min-w-0 flex-1 text-[12px] leading-snug">
									<strong className="font-medium">{item.name}</strong>
									<span className="text-muted-foreground">
										{" "}
										· {item.region ?? "区域未知"} · {year(item.start)}—{year(item.end)}
									</span>
									{!item.match && <span className="ml-1 text-[11px] text-warning">（不再匹配，请取消或调整范围）</span>}
								</span>
							</label>
							<p className="pl-6 text-[11px] leading-relaxed text-muted-foreground">
								出处：{item.source}；{item.evidence}
							</p>
						</li>
					))}
				</ul>

				{unmatched.length > 0 && (
					<details className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2">
						<summary className="cursor-pointer text-[12px] text-muted-foreground">
							未匹配或证据不足的人物（{unmatched.length}）
						</summary>
						<ul className="mt-2 flex flex-col gap-1">
							{unmatched.map((item) => (
								<li className="text-[11px] leading-relaxed text-muted-foreground" key={item.id}>
									<strong className="text-foreground">{item.name}</strong>：{item.region ?? "缺少活动区域"}，
									{year(item.start)}—{year(item.end)}；{item.evidence}
								</li>
							))}
						</ul>
					</details>
				)}
			</section>

			{data.relations.filter((rel) => rel.reviewStatus === "auto").length > 0 && (
				<section className="flex flex-col gap-2">
					<h4 className="text-[13px] font-medium">
						待核关系线索（{data.relations.filter((rel) => rel.reviewStatus === "auto").length}）
					</h4>
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						同段共现只说明两人在同一叙事段落出现，不等于实际交往。核对原文、补关系起止年份并确认后，才进入关系图、事件候选与生成上下文。
					</p>
					<ul className="flex flex-col gap-2">
						{data.relations
							.filter((rel) => rel.reviewStatus === "auto")
							.map((rel) => {
								const draft = clueDrafts[rel.id] ?? { start: "", end: "", confirmed: false };
								const ready = draft.confirmed && draft.start && draft.end;
								return (
									<li key={rel.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5">
										<strong className="text-[12px]">
											{nameOf(rel.from)} ↔ {nameOf(rel.to)}
										</strong>
										<p className="text-[11px] text-muted-foreground">{rel.label}</p>
										<p className="border-l-2 border-input pl-2 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
											{rel.evidence}（出处：{sourceTitle(rel.sourceId)}）
										</p>
										<div className="flex flex-wrap items-center gap-2">
											<Input
												type="number"
												placeholder="起（如 -202）"
												className="h-8 w-28"
												value={draft.start}
												onChange={(event) => setClueDrafts({ ...clueDrafts, [rel.id]: { ...draft, start: event.target.value } })}
											/>
											<Input
												type="number"
												placeholder="止（如 -195）"
												className="h-8 w-28"
												value={draft.end}
												onChange={(event) => setClueDrafts({ ...clueDrafts, [rel.id]: { ...draft, end: event.target.value } })}
											/>
											<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
												<Checkbox
													checked={draft.confirmed}
													onCheckedChange={(checked) =>
														setClueDrafts({ ...clueDrafts, [rel.id]: { ...draft, confirmed: checked === true } })
													}
												/>
												已核对原文确实支持该关系
											</label>
											<Button
												size="xs"
												disabled={busy || !ready}
												onClick={() =>
													void save({
														action: "confirmRelation",
														id: rel.id,
														start: draft.start,
														end: draft.end,
														confirmed: draft.confirmed,
													})
												}
											>
												核对并确认
											</Button>
											<Button
												size="xs"
												variant="ghost"
												className="text-destructive"
												disabled={busy}
												onClick={() => void save({ action: "rejectRelation", id: rel.id })}
											>
												<Trash2 size={12} /> 移除线索
											</Button>
										</div>
									</li>
								);
							})}
					</ul>
				</section>
			)}

			<section className="flex flex-col gap-2" aria-live="polite">
				<h4 className="text-[13px] font-medium">历史关联检查</h4>
				{selectedCount < 2 ? (
					<p className="text-[12px] text-muted-foreground">选择至少两个人物后查看关联。</p>
				) : !data.report ? (
					<p className="text-[12px] text-muted-foreground">请先保存历史范围。</p>
				) : (
					<>
						{data.report.groups.length > 1 && (
							<Alert>
								<AlertDescription>
									当前资料未找到部分人物之间的关联。你可以换人、补充史料、保留平行叙事，或新增虚构联系继续创作。
								</AlertDescription>
							</Alert>
						)}
						<div className="flex flex-wrap gap-1.5">
							{data.report.groups.map((group, index) => (
								<Badge variant="secondary" key={index}>
									人物组 {index + 1}：{group.map(nameOf).join("、")}
								</Badge>
							))}
						</div>
						{data.report.pairs.map((pair) => (
							<div
								className="flex flex-col gap-1 rounded-md border border-border bg-surface p-2.5"
								key={`${pair.from}-${pair.to}`}
							>
								<strong className="text-[12px]">
									{nameOf(pair.from)} ↔ {nameOf(pair.to)}
								</strong>
								{pair.paths.map((path, index) => (
									<div className="text-[11px] leading-relaxed text-muted-foreground" key={index}>
										<p className="text-foreground">{path.people.map(nameOf).join(" → ")}</p>
										{path.edges.map((edge) => {
											const item = data.relations.find((rel) => rel.id === edge);
											if (!item) return null;
											return (
												<p key={edge}>
													{nameOf(item.from)} → {nameOf(item.to)}（{item.label}，{year(item.start)}—
													{year(item.end)}，出处：{sourceTitle(item.sourceId)}）：{item.evidence}
												</p>
											);
										})}
									</div>
								))}
								{pair.paths.length === 0 && (
									<p className="text-[11px] text-muted-foreground">
										{pair.truncated ? "检索达到上限，暂不能判断。" : "当前资料未找到关联。"}
									</p>
								)}
							</div>
						))}
						<p className="text-[11px] leading-relaxed text-muted-foreground">
							{data.report.note}虚构关系不会消除史实关联缺口。
						</p>
					</>
				)}
			</section>

			<details className="rounded-md border border-border px-3 py-2">
				<summary className="cursor-pointer text-[12px] font-medium">补充并核定人物活动证据</summary>
				{data.sources.length === 0 ? (
					<p className="mt-2 text-[11px] text-muted-foreground">请先在第 02 步导入历史资料。</p>
				) : (
					<div className="mt-3 flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="person-name">人物名称</Label>
							<Input
								id="person-name"
								maxLength={80}
								value={person.name}
								onChange={(event) => setPerson({ ...person, name: event.target.value })}
								className="h-9"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="person-region">活动区域</Label>
							<Input
								id="person-region"
								maxLength={200}
								placeholder="如：关中（出生地不能替代活动地）"
								value={person.region}
								onChange={(event) => setPerson({ ...person, region: event.target.value })}
								className="h-9"
							/>
						</div>
						{evidenceBlock("person", person, (next) => setPerson({ ...person, ...next }))}
						<Button
							size="sm"
							className="self-start"
							disabled={
								busy || !person.name.trim() || !person.region.trim() || !evidenceReady(person)
							}
							onClick={() =>
								void save({
									action: "person",
									name: person.name,
									region: person.region,
									documentId: person.documentId,
									evidence: person.evidence,
									start: Number(person.start),
									end: Number(person.end),
									confirmed: true,
								}).then((ok) => {
									if (ok) setPerson({ name: "", region: "", ...emptyEvidence });
								})
							}
						>
							{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={15} />} 保存人物候选项
						</Button>
					</div>
				)}
			</details>

			<details className="rounded-md border border-border px-3 py-2">
				<summary className="cursor-pointer text-[12px] font-medium">补充并核定历史人物关系</summary>
				{data.people.length < 2 || data.sources.length === 0 ? (
					<p className="mt-2 text-[11px] text-muted-foreground">请先添加至少两个人物并导入历史资料。</p>
				) : (
					<div className="mt-3 flex flex-col gap-3">
						<div className="grid grid-cols-2 gap-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="relation-from">起点人物</Label>
								<Select value={relation.from || undefined} onValueChange={(value) => setRelation({ ...relation, from: value })}>
									<SelectTrigger id="relation-from" className="h-9">
										<SelectValue placeholder="选择人物" />
									</SelectTrigger>
									<SelectContent>
										{data.people.map((item) => (
											<SelectItem key={item.id} value={item.id}>
												{item.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="relation-to">终点人物</Label>
								<Select value={relation.to || undefined} onValueChange={(value) => setRelation({ ...relation, to: value })}>
									<SelectTrigger id="relation-to" className="h-9">
										<SelectValue placeholder="选择人物" />
									</SelectTrigger>
									<SelectContent>
										{data.people.map((item) => (
											<SelectItem key={item.id} value={item.id}>
												{item.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="relation-label">关系类型</Label>
							<Input
								id="relation-label"
								maxLength={80}
								placeholder="例如：师生、同僚"
								value={relation.label}
								onChange={(event) => setRelation({ ...relation, label: event.target.value })}
								className="h-9"
							/>
						</div>
						{evidenceBlock("relation", relation, (next) => setRelation({ ...relation, ...next }))}
						<Button
							size="sm"
							className="self-start"
							disabled={
								busy ||
								!relation.from ||
								!relation.to ||
								relation.from === relation.to ||
								!relation.label.trim() ||
								!evidenceReady(relation)
							}
							onClick={() =>
								void save({
									action: "relation",
									from: relation.from,
									to: relation.to,
									label: relation.label,
									documentId: relation.documentId,
									evidence: relation.evidence,
									start: Number(relation.start),
									end: Number(relation.end),
									confirmed: true,
								}).then((ok) => {
									if (ok) setRelation({ from: "", to: "", label: "", ...emptyEvidence });
								})
							}
						>
							{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={15} />} 保存历史关系
						</Button>
					</div>
				)}
			</details>

			<Separator />

			<section className="flex flex-col gap-3">
				<h4 className="text-[13px] font-medium">虚构设定</h4>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					允许新增人物、关系、对白、心理和日常场景，统一标记为虚构，不改写原始史料。保存设定不代表已通过史实冲突审核。
				</p>

				<div className="flex flex-col gap-3">
					<div className="grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="fiction-kind">类别</Label>
							<Select value={fiction.kind} onValueChange={(value) => setFiction({ ...fiction, kind: value })}>
								<SelectTrigger id="fiction-kind" className="h-9">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{fictionKinds.map((kind) => (
										<SelectItem key={kind} value={kind}>
											{kind}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="fiction-title">名称或标题</Label>
							<Input
								id="fiction-title"
								maxLength={80}
								value={fiction.title}
								onChange={(event) => setFiction({ ...fiction, title: event.target.value })}
								className="h-9"
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="fiction-content">内容</Label>
						<Textarea
							id="fiction-content"
							rows={3}
							maxLength={10000}
							value={fiction.content}
							onChange={(event) => setFiction({ ...fiction, content: event.target.value })}
						/>
					</div>
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							disabled={busy || !fiction.title.trim() || !fiction.content.trim()}
							onClick={() =>
								void save({ ...fiction, action: "fiction" }).then((ok) => ok && setFiction(blankFiction))
							}
						>
							{fiction.id ? "保存修改" : "新增虚构设定"}
						</Button>
						{fiction.id && (
							<Button variant="ghost" size="sm" onClick={() => setFiction(blankFiction)}>
								取消编辑
							</Button>
						)}
					</div>
				</div>

				{data.fiction.length > 0 && (
					<ul className="flex flex-col gap-2">
						{data.fiction.map((item) => (
							<li className="flex flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5" key={item.id}>
								<div className="flex items-center justify-between gap-2">
									<Badge variant="secondary">虚构 · {item.kind}</Badge>
									<div className="flex items-center gap-1">
										<Button variant="ghost" size="icon-xs" aria-label={`编辑 ${item.title}`} disabled={busy} onClick={() => setFiction(item)}>
											<Pencil size={13} />
										</Button>
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`删除 ${item.title}`}
											disabled={busy}
											onClick={() =>
												void save({ action: "deleteFiction", id: item.id }).then((ok) => {
													if (ok && fiction.id === item.id) setFiction(blankFiction);
												})
											}
										>
											<Trash2 size={13} />
										</Button>
									</div>
								</div>
								<strong className="text-[12px]">{item.title}</strong>
								<p className="text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{item.content}</p>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
