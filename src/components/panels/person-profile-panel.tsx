"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, RotateCcw, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { astronomicalToHistorical } from "@/lib/history-time";

type Cue = { kind: string; word: string; span: string };
type PersonEvent = { id: string; title: string; start: number; end: number; evidence: string; reveal: string; cues: Cue[] };
type Person = {
	id: string;
	name: string;
	selected: number;
	reviewStatus: string;
	personality: string;
	temperament: string;
	profileSource: string;
	evidence: string;
	documentTitle: string | null;
	firstYear: number | null;
	lastYear: number | null;
	events: PersonEvent[];
};
type Preview = { count: number; names: string[]; eventCount: number; characters: number; model: string | null; blocked: string | null };
type Data = {
	persons: Person[];
	blocked: string | null;
	preview: Preview;
	allowExternalTransfer: boolean;
	pending: number;
	withoutProfile: number;
};

const sourceText: Record<string, string> = { manual: "作者已写", model: "模型待核", "": "线索落底" };

function yearRange(person: Person) {
	if (person.firstYear === null || person.lastYear === null) return "年代待核";
	const from = astronomicalToHistorical(person.firstYear);
	const to = astronomicalToHistorical(person.lastYear);
	return from === to ? `${from < 0 ? `公元前${-from}` : `公元${from}`}年` : `${from < 0 ? `公元前${-from}` : `公元${from}`}—${to < 0 ? `公元前${-to}` : `公元${to}`}年`;
}

