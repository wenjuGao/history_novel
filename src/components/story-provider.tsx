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
	/** REQ-060：正文重新生成与恢复前归档的份数与最近一份的元信息；正文本身按章单独读取。 */
	backupCount: number;
	backupAt: string | null;
	backupChars: number | null;
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

/** 队列阶段：running 处理下一项时逐段变化，stopped/done 为终态。 */
export type QueuePhase = "idle" | "generating" | "accepting" | "waiting" | "stopped" | "done";

export type QueueState = {
	/** 按目录顺序排好的待处理章节 ID。 */
	ids: string[];
	/** 当前处理到第几项（从 0 开始）。 */
	index: number;
	phase: QueuePhase;
	/** 停止原因或当前阶段的补充说明；空串表示无。 */
	reason: string;
	/** 是否在草稿完整后自动接受该章。 */
	autoAccept: boolean;
	/** REQ-060：本队列是否在覆盖重写已有正文（每次请求前服务端先归档旧稿）。 */
	regenerate: boolean;
};

/** 章纲按章重生成的进度：一次调用只重写一章，已重生成结果留在待保存草稿里。 */
export type PlanQueueState = {
	ids: string[];
	index: number;
	running: boolean;
	/** 已成功重生成的章数。 */
	done: number;
	reason: string;
};

export type ChapterRequestResult = { ok: boolean; status: string; error: string };

type SendResult = { ok: boolean; result: Record<string, unknown> | null; error: string };

const idleQueue: QueueState = { ids: [], index: 0, phase: "idle", reason: "", autoAccept: false, regenerate: false };
const idlePlanQueue: PlanQueueState = { ids: [], index: 0, running: false, done: 0, reason: "" };
// 单章请求本身有十分钟上限，再加一次落库往返的余量；超过即认为进度不可信。
const queueWaitMs = 700_000;

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
	queue: QueueState;
	queueRunning: boolean;
	planQueue: PlanQueueState;
	reload: () => Promise<void>;
	updatePlan: (update: (current: StoryPlan) => StoryPlan) => void;
	savePlan: () => Promise<boolean>;
	approvePlan: (input: ApprovalInput) => Promise<boolean>;
	runChapter: (
		chapterId: string,
		options?: { retry?: boolean; retryConfirmed?: boolean; regenerate?: boolean; regenerateConfirmed?: boolean },
	) => Promise<ChapterRequestResult>;
	saveChapter: (chapterId: string, content: string) => Promise<void>;
	acceptChapter: (chapterId: string) => Promise<{ ok: boolean; error: string }>;
	startQueue: (chapterIds: string[], options?: { autoAccept?: boolean; regenerate?: boolean }) => Promise<void>;
	stopQueue: () => void;
	/** REQ-060：逐章重写章纲设定（一次调用一章），结果留在待保存草稿，由作者审阅后保存目录。 */
	regenerateChapterPlans: (chapterIds: string[]) => Promise<void>;
	stopPlanQueue: () => void;
	/** 读取本章最近一份归档正文；无归档时返回 null。 */
	readChapterBackup: (chapterId: string) => Promise<ChapterBackup | null>;
	/** 用最近一份归档正文覆盖本章草稿（当前正文先归档），不发任何模型请求。 */
	restoreChapter: (chapterId: string) => Promise<{ ok: boolean; error: string }>;
	setMessage: (message: string) => void;
};

