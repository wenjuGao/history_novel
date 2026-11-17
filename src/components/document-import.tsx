"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Library, LockOpen, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type Document = { id: string; title: string; category: "history" | "reference"; corpusRef: string | null };

type CorpusStatus = {
	ready: boolean;
	volumes: number;
	pinned: boolean;
	pinning: { books: Array<{ id: string; name: string }>; pinnedAt: string } | null;
	personsIndexed: boolean;
	personsRows: number;
	scopeBooks: Array<{ id: string; name: string; volumes: number }>;
};

type ReferenceStatus = {
	registered: Array<{
		key: string;
		name: string;
		volumes: Array<{ volume: string; title: string; characters: number }>;
		spec: { methods: string[]; characters: number } | null;
	}>;
	pinned: {
		series: string;
		volumes: number;
		specChars: number;
		methods: string[];
		drift: string | null;
		driftKind: 'source' | 'series' | null;
		version: number | null;
		pendingVersion: number | null;
	} | null;
	specVersions: Array<{ version: number; specChars: number; origin: string; confirmedAt: string | null; createdAt: string }>;
	currentSpec: string;
	usage: string;
};

export function DocumentImport({
	projectId,
	onImported,
}: {
	projectId: string;
	onImported?: () => void;
}) {
	const [documents, setDocuments] = useState<Document[]>([]);
	const [corpus, setCorpus] = useState<CorpusStatus | null>(null);
	const [references, setReferences] = useState<ReferenceStatus | null>(null);
	const [category, setCategory] = useState<"reference" | "history">("reference");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	const [specDraft, setSpecDraft] = useState<string | null>(null);

	const load = useCallback(async (signal: AbortSignal) => {
		const [documentsResponse, corpusResponse, referencesResponse] = await Promise.all([
			fetch(`/api/projects/${projectId}/documents`, { cache: "no-store", signal }),
			fetch(`/api/projects/${projectId}/corpus`, { cache: "no-store", signal }),
			fetch(`/api/projects/${projectId}/references`, { cache: "no-store", signal }),
		]);
		const documentsResult = (await documentsResponse.json()) as { documents?: Document[]; error?: string };
		if (!documentsResponse.ok) throw new Error(documentsResult.error ?? "无法读取资料列表。");
		const corpusResult = (await corpusResponse.json()) as CorpusStatus & { error?: string };
		const referencesResult = (await referencesResponse.json()) as ReferenceStatus & { error?: string };
		return {
			documents: documentsResult.documents ?? [],
			corpus: corpusResult.error ? null : corpusResult,
			references: referencesResult.error ? null : referencesResult,
		};
	}, [projectId]);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError("");
		load(controller.signal)
			.then((result) => {
				setDocuments(result.documents);
				setCorpus(result.corpus);
				setReferences(result.references);
			})
			.catch((cause: unknown) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setError(cause instanceof Error ? cause.message : "无法读取资料列表。");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [load, revision]);

	async function runAction(label: string, path: "corpus" | "references", body: Record<string, unknown>) {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const response = await fetch(`/api/projects/${projectId}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const result = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(result.error ?? "操作失败。");
			const fresh = await load(new AbortController().signal);
			setCorpus(fresh.corpus);
			setReferences(fresh.references);
			setSpecDraft(fresh.references?.currentSpec ?? null);
			setMessage("资料固定状态已更新。");
			onImported?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作失败。");
		} finally {
			setBusy(false);
		}
	}

	async function saveSpecDraft() {
		if (specDraft === null) return;
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const response = await fetch(`/api/projects/${projectId}/references`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "saveSpec", specText: specDraft }),
			});
			const result = (await response.json()) as { version?: number; error?: string };
			if (!response.ok) throw new Error(result.error ?? "保存失败。");
			const fresh = await load(new AbortController().signal);
			setCorpus(fresh.corpus);
			setReferences(fresh.references);
			setSpecDraft(fresh.references?.currentSpec ?? null);
			setMessage(`写作规格已保存为第 ${result.version} 版草稿，确认后才会用于大纲与正文。`);
			onImported?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "保存失败。");
		} finally {
			setBusy(false);
		}
	}

	async function confirmSpec(version: number) {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const response = await fetch(`/api/projects/${projectId}/references`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "confirmSpec", version }),
			});
			const result = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(result.error ?? "确认失败。");
			const fresh = await load(new AbortController().signal);
			setCorpus(fresh.corpus);
			setReferences(fresh.references);
			setSpecDraft(fresh.references?.currentSpec ?? null);
			setMessage(`第 ${version} 版写作规格已确认，将用于后续大纲与正文请求。`);
			onImported?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "确认失败。");
		} finally {
			setBusy(false);
		}
	}

	async function upload(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const payload = new FormData(form);
			payload.set("category", category);
			const response = await fetch(`/api/projects/${projectId}/documents`, { method: "POST", body: payload });
			const result = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(result.error ?? "上传失败。");
			form.reset();
			setRevision((value) => value + 1);
			setMessage("资料已保存到本机。");
			onImported?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "上传失败。");
		} finally {
			setBusy(false);
		}
	}

	const uploads = documents.filter((document) => !document.corpusRef);
	const pendingSpecVersion = references?.pinned?.pendingVersion ?? null;

	return (
		<div className="flex flex-col gap-4">
			{loading ? (
				<Skeleton className="h-24" />
			) : (
				<>
					<section className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<Library size={14} className="text-muted-foreground" />
							<h3 className="text-[13px] font-medium">本机古籍语料</h3>
							{corpus?.pinned ? <Badge variant="success">已固定</Badge> : <Badge variant="warning">未固定</Badge>}
						</div>
						{!corpus?.ready && (
							<p className="text-[12px] text-muted-foreground">
								本机尚未建好古籍语料库，请在终端执行 <code className="text-[11px]">npm run corpus:index</code>。
							</p>
						)}
						{corpus?.ready && !corpus.pinned && (
							<p className="text-[12px] text-muted-foreground">
								已建好 {corpus.volumes} 卷古籍，但还没有绑定到本项目。固定后所有史料证据都从这批原文里校验。
							</p>
						)}
						{corpus?.pinned && (
							<p className="text-[12px] leading-relaxed text-muted-foreground">
								已固定 {corpus.pinning?.books.length ?? 0} 部 / {corpus.volumes} 卷，证据校验只读本机原文，不外发。
							</p>
						)}
						{corpus?.pinned && corpus.scopeBooks.length > 0 && (
							<p className="text-[12px] leading-relaxed text-muted-foreground">
								与当前时间阶段重叠：
								{corpus.scopeBooks.slice(0, 6).map((book) => book.name).join("、")}
								{corpus.scopeBooks.length > 6 ? ` 等 ${corpus.scopeBooks.length} 部` : ""}。
							</p>
						)}
						{corpus?.pinned && (
							<p className="text-[11px] text-muted-foreground">
								{corpus.personsIndexed
									? `史料人物索引已建（${corpus.personsRows} 条），人物步骤可直接勾选。`
									: "史料人物索引尚未建立，请在终端执行 npm run corpus:persons。"}
							</p>
						)}
						{corpus && (
							<Button type="button" size="sm" variant={corpus.pinned ? "outline" : "default"} disabled={busy || !corpus.ready} onClick={() => runAction("固定语料", "corpus", { action: "pin" })}>
								{corpus.pinned ? "重新固定到本项目" : "固定到本项目"}
							</Button>
						)}
					</section>

					<section className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<LockOpen size={14} className="text-muted-foreground" />
							<h3 className="text-[13px] font-medium">参考小说</h3>
							{references?.pinned ? <Badge variant="success">已固定</Badge> : <Badge variant="outline">未固定</Badge>}
						</div>
						{references?.pinned ? (
							<div className="flex flex-col gap-1.5">
								<p className="text-[12px] text-foreground">
									{references.pinned.series} · {references.pinned.volumes} 卷 · 写作规格 {references.pinned.specChars.toLocaleString()} 字
								</p>
								<div className="flex flex-wrap gap-1">
									{references.pinned.methods.map((method) => (
										<Badge key={method} variant="outline">{method}</Badge>
									))}
								</div>
								<p className="text-[11px] leading-relaxed text-muted-foreground">{references.usage}</p>
								{references.pinned.drift && (
									<Alert variant="destructive">
										<AlertDescription>
											{references.pinned.drift}
											{references.pinned.driftKind === "source"
												? "需要重新执行 npm run refs:register 后再固定。"
												: references.pinned.driftKind === "series"
													? "请在下方重新编辑并确认规格版本。"
													: ""}
										</AlertDescription>
									</Alert>
								)}
								<div className="flex flex-col gap-1.5 rounded-[min(var(--radius-lg),14px)] border p-2">
									<div className="flex flex-wrap items-center gap-1.5">
										<h4 className="text-[12px] font-medium">作品写作规格版本</h4>
										{references.pinned.version ? (
											<Badge variant="success">生效 v{references.pinned.version}</Badge>
										) : (
											<Badge variant="warning">尚无已确认版本</Badge>
										)}
										{pendingSpecVersion && <Badge variant="outline">待确认 v{pendingSpecVersion}</Badge>}
									</div>
									<p className="text-[11px] leading-relaxed text-muted-foreground">
										保存编辑会产生新的草稿版本，确认之后才进入大纲与正文请求；这里只保存抽象写法，参考小说原文不会外发。
									</p>
									<Textarea
										aria-label="作品写作规格"
										rows={6}
										className="font-mono text-[11px]"
										value={specDraft ?? references.currentSpec}
										onChange={(event) => setSpecDraft(event.target.value)}
									/>
									<div className="flex flex-wrap items-center gap-2">
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={busy || !specDraft?.trim() || specDraft === references.currentSpec}
											onClick={() => void saveSpecDraft()}
										>
											保存为草稿
										</Button>
										{pendingSpecVersion && (
											<Button type="button" size="sm" disabled={busy} onClick={() => void confirmSpec(pendingSpecVersion)}>
												确认 v{pendingSpecVersion}
											</Button>
										)}
									</div>
									{references.specVersions.length > 0 && (
										<ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
											{references.specVersions.map((version) => (
												<li key={version.version} className="flex flex-wrap items-center gap-1.5">
													<span className="font-medium">v{version.version}</span>
													<span>{version.origin === "edited" ? "作者编辑" : "登记规格"}</span>
													<span>{version.specChars.toLocaleString()} 字</span>
													<Badge variant={version.confirmedAt ? "success" : "outline"}>
														{version.confirmedAt ? "已确认" : "草稿"}
													</Badge>
													{references.pinned?.version === version.version && <span>当前生效</span>}
												</li>
											))}
										</ul>
									)}
								</div>
							</div>
						) : (
							<p className="text-[12px] leading-relaxed text-muted-foreground">
								{references && references.registered.length
									? `本机已登记 ${references.registered.map((series) => `${series.name}（${series.volumes.length} 卷）`).join("、")}，固定后只向模型提供抽象写作方法。`
									: "本机尚未登记参考小说，请在终端执行 npm run refs:register。"}
							</p>
						)}
						{references && (
							<div className="flex flex-wrap gap-2">
								{references.registered.map((series) => (
									<Button
										key={series.key}
										type="button"
										size="sm"
										variant={references.pinned ? "outline" : "default"}
										disabled={busy || !series.spec}
										title={series.spec ? `写作规格 ${series.spec.characters} 字` : "本机还没有这本书的抽象写作规格，无法固定。"}
										onClick={() => runAction("固定参考小说", "references", { action: "pin", seriesKey: series.key })}
									>
										{references.pinned ? `改选 ${series.name}` : `固定 ${series.name}`}
									</Button>
								))}
								{references.pinned && (
									<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runAction("取消固定", "references", { action: "clear" })}>
										取消固定
									</Button>
								)}
							</div>
						)}
					</section>
				</>
			)}

			<section className="flex flex-col gap-3 border-t pt-3">
				<h3 className="text-[13px] font-medium">补充资料（本机上传）</h3>
				<p className="text-[12px] leading-relaxed text-muted-foreground">
					固定的古籍之外，可补充自备史料或参考小说（TXT、Markdown、未加密 MOBI，最多 32 MB）。导入不会自动调用模型。
				</p>

				<form className="flex flex-col gap-3" onSubmit={upload}>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="document-category">资料类型</Label>
						<Select value={category} onValueChange={(value) => setCategory(value as "reference" | "history")}>
							<SelectTrigger id="document-category" className="h-9">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="reference">参考小说</SelectItem>
								<SelectItem value="history">历史资料</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="document-file">文件</Label>
						<Input id="document-file" name="file" type="file" accept=".txt,.md,.mobi" required className="h-auto py-1.5" />
					</div>
					<Button type="submit" size="sm" disabled={busy}>
						<Upload size={15} /> {busy ? "保存中…" : "导入资料"}
					</Button>
				</form>
			</section>

			{message && <p role="status" className="text-[11px] text-success">{message}</p>}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			{loading ? (
				<Skeleton className="h-8" />
			) : uploads.length === 0 ? (
				<p className="text-[12px] text-muted-foreground">尚未上传补充资料。</p>
			) : (
				<ul className="flex flex-col gap-1">
					{uploads.map((document) => (
						<li className="flex items-center gap-2 text-[12px] text-foreground" key={document.id}>
							<span className="shrink-0 text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
								{document.category === "reference" ? "参考" : "史料"}
							</span>
							<span className="min-w-0 truncate">{document.title}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