export function PersonProfilePanel({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
	const [data, setData] = useState<Data | null>(null);
	const [failed, setFailed] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [edits, setEdits] = useState<Record<string, { personality: string; temperament: string }>>({});
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [confirming, setConfirming] = useState(false);
	const [externalTransfer, setExternalTransfer] = useState(false);

	const load = useCallback(async () => {
		const response = await fetch(`/api/projects/${projectId}/profiles`, { cache: "no-store" });
		const payload = (await response.json()) as Data & { error?: string };
		if (!response.ok || payload.error) throw new Error(payload.error ?? "无法读取事件带出的人物。");
		setData(payload);
		setEdits({});
		setFailed("");
	}, [projectId]);

	useEffect(() => {
		let alive = true;
		setBusy("load");
		void load().catch((cause: unknown) => {
			if (alive) setFailed(cause instanceof Error ? cause.message : "无法读取事件带出的人物。");
		})
			.finally(() => {
				if (alive) setBusy(null);
			});
		return () => {
			alive = false;
		};
	}, [load]);

	async function send(payload: Record<string, unknown>, key: string) {
		setBusy(key);
		try {
			const response = await fetch(`/api/projects/${projectId}/profiles`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json()) as Data & { error?: string; carryOver?: { created: string[]; reused: string[]; skipped: Array<{ name: string; reason: string }> } };
			if (!response.ok || result.error) {
				toast.error(result.error ?? "保存失败。");
				return null;
			}
			setData(result);
			setFailed("");
			onChanged?.();
			return result;
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "网络异常，请重试。");
			return null;
		} finally {
			setBusy(null);
		}
	}

	function edit(person: Person) {
		const draft = edits[person.id];
		return { personality: draft?.personality ?? person.personality, temperament: draft?.temperament ?? person.temperament };
	}

	function togglePick(name: string) {
		setPicked((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	const pendingNames = useMemo(() => (data?.persons ?? []).filter((person) => person.selected === 1 && !person.personality.trim() && !person.temperament.trim()).map((person) => person.name), [data]);
	const batchNames = useMemo(() => (picked.size ? [...picked] : pendingNames), [picked, pendingNames]);
	const preview = useMemo(() => {
		if (!data) return null;
		const wanted = new Set(batchNames);
		const rows = data.preview.names.filter((name) => wanted.has(name));
		const chars = data.preview.characters * (data.preview.count ? rows.length / data.preview.count : 0);
		return { count: rows.length, characters: Math.round(chars) };
	}, [data, batchNames]);

	if (failed && !data) {
		return (
			<Alert>
				<AlertDescription>{failed}</AlertDescription>
			</Alert>
		);
	}
	if (!data) {
		return (
			<div className="flex flex-col gap-2">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} className="h-24 w-full" />
				))}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				人物由第 03 步采用的史料事件带出：同名记事已去重，证据就是那条记事原文。下面逐位写性格与精神风貌，未写的可先用线索落底的初稿，再让模型按事件归纳。
			</p>

			{failed && (
				<Alert>
					<AlertDescription>{failed}</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken px-2.5 py-2">
				<p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
					<Users size={12} /> 事件带出 <span className="text-foreground">{data.persons.length}</span> 位
					<span>（待核 {data.pending} · 未配置 {data.withoutProfile}）</span>
					{picked.size > 0 && <span>· 已勾 {picked.size} 位</span>}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<Button size="xs" variant="outline" disabled={busy === "carry"} onClick={() => void send({ action: "carry" }, "carry").then((result) => result && toast.success(`已带出 ${result.carryOver?.created.length ?? 0} 位新人物。`))}>
						{busy === "carry" ? <LoaderCircle size={12} className="animate-spin" /> : <RotateCcw size={12} />} 重新带出人物
					</Button>
					{!data.blocked && (
						<Button size="xs" disabled={batchNames.length === 0 || busy === "generate"} onClick={() => setConfirming(true)}>
							{busy === "generate" ? <LoaderCircle size={12} className="animate-spin" /> : <Sparkles size={12} />} AI 批量生成
						</Button>
					)}
				</div>
			</div>

			{data.blocked && (
				<Alert>
					<AlertDescription>{data.blocked}</AlertDescription>
				</Alert>
			)}

			{data.persons.length === 0 ? (
				<Alert>
					<AlertDescription>还没有事件带出的人物，请先在第 03 步勾选并采用史料记事。</AlertDescription>
				</Alert>
			) : (
				data.persons.map((person) => {
					const draft = edit(person);
					const dirty = draft.personality !== person.personality || draft.temperament !== person.temperament;
					return (
						<article key={person.id} className="flex flex-col gap-2.5 rounded-sm border border-border bg-background px-3 py-2.5">
							<header className="flex flex-wrap items-center justify-between gap-2">
								<div className="flex flex-wrap items-center gap-2">
									<Checkbox checked={picked.has(person.name)} onCheckedChange={() => togglePick(person.name)} aria-label={`勾选${person.name}`} />
									<h3 className="text-[14px] font-medium">{person.name}</h3>
									<Badge variant="outline">{yearRange(person)}</Badge>
									<Badge variant="outline">{person.events.length} 条事件</Badge>
									{person.reviewStatus === "auto" && <Badge variant="secondary">待核</Badge>}
									{person.selected === 0 && <Badge variant="secondary">未选入</Badge>}
									<span className="text-[11px] text-muted-foreground">{sourceText[person.profileSource] ?? person.profileSource}</span>
								</div>
								<div className="flex flex-wrap items-center gap-1.5">
									{person.reviewStatus === "auto" && (
										<Button size="xs" variant="ghost" disabled={busy === `confirm-${person.id}`} onClick={() => void send({ action: "confirm", id: person.id }, `confirm-${person.id}`).then((ok) => ok && toast.success(`${person.name} 已核对。`))}>
											<Check size={12} /> 核对无误
										</Button>
									)}
									<Button
										size="xs"
										disabled={!dirty || busy === `save-${person.id}`}
										onClick={() =>
											void send({ action: "save", id: person.id, personality: draft.personality, temperament: draft.temperament }, `save-${person.id}`).then((ok) => {
												if (ok) {
													setEdits((current) => {
														const next = { ...current };
														delete next[person.id];
														return next;
													});
													toast.success(`${person.name} 的性格与风貌已保存。`);
												}
											})
										}
									>
										{busy === `save-${person.id}` ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />} 保存
									</Button>
								</div>
							</header>

							{person.evidence && <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{person.evidence}</p>}

							<div className="grid gap-2.5 md:grid-cols-2">
								<Label className="flex flex-col gap-1.5 text-[11.5px] text-muted-foreground">
									性格
									<Textarea
										rows={3}
										value={draft.personality}
										onChange={(event) => setEdits((current) => ({ ...current, [person.id]: { ...edit(person), personality: event.target.value } }))}
										placeholder="由记事归纳的行事倾向"
									/>
								</Label>
								<Label className="flex flex-col gap-1.5 text-[11.5px] text-muted-foreground">
									精神风貌
									<Textarea
										rows={3}
										value={draft.temperament}
										onChange={(event) => setEdits((current) => ({ ...current, [person.id]: { ...edit(person), temperament: event.target.value } }))}
										placeholder="气度、节操与时代气质"
									/>
								</Label>
							</div>

							{person.events.length > 0 && (
								<details className="text-[11.5px] text-muted-foreground">
									<summary className="cursor-pointer">查看依据的 {person.events.length} 条记事</summary>
									<ul className="mt-1.5 flex flex-col gap-1.5">
										{person.events.map((event) => (
											<li key={event.id} className="flex flex-col gap-1 rounded-sm border border-border px-2 py-1.5">
												<p className="text-foreground">
													{astronomicalToHistorical(event.start) < 0 ? `公元前${-astronomicalToHistorical(event.start)}` : `公元${astronomicalToHistorical(event.start)}`}年 · {event.title}
												</p>
												<p className="leading-relaxed">{event.evidence}</p>
												{event.cues.length > 0 && <p className="text-muted-foreground">{event.cues.map((cue) => `${cue.kind}「${cue.word}」`).join("、")}</p>}
											</li>
										))}
									</ul>
								</details>
							)}
						</article>
					);
				})
			)}

			{confirming && (
				<Dialog open onOpenChange={(open) => !open && !busy && setConfirming(false)}>
					<DialogContent className="max-w-lg">
						<DialogHeader>
							<DialogTitle>确认外发并生成性格与风貌</DialogTitle>
							<DialogDescription>模型只依据下列已核对的事件记事归纳，结果标为「模型待核」，不覆盖你已写好的描述。</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-2 text-[12px] leading-relaxed">
							<p>
								本次生成 <span className="text-foreground">{preview?.count ?? 0}</span> 位人物，外发内容约{" "}
								<span className="text-foreground">{preview?.characters ?? 0}</span> 字符，模型 {data.preview.model ?? "未配置"}。
							</p>
							<p className="text-muted-foreground">{batchNames.slice(0, 20).join("、")}{batchNames.length > 20 ? ` 等 ${batchNames.length} 位` : ""}</p>
							<label className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
								<Checkbox className="mt-0.5" checked={externalTransfer} onCheckedChange={(value) => setExternalTransfer(value === true)} />
								<span>我确认把上述记事原文发送到百炼生成待核初稿；模型稿不覆盖我已写好的描述。</span>
							</label>
						</div>
						<DialogFooter>
							<Button size="sm" variant="outline" disabled={busy === "generate"} onClick={() => setConfirming(false)}>
								取消
							</Button>
							<Button
								size="sm"
								disabled={busy === "generate" || batchNames.length === 0 || !externalTransfer}
								onClick={() => {
									setConfirming(false);
									void send({ action: "generate", names: picked.size ? [...picked] : [], allowExternalTransfer: true }, "generate").then((result) => {
										if (!result) return;
										const written = (result as unknown as { saved?: { written: number } }).saved;
										toast.success(`已生成 ${written?.written ?? 0} 位人物待核稿，请核对后保存。`);
										setPicked(new Set());
									});
								}}
							>
								{busy === "generate" ? <LoaderCircle size={12} className="animate-spin" /> : <Sparkles size={12} />} 确认生成
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