export type ChapterBackup = {
	id: string;
	chapterId: string;
	chapterTitle: string;
	content: string;
	status: string;
	reason: string;
	archivedAt: string;
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
	const [queue, setQueue] = useState<QueueState>(idleQueue);
	const [planQueue, setPlanQueue] = useState<PlanQueueState>(idlePlanQueue);
	const lastError = useRef("");
	const requestSeq = useRef(0);
	// 队列循环在异步等待中必须读到最新落库状态，因此保存一份不随渲染过期的镜像。
	const dataRef = useRef<StoryData | null>(null);
	const planRef = useRef<StoryPlan | null>(null);
	const dirtyRef = useRef(false);
	const busyChapterRef = useRef<string | null>(null);
	const stopRequested = useRef(false);
	const runningQueue = useRef(false);
	const runningPlanQueue = useRef(false);
	const planStopRequested = useRef(false);

	useEffect(() => {
		planRef.current = plan;
	}, [plan]);

	useEffect(() => {
		dirtyRef.current = dirty;
	}, [dirty]);

	useEffect(() => {
		busyChapterRef.current = busyChapter;
	}, [busyChapter]);

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

	const commitData = useCallback((next: StoryData) => {
		dataRef.current = next;
		setData(next);
	}, []);

	const apply = useCallback((next: StoryData) => {
		commitData(next);
		setPlan(next.plan);
		setDirty(false);
		setStatus(next.plan && next.planHash && next.estimate ? "ready" : "uninitialized");
	}, [commitData]);

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
			dataRef.current = null;
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
				commitData(next);
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
	}, [projectId, hasRunningChapter, commitData, fail]);

	const updatePlan = useCallback((update: (current: StoryPlan) => StoryPlan) => {
		setPlan((current) => (current ? update(current) : current));
		setDirty(true);
		setMessage("");
		clearError();
	}, [clearError]);

	// 请求体里的版本号取自 dataRef：队列在两次请求之间会持续轮询，闭包里的旧快照会把版本写死。
	const send = useCallback(
		async (action: string, extra: Record<string, unknown> = {}): Promise<SendResult> => {
			const current = dataRef.current;
			if (!projectId || !current) return { ok: false, result: null, error: "作品数据尚未读取完成。" };
			setBusy(true);
			clearError();
			try {
				const response = await fetch(`/api/projects/${projectId}/story`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action, version: current.version, planHash: current.planHash, ...extra }),
				});
				const result = (await response.json()) as Record<string, unknown> & { error?: string };
				if (!response.ok) throw new Error(result.error ?? "请求失败。");
				return { ok: true, result, error: "" };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : "请求失败。";
				fail(message);
				return { ok: false, result: null, error: message };
			} finally {
				setBusy(false);
			}
		},
		[projectId, fail, clearError],
	);

	const savePlan = useCallback(async () => {
		const current = dataRef.current;
		if (!projectId || !current || !plan) return false;
		setBusy(true);
		setMessage("");
		clearError();
		try {
			const response = await fetch(`/api/projects/${projectId}/story`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedVersion: current.version, plan }),
			});
			const result = (await response.json()) as {
				version?: number;
				carried?: number;
				preserved?: number;
				needsReview?: number;
				error?: string;
			};
			if (!response.ok) throw new Error(result.error ?? "无法保存规划。");
			await reload();
			const carried = result.carried ?? 0;
			const preserved = result.preserved ?? 0;
			const flagged = result.needsReview ?? 0;
			setMessage(
				carried
					? `章节目录已保存为第 ${result.version} 版；${preserved} 章已接受正文与故事状态原样保留${flagged ? `，${flagged} 章因章纲或前文变化需复核` : ""}，${flagged ? "复核后重新接受即可，" : ""}方案级确认需重新做一次。`
					: `规划已保存为第 ${result.version} 版；旧版确认不会沿用，请重新审阅确认。`,
			);
			return true;
		} catch (cause) {
			fail(cause instanceof Error ? cause.message : "无法保存规划。");
			return false;
		} finally {
			setBusy(false);
		}
	}, [projectId, plan, reload, fail, clearError]);

	const approvePlan = useCallback(
		async (input: ApprovalInput) => {
			const current = dataRef.current;
			if (dirtyRef.current || !current?.planHash || !current.estimate) return false;
			const sent = await send("approve", {
				allowExternalTransfer: input.allowExternalTransfer,
				evidenceConfirmed: input.evidenceConfirmed,
				...(typeof input.budgetCny === "number" ? { budgetCny: input.budgetCny } : {}),
				...(typeof input.tokenBudget === "number" ? { tokenBudget: input.tokenBudget } : {}),
			});
			if (!sent.ok) return false;
			await reload();
			setMessage("当前故事规划、证据核对与资料外发已确认；可逐章生成，每次请求各自记录用量。");
			return true;
		},
		[send, reload],
	);

	const runChapter = useCallback(
		async (
			chapterId: string,
			options?: { retry?: boolean; retryConfirmed?: boolean; regenerate?: boolean; regenerateConfirmed?: boolean },
		): Promise<ChapterRequestResult> => {
			const current = dataRef.current;
			if (!projectId || !current?.planHash) return { ok: false, status: "", error: "作品数据尚未读取完成。" };
			if (dirtyRef.current) {
				const message = "有未保存的目录修改；请先保存章节目录，再生成或接受本章。";
				fail(message);
				return { ok: false, status: "", error: message };
			}
			if (busyChapterRef.current || current.chapters.some((item) => item.status === "generating")) {
				const message = "已有章节正在生成，请等待本次任务结束。";
				fail(message);
				return { ok: false, status: "", error: message };
			}
			const retry = options?.retry ?? false;
			const regenerate = options?.regenerate ?? false;
			setBusyChapter(chapterId);
			clearError();
			setMessage("");
			try {
				const response = await fetch(`/api/projects/${projectId}/story`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: regenerate ? "regenerate" : retry ? "resume" : "generate",
						version: current.version,
						planHash: current.planHash,
						chapterId,
						retryConfirmed: !retry || options?.retryConfirmed === true,
						...(regenerate ? { regenerateConfirmed: options?.regenerateConfirmed === true } : {}),
					}),
				});
				const result = (await response.json()) as { status?: string; error?: string };
				if (!response.ok) throw new Error(result.error ?? "章节生成失败。");
				await reload();
				const status = result.status ?? "";
				setMessage(
					status === "generating"
						? regenerate
							? "本章重新生成任务已开始，旧正文已归档；关闭页面后可重新打开查看进度。"
							: "生成任务已开始，正文将逐步保存；关闭页面后可重新打开查看进度。"
						: status === "draft"
							? "章节草稿已保存，待人工编辑和接受。"
							: "请求未生成完整草稿；已保存正文，可确认后继续生成。",
				);
				return { ok: true, status, error: "" };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : "章节生成失败。";
				fail(message);
				await reload().catch(() => undefined);
				return { ok: false, status: "", error: message };
			} finally {
				setBusyChapter(null);
			}
		},
		[projectId, reload, fail, clearError],
	);

	const saveChapter = useCallback(
		async (chapterId: string, content: string) => {
			const sent = await send("edit", { chapterId, content });
			if (sent.ok) {
				await reload();
				setMessage("章节修改已保存；本章状态作废，需重新接受后才解锁后续章节。");
			}
		},
		[send, reload],
	);

	const acceptChapter = useCallback(
		async (chapterId: string) => {
			const sent = await send("accept", { chapterId });
			if (!sent.ok) return { ok: false, error: sent.error };
			await reload();
			setMessage("本章已接受并固化为故事状态；其后章节已标为待复核，请逐章确认。");
			return { ok: true, error: "" };
		},
		[send, reload],
	);

	// 队列只等本章任务落定：后台流式写入由服务端推进，前端不补发请求，也不并发第二章。
	const waitForDraft = useCallback(async (chapterId: string) => {
		const deadline = Date.now() + queueWaitMs;
		for (;;) {
			if (stopRequested.current) {
				return { status: "", error: "已停止队列：不再发起后续请求；本章请求仍在后台保存正文，可在目录查看。" };
			}
			const draft = dataRef.current?.chapters.find((item) => item.chapterId === chapterId);
			if (!draft) return { status: "", error: "读取不到本章状态，请刷新页面后核对本章是否已开始生成。" };
			if (draft.status !== "generating") return { status: draft.status, error: "" };
			if (Date.now() > deadline) {
				return { status: "", error: "等待本章生成结果超时；正文保留在最后一条检查点，请刷新核对后人工继续。" };
			}
			await new Promise((resolve) => setTimeout(resolve, 700));
		}
	}, []);

	const startQueue = useCallback(
		async (chapterIds: string[], options?: { autoAccept?: boolean; regenerate?: boolean }) => {
			if (runningQueue.current || !projectId || !chapterIds.length) return;
			const autoAccept = options?.autoAccept ?? true;
			// REQ-060：重生成队列同样一次请求一章，只是把已有草稿视为待覆盖对象而不是跳过理由。
			const regenerate = options?.regenerate ?? false;
			runningQueue.current = true;
			stopRequested.current = false;
			// 队列状态先落到本次选择：全部章节已接受时循环内不会再写入，末态仍需对应当前 ids。
			setQueue({ ids: chapterIds, index: 0, phase: "generating", reason: "", autoAccept, regenerate });
			let stopped = "";
			for (let index = 0; index < chapterIds.length; index += 1) {
				const chapterId = chapterIds[index];
				if (stopRequested.current) {
					stopped = "已停止队列：不再发起后续请求；已生成与已接受的章节保持原样。";
					break;
				}
				const existing = dataRef.current?.chapters.find((item) => item.chapterId === chapterId)?.status ?? "";
				let status = regenerate && existing !== "generating" ? "" : existing;
				if (!status) {
					setQueue({ ids: chapterIds, index, phase: "generating", reason: "", autoAccept, regenerate });
					// 没有正文的章节谈不上覆盖，走普通生成；已有正文的才走 regenerate（服务端先归档）。
					const started = await runChapter(chapterId, regenerate && existing ? { regenerate: true, regenerateConfirmed: true } : undefined);
					if (!started.ok) {
						stopped = started.error;
						break;
					}
					if (started.status === "generating") {
						setQueue({ ids: chapterIds, index, phase: "waiting", reason: "", autoAccept, regenerate });
						const settled = await waitForDraft(chapterId);
						if (settled.error) {
							stopped = settled.error;
							break;
						}
						status = settled.status;
					} else {
						status = started.status;
					}
				} else if (status === "generating") {
					setQueue({ ids: chapterIds, index, phase: "waiting", reason: "", autoAccept, regenerate });
					const settled = await waitForDraft(chapterId);
					if (settled.error) {
						stopped = settled.error;
						break;
					}
					status = settled.status;
				}
				if (status === "accepted") continue;
				if (status === "failed-or-unknown") {
					stopped = "本章生成中断或状态未知，队列停止；正文保留在检查点，请核对百炼用量后单独继续生成。";
					break;
				}
				if (status !== "draft") {
					stopped = `本章状态为 ${status || "未知"}，队列只处理未生成与待审阅的章节。`;
					break;
				}
				if (!autoAccept) {
					stopped = regenerate
						? "本章已重新生成并保存草稿，旧正文已归档；队列未开启自动接受，请人工审阅并接受后再继续下一章。"
						: "本章草稿已保存；队列未开启自动接受，请人工审阅并接受后再继续。";
					break;
				}
				setQueue({ ids: chapterIds, index, phase: "accepting", reason: "", autoAccept, regenerate });
				const accepted = await acceptChapter(chapterId);
				if (!accepted.ok) {
					stopped = accepted.error;
					break;
				}
			}
			runningQueue.current = false;
			stopRequested.current = false;
			setQueue((current) => ({ ...current, phase: stopped ? "stopped" : "done", reason: stopped }));
			if (stopped) fail(stopped);
			else setMessage(regenerate ? "队列已完成：各章正文已依次重新生成并自动接受，故事状态已固化。" : "队列已完成：各章正文已依次生成并自动接受，故事状态已固化。");
		},
		[projectId, runChapter, acceptChapter, waitForDraft, fail],
	);

	// REQ-060：章纲按章重生成只走 /chapter-plan，一次一章、不落库；结果实时并入本地草稿，
	// 由作者审阅后统一「保存章节目录」产生新版本（已接受正文的保留与待复核标记由服务端 carryForward 处理）。
	const regenerateChapterPlans = useCallback(
		async (chapterIds: string[]) => {
			const start = planRef.current;
			if (runningPlanQueue.current || !projectId || !start || !chapterIds.length) return;
			if (runningQueue.current) {
				setPlanQueue({ ids: chapterIds, index: 0, running: false, done: 0, reason: "正文队列进行中，请先停下再重生成章纲。" });
				return;
			}
			if (dirtyRef.current) {
				setPlanQueue({ ids: chapterIds, index: 0, running: false, done: 0, reason: "有未保存的目录修改；请先保存章节目录，再按章重生成。" });
				return;
			}
			runningPlanQueue.current = true;
			planStopRequested.current = false;
			setPlanQueue({ ids: chapterIds, index: 0, running: true, done: 0, reason: "" });
			// 邻章上下文用本次草稿：连续重写相邻章节时，钩子链要接在刚生成的新版上而不是已保存的旧版。
			let working = start;
			let stopped = "";
			let done = 0;
			for (let index = 0; index < chapterIds.length; index += 1) {
				const chapterId = chapterIds[index];
				if (planStopRequested.current) {
					stopped = "已停止：不再请求后续章节；已重生成的章节留在待保存草稿里。";
					break;
				}
				const at = working.chapters.findIndex((item) => item.id === chapterId);
				if (at < 0) {
					stopped = "章节目录已变化，找不到该章；已重生成结果留在待保存草稿里。";
					break;
				}
				const neighbor = (item: StoryPlan["chapters"][number] | undefined) =>
					item
						? { title: item.title, pov: item.pov, time: item.time ?? "", synopsis: item.synopsis, plot: item.plot, historyEvidence: item.historyEvidence, endingHook: item.endingHook }
						: null;
				setPlanQueue({ ids: chapterIds, index, running: true, done, reason: "" });
				try {
					const response = await fetch(`/api/projects/${projectId}/chapter-plan`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "regenerate",
							chapterId,
							allowExternalTransfer: true,
							previous: neighbor(working.chapters[at - 1]),
							next: neighbor(working.chapters[at + 1]),
						}),
					});
					const result = (await response.json()) as {
						chapter?: Omit<Chapter, "id">;
						issues?: string[];
						error?: string;
					};
					if (!response.ok) throw new Error(result.error ?? "本章章纲重生成失败。");
					if (!result.chapter) throw new Error("模型未返回章节设定。");
					const generated = result.chapter;
					working = {
						...working,
						chapters: working.chapters.map((item) =>
							item.id === chapterId
								? {
										...item,
										title: generated.title || item.title,
										pov: generated.pov || item.pov,
										time: generated.time ?? item.time,
										synopsis: generated.synopsis || item.synopsis,
										plot: generated.plot.length ? generated.plot : item.plot,
										historyEvidence: generated.historyEvidence.length ? generated.historyEvidence : item.historyEvidence,
										fiction: generated.fiction.length ? generated.fiction : item.fiction,
										endingHook: generated.endingHook || item.endingHook,
									}
								: item,
						),
					};
					planRef.current = working;
					setPlan(working);
					setDirty(true);
					done += 1;
					if (result.issues?.length) stopped = `第 ${at + 1} 章提示：${result.issues.join(" ")}`;
				} catch (cause) {
					stopped = cause instanceof Error ? cause.message : "本章章纲重生成失败。";
					break;
				}
			}
			runningPlanQueue.current = false;
			planStopRequested.current = false;
			setPlanQueue({ ids: chapterIds, index: Math.min(done, chapterIds.length - 1), running: false, done, reason: stopped });
			if (stopped) fail(stopped);
			else setMessage(`${done} 章章纲设定已重生成，尚未保存；请逐章审阅后点「保存章节目录」产生新版本。`);
		},
		[projectId, fail],
	);

	const stopPlanQueue = useCallback(() => {
		if (!runningPlanQueue.current) return;
		planStopRequested.current = true;
	}, []);

	const readChapterBackup = useCallback(
		async (chapterId: string) => {
			if (!projectId) return null;
			const response = await fetch(`/api/projects/${projectId}/story?backup=${encodeURIComponent(chapterId)}`, { cache: "no-store" });
			const result = (await response.json()) as { backup?: ChapterBackup | null; error?: string };
			if (!response.ok) throw new Error(result.error ?? "无法读取归档正文。");
			return result.backup ?? null;
		},
		[projectId],
	);

	const restoreChapter = useCallback(
		async (chapterId: string) => {
			const sent = await send("restore", { chapterId });
			if (!sent.ok) return { ok: false, error: sent.error };
			await reload();
			setMessage("已恢复为归档版本，当前正文另存为归档；本章需重新接受后才解锁后续章节。");
			return { ok: true, error: "" };
		},
		[send, reload],
	);

	const stopQueue = useCallback(() => {
		if (!runningQueue.current) return;
		stopRequested.current = true;
	}, []);

	// 卸载或切换作品时不得让仍在等待的队列继续发起下一章请求。
	useEffect(
		() => () => {
			stopRequested.current = true;
			runningQueue.current = false;
			planStopRequested.current = true;
			runningPlanQueue.current = false;
		},
		[],
	);

	const queueRunning = queue.phase === "generating" || queue.phase === "accepting" || queue.phase === "waiting";

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
			queue,
			queueRunning,
			planQueue,
			reload,
			updatePlan,
			savePlan,
			approvePlan,
			runChapter,
			saveChapter,
			acceptChapter,
			startQueue,
			stopQueue,
			regenerateChapterPlans,
			stopPlanQueue,
			readChapterBackup,
			restoreChapter,
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
			queue,
			queueRunning,
			planQueue,
			reload,
			updatePlan,
			savePlan,
			approvePlan,
			runChapter,
			saveChapter,
			acceptChapter,
			startQueue,
			stopQueue,
			regenerateChapterPlans,
			stopPlanQueue,
			readChapterBackup,
			restoreChapter,
		],
	);

	return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}
