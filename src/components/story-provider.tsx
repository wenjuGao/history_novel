"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { toast } from "sonner";

export type Chapter = {
	id: string;
	title: string;
	pov: string;
	/** 本章故事时间设定（如「904 年秋，汴州」）；旧规划可能没有该字段。 */
	time?: string;
	synopsis: string;
	plot: string[];
	historyEvidence: string[];
	fiction: string[];
	endingHook: string;
};

export type StoryPlan = {
	schemaVersion: number;
	/** 大纲来源：本地骨架／模型扩写／人工编辑；旧版本规划可能没有该字段。 */
	origin?: "local" | "model" | "manual";
	title: string;
	scope: { period: string; regions: string[]; plannedChapters: number };
	synopsis: string;
	centralQuestion: string;
	historicalAnchors: Array<{ evidenceId: string; fact: string }>;
	fictionBoundary: string[];
	chapters: Chapter[];
	humanReviewQuestions: string[];
	/** 章纲产生时选定的剧情提案绑定；缺失或过期时确认与生成被阻止。 */
	proposal?: { slot: number; revision: number; inputHash: string; title: string } | null;
	generationContext?: {
		reference: { title?: string; coverage?: string; writingSpecification?: string; specSha256?: string; specVersion?: number };
	};
};

export type ChapterDraft = {
	chapterId: string;
	chapterTitle: string;
	content: string;
	metaJson: string | null;
	status: "generating" | "draft" | "accepted" | "failed-or-unknown";
	requestId: string | null;
	estimatedCostCny: number;
	reservedCostCny: number;
	actualCostCny: number | null;
	promptTokens: number | null;
	completionTokens: number | null;
	errorMessage: string | null;
	attemptCount: number;
	autoContinuationCount: number;
	latestAttemptStatus: string | null;
	updatedAt: string;
	// T053：前文改写后依赖它的章节标为待复核；本章的已确认故事状态是否仍有效一并回显。
	needsReview: number;
	reviewReason: string | null;
	stateStatus: "confirmed" | "stale" | null;
	stateReason: string | null;
	autoContinuations: number;
};

// 章节接受后固化的故事状态（REQ-026/027/029）；stale 表示前文已变更，不再进入后续请求。
export type StoryStateEntry = {
	chapterId: string;
	chapterTitle: string;
	draftInputHash: string;
	summary: string;
	locations: string[];
	relations: string[];
	knowledge: string[];
	threads: string[];
	bodyTail: string;
	status: "confirmed" | "stale";
	staleReason: string | null;
	specVersion: number | null;
	confirmedAt: string;
};

export type StoryEstimate = {
	billingMode: string;
	modelId: string;
	totalCny: number | null;
	totalTokens: number;
	chapters: Array<{ chapterId: string; ceilingCny: number | null; tokenAllowance: number }>;
};

export type StoryData = {
	/** 章纲未绑定选定提案或证据快照时的口径；非空时确认与生成被阻止。 */
	blocked: string | null;
	proposalIssue: string | null;
	version: number;
	planHash: string | null;
	plan: StoryPlan | null;
	estimate: StoryEstimate | null;
	usage: { spentTokens: number; spentCny: number };
	evidence: Array<{ evidenceId: string; title: string; revisionUrl: string; status: string }>;
	/** 依赖待复核或已失效证据的问题清单；非空时生成与确认被阻止。 */
	evidenceIssues: string[];
	/** 方案快照的写作规格版本落后于本机最新已确认版本时的复核提示；只提示，不阻断。 */
	specNotice: string | null;
	approval: {
		planHash: string;
		budgetCny: number | null;
		tokenBudget: number | null;
		billingMode: string;
		modelId: string;
		allowExternalTransfer: number;
		evidenceConfirmed: number;
		approvedAt: string;
	} | null;
	chapters: ChapterDraft[];
	/** 各章已确认/已失效的故事状态；只有 confirmed 会进入后续章节请求（REQ-026/029）。 */
	storyStates: StoryStateEntry[];
	/** 单章自动续写次数上限（REQ-031）。 */
	autoContinuationLimit: number;
};

export type ApprovalInput = {
	allowExternalTransfer: boolean;
	evidenceConfirmed: boolean;
	// REQ-035：整书预算不再必填；填了只作为当时估算的备注。
	budgetCny?: number;
	tokenBudget?: number;
};

const POLL_ERROR = "进度连接暂时中断，正在重连；已落库内容不会丢失。";

export type StoryStatus = "idle" | "loading" | "uninitialized" | "ready" | "failed";

