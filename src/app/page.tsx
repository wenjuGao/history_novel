import { billingMode } from "@/lib/bailian-endpoint.mjs";
import { BAILIAN_MODELS } from "@/lib/bailian";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listProjects, resolveProjectEntry } from "@/lib/projects";
import { OverviewHome, type CorpusRow, type ModelInfo, type WorkSummary } from "@/components/overview-home";

export const dynamic = "force-dynamic";

const books: Array<{ title: string; summary: string; icon: CorpusRow["icon"]; group: "histories" | "chronicle" }> = [
	{ title: "二十四史", summary: "正史原文 · 24 部", icon: "histories", group: "histories" },
	{ title: "资治通鉴", summary: "编年通史", icon: "chronicle", group: "chronicle" },
];

// 概览目录与 /api/models 同源于服务端 allowlist，避免两处价格与文案漂移。
const modelCatalog = Object.entries(BAILIAN_MODELS).map(([id, model]) => ({
	id,
	name: model.name,
	role: model.role,
	price: `¥${model.inputPricePerMillion} / ¥${model.outputPricePerMillion}`,
}));

const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

async function getCorpusRows(): Promise<CorpusRow[]> {
	try {
		const dataRoot = path.join(process.cwd(), "data");
		const [catalogText, reportText] = await Promise.all([
			readFile(path.join(dataRoot, "catalog/history-books.json"), "utf8"),
			readFile(path.join(dataRoot, "local/corpus/wikisource/report.json"), "utf8"),
		]);
		const catalog = JSON.parse(catalogText) as {
			books: Array<{ id: string; category: string; expectedPageCount: number }>;
		};
		const report = JSON.parse(reportText) as {
			books: Array<{
				bookId: string;
				expectedPageCount: number;
				collectedPageCount: number;
				failed: number;
				complete: boolean;
			}>;
		};
		const statuses = new Map(report.books.map((status) => [status.bookId, status]));

		return books.map((book) => {
			const sourceBooks = catalog.books.filter((item) =>
				book.group === "histories" ? item.category === "二十四史" : item.id === "zizhitongjian",
			);
			const expected = sourceBooks.reduce((sum, item) => sum + item.expectedPageCount, 0);
			const collected = sourceBooks.reduce((sum, item) => sum + (statuses.get(item.id)?.collectedPageCount ?? 0), 0);
			const statusesKnown = sourceBooks.length > 0 && sourceBooks.every((item) => statuses.has(item.id));
			const complete =
				statusesKnown &&
				sourceBooks.every((item) => {
					const status = statuses.get(item.id);
					return status?.complete && status.failed === 0 && status.collectedPageCount === item.expectedPageCount;
				});
			const label = complete
				? "已采集"
				: statusesKnown
					? collected > 0
						? "部分采集"
						: "待采集"
					: "状态未知";

			return {
				title: book.title,
				icon: book.icon,
				detail: `${book.summary} · ${collected}/${expected} 卷`,
				label,
				complete,
			};
		});
	} catch {
		return books.map((book) => ({
			title: book.title,
			icon: book.icon,
			detail: `${book.summary} · 进度未知`,
			label: "状态未知",
			complete: false,
		}));
	}
}

export default async function Home() {
	const hasApiKey = Boolean(process.env.DASHSCOPE_API_KEY);
	let models: ModelInfo = { billingMode: "unconfigured", hasApiKey, baseUrlHost: "配置无效", models: modelCatalog };
	try {
		const url = new URL(process.env.BAILIAN_BASE_URL?.trim() || defaultBaseUrl);
		models = {
			billingMode: billingMode(process.env.BAILIAN_BASE_URL) === "token-plan" ? "token-plan" : "pay-as-you-go",
			hasApiKey,
			baseUrlHost: url.hostname,
			models: modelCatalog,
		};
	} catch {
		// 配置错误由 /api/models 明确暴露，概览只退回未配置状态。
	}

	const corpus = await getCorpusRows();
	const works: WorkSummary[] = listProjects().map((project) => ({
		...project,
		entry: resolveProjectEntry(project.id),
		updatedAtLabel: new Date(project.updatedAt).toLocaleString("zh-CN"),
	}));

	return <OverviewHome corpus={corpus} models={models} works={works} />;
}