type StoryValue = {
	status: StoryStatus;
	data: StoryData | null;
	plan: StoryPlan | null;
	dirty: boolean;
	busy: boolean;
	busyChapter: string | null;
	error: string;
	message: string;
	hasRunningChapter: boolean;
	approvalMatches: boolean;
	tokenPlan: boolean;
	evidenceIssues: string[];
	specNotice: string | null;
	reload: () => Promise<void>;
	updatePlan: (update: (current: StoryPlan) => StoryPlan) => void;
	savePlan: () => Promise<boolean>;
	approvePlan: (input: ApprovalInput) => Promise<boolean>;
	runChapter: (chapterId: string, options?: { retry?: boolean; retryConfirmed?: boolean }) => Promise<void>;
	saveChapter: (chapterId: string, content: string) => Promise<void>;
	acceptChapter: (chapterId: string) => Promise<void>;
	setMessage: (message: string) => void;
};

const StoryContext = createContext<StoryValue | null>(null);

export function useStory() {
	const value = useContext(StoryContext);
	if (!value) throw new Error("useStory 必须在 StoryProvider 内使用。");
	return value;
}

export function StoryProvider({
	projectId,
	children,
}: {
	projectId: string | null;
	children: ReactNode;
}) {
	const [data, setData] = useState<StoryData | null>(null);
	const [plan, setPlan] = useState<StoryPlan | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<StoryStatus>(projectId ? "loading" : "idle");
	const [busy, setBusy] = useState(false);
	const [busyChapter, setBusyChapter] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const lastError = useRef("");
	const requestSeq = useRef(0);

	const fail = useCallback((next: string) => {
		if (!next) return;
		if (lastError.current !== next) toast.error(next);
		lastError.current = next;
		setError(next);
	}, []);

	const clearError = useCallback(() => {
		lastError.current = "";
		setError("");
	}, []);

	const apply = useCallback((next: StoryData) => {
		setData(next);
		setPlan(next.plan);
		setDirty(false);
		setStatus(next.plan && next.planHash && next.estimate ? "ready" : "uninitialized");
	}, []);

	const reload = useCallback(async () => {
		if (!projectId) return;
		const seq = ++requestSeq.current;
		const response = await fetch(`/api/projects/${projectId}/story`, { cache: "no-store" });
		const result = (await response.json()) as StoryData & { error?: string };
		if (!response.ok) throw new Error(result.error ?? "无法读取故事规划。");
		if (seq !== requestSeq.current) return;
		apply(result);
	}, [projectId, apply]);

	useEffect(() => {
		if (!projectId) {
			setData(null);
			setPlan(null);
			setStatus("idle");
			return;
		}
		const controller = new AbortController();
		setStatus("loading");
		clearError();
		fetch(`/api/projects/${projectId}/story`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const result = (await response.json()) as StoryData & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "无法读取故事规划。");
				return result;
			})
			.then(apply)
			.catch((cause: unknown) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setStatus("failed");
				fail(cause instanceof Error ? cause.message : "无法读取故事规划。");
			});
		return () => controller.abort();
	}, [projectId, apply, clearError, fail]);

	const hasRunningChapter = data?.chapters.some((chapter) => chapter.status === "generating") ?? false;
	const evidenceIssues = useMemo(() => data?.evidenceIssues ?? [], [data]);
	const specNotice = data?.specNotice ?? null;

	useEffect(() => {
		if (!projectId || !hasRunningChapter) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			const seq = requestSeq.current;
			try {
				const response = await fetch(`/api/projects/${projectId}/story`, {
					cache: "no-store",
					signal: controller.signal,
				});
				const next = (await response.json()) as StoryData & { error?: string };
				if (!response.ok) throw new Error(next.error ?? "读取生成进度失败。");
				// 用户在轮询期间做过保存/确认时 requestSeq 会前进，旧的进度响应不得回退其版本。
				if (seq !== requestSeq.current) return;
				setData(next);
				setError((current) => {
					if (current === POLL_ERROR) {
						lastError.current = "";
						return "";
					}
					return current;
				});
			} catch {
				if (!controller.signal.aborted) fail(POLL_ERROR);
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
			}
		}
		timer = setTimeout(poll, 400);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [projectId, hasRunningChapter, fail]);

	const updatePlan = useCallback((update: (current: StoryPlan) => StoryPlan) => {
		setPlan((current) => (current ? update(current) : current));
		setDirty(true);
		setMessage("");
		clearError();
	}, [clearError]);

	const send = useCallback(
		async (action: string, extra: Record<string, unknown> = {}) => {
			if (!projectId || !data) return null;
			setBusy(true);
			clearError();
			try {
				const response = await fetch(`/api/projects/${projectId}/story`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action, version: data.version, planHash: data.planHash, ...extra }),
				});
				const result = (await response.json()) as Record<string, unknown> & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "请求失败。");
				return result;
			} catch (cause) {
				fail(cause instanceof Error ? cause.message : "请求失败。");
				return null;
			} finally {
				setBusy(false);
			}
		},
		[projectId, data, fail, clearError],
	);

	const savePlan = useCallback(async () => {
		if (!projectId || !data || !plan) return false;
		setBusy(true);
		setMessage("");
		clearError();
		try {
			const response = await fetch(`/api/projects/${projectId}/story`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedVersion: data.version, plan }),
			});
			const result = (await response.json()) as { version?: number; error?: string };
			if (!response.ok) throw new Error(result.error ?? "无法保存规划。");
			await reload();
			setMessage(`规划已保存为第 ${result.version} 版；旧版确认不会沿用，请重新审阅确认。`);
			return true;
		} catch (cause) {
			fail(cause instanceof Error ? cause.message : "无法保存规划。");
			return false;
		} finally {
			setBusy(false);
		}
	}, [projectId, data, plan, reload, fail, clearError]);

	const approvePlan = useCallback(
		async (input: ApprovalInput) => {
			if (dirty || !data?.planHash || !data.estimate) return false;
			const result = await send("approve", {
				allowExternalTransfer: input.allowExternalTransfer,
				evidenceConfirmed: input.evidenceConfirmed,
				...(typeof input.budgetCny === "number" ? { budgetCny: input.budgetCny } : {}),
				...(typeof input.tokenBudget === "number" ? { tokenBudget: input.tokenBudget } : {}),
			});
			if (!result) return false;
			await reload();
			setMessage("当前故事规划、证据核对与资料外发已确认；可逐章生成，每次请求各自记录用量。");
			return true;
		},
		[dirty, data, send, reload],
	);

	const runChapter = useCallback(
		async (chapterId: string, options?: { retry?: boolean; retryConfirmed?: boolean }) => {
			if (!projectId || !data?.planHash || dirty || busyChapter || hasRunningChapter) return;
			const retry = options?.retry ?? false;
			setBusyChapter(chapterId);
			clearError();
			setMessage("");
			try {
				const response = await fetch(`/api/projects/${projectId}/story`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: retry ? "resume" : "generate",
						version: data.version,
						planHash: data.planHash,
						chapterId,
						retryConfirmed: !retry || options?.retryConfirmed === true,
					}),
				});
				const result = (await response.json()) as { status?: string; error?: string };
				if (!response.ok) throw new Error(result.error ?? "章节生成失败。");
				await reload();
				setMessage(
					result.status === "generating"
						? "生成任务已开始，正文将逐步保存；关闭页面后可重新打开查看进度。"
						: result.status === "draft"
							? "章节草稿已保存，待人工编辑和接受。"
							: "请求未生成完整草稿；已保存正文，可确认后继续生成。",
				);
			} catch (cause) {
				fail(cause instanceof Error ? cause.message : "章节生成失败。");
				await reload().catch(() => undefined);
			} finally {
				setBusyChapter(null);
			}
		},
		[projectId, data, dirty, busyChapter, hasRunningChapter, reload, fail, clearError],
	);

	const saveChapter = useCallback(
		async (chapterId: string, content: string) => {
			const result = await send("edit", { chapterId, content });
			if (result) {
				await reload();
				setMessage("章节修改已保存；本章状态作废，需重新接受后才解锁后续章节。");
			}
		},
		[send, reload],
	);

	const acceptChapter = useCallback(
		async (chapterId: string) => {
			const result = await send("accept", { chapterId });
			if (result) {
				await reload();
				setMessage("本章已接受并固化为故事状态；其后章节已标为待复核，请逐章确认。");
			}
		},
		[send, reload],
	);

	const tokenPlan = data?.estimate?.billingMode === "token-plan";
	const approvalMatches = Boolean(
		data?.planHash &&
			data.approval &&
			data.approval.planHash === data.planHash &&
			data.approval.billingMode === data.estimate?.billingMode &&
			data.approval.modelId === data.estimate?.modelId &&
			data.approval.allowExternalTransfer === 1 &&
			data.approval.evidenceConfirmed === 1,
	);

	const value = useMemo<StoryValue>(
		() => ({
			status,
			data,
			plan,
			dirty,
			busy,
			busyChapter,
			error,
			message,
			hasRunningChapter,
			approvalMatches,
			tokenPlan,
			evidenceIssues,
			specNotice,
			reload,
			updatePlan,
			savePlan,
			approvePlan,
			runChapter,
			saveChapter,
			acceptChapter,
			setMessage,
		}),
		[
			status,
			data,
			plan,
			dirty,
			busy,
			busyChapter,
			error,
			message,
			hasRunningChapter,
			approvalMatches,
			tokenPlan,
			evidenceIssues,
			specNotice,
			reload,
			updatePlan,
			savePlan,
			approvePlan,
			runChapter,
			saveChapter,
			acceptChapter,
		],
	);

	return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}
