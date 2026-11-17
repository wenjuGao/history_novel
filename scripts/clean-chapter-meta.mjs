// 一次性清理：把历史草稿中混入正文的元信息（事实依据/虚构说明/待核查问题/写作规格说明）
// 从 content 中剥离，结构化写入 meta_json；原始输出保留到 raw_output。
// 支持两种遗留格式：[[META]] 分隔标记，以及「--- + ### 事实依据…」的 markdown 标题块。
// 用法：node scripts/clean-chapter-meta.mjs [--dry]
import Database from "better-sqlite3";
import path from "node:path";

const dry = process.argv.includes("--dry");
const dataDirectory = process.env.HISTORY_DATA_DIR || path.join(process.cwd(), "data", "local");
const db = new Database(path.join(dataDirectory, "workspace.sqlite"));
db.pragma("journal_mode = WAL");

const metaMarker = "[[META]]";
const metaHeadingPattern = /^#{1,6}\s*\**\s*(事实依据|虚构说明|待核查问题|写作规格(?:应用)?说明|写作规格)\s*\**\s*[:：]?\s*$/;
const metaResiduePattern = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:事实依据|虚构说明|待核查问题|写作规格(?:应用)?说明|写作规格)(?:\*\*)?\s*[:：]/;
const metaSeparatorPattern = /^[-*_]{3,}\s*$/;

function normalizeMeta(value) {
	const source = typeof value === "object" && value !== null ? value : {};
	const toList = (input) =>
		(Array.isArray(input) ? input : input === undefined || input === null ? [] : [input])
			.map((item) => (typeof item === "string" ? item.trim() : JSON.stringify(item)))
			.filter(Boolean);
	return {
		factBasis: toList(source.factBasis ?? source["事实依据"]),
		fictionNotes: toList(source.fictionNotes ?? source["虚构说明"]),
		openQuestions: toList(source.openQuestions ?? source["待核查问题"]),
		specNotes: toList(source.specNotes ?? source["写作规格应用说明"] ?? source["写作规格"]),
	};
}

function findLegacyMetaLineIndex(lines) {
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim()) continue;
		if (metaHeadingPattern.test(line) || metaResiduePattern.test(line)) {
			let start = index;
			let previous = index - 1;
			while (previous >= 0 && !lines[previous].trim()) previous -= 1;
			if (previous >= 0 && metaSeparatorPattern.test(lines[previous])) start = previous;
			return start;
		}
	}
	return -1;
}

function parseLegacyMeta(text) {
	const result = { factBasis: [], fictionNotes: [], openQuestions: [], specNotes: [] };
	let current = null;
	const itemPattern = /^\s*(?:\d+\s*[.、)]|[*•\-]\s+)\s*(.*)$/;
	for (const line of text.split(/\r?\n/)) {
		const heading = line.match(metaHeadingPattern);
		if (heading) {
			const label = heading[1];
			current = label === "事实依据" ? "factBasis" : label === "虚构说明" ? "fictionNotes" : label === "待核查问题" ? "openQuestions" : "specNotes";
			continue;
		}
		if (!current) continue;
		const item = line.match(itemPattern);
		if (item) {
			const value = item[1].trim();
			if (!value) continue;
			if (current === "notes") result.notes = result.notes ? `${result.notes}\n${value}` : value;
			else result[current].push(value);
		} else if (line.trim() && current !== "notes") {
			const bucket = result[current];
			if (bucket.length) bucket[bucket.length - 1] += line.trim();
		}
	}
	const empty = !result.factBasis.length && !result.fictionNotes.length && !result.openQuestions.length && !result.specNotes.length && !result.notes;
	return empty ? null : result;
}

function splitChapterOutput(raw) {
	const markerIndex = raw.indexOf(metaMarker);
	let meta = null;
	let body = (markerIndex >= 0 ? raw.slice(0, markerIndex) : raw).trimEnd();
	if (markerIndex < 0) {
		const lines = body.split(/\r?\n/);
		const metaStart = findLegacyMetaLineIndex(lines);
		if (metaStart >= 0) {
			meta = parseLegacyMeta(lines.slice(metaStart).join("\n"));
			body = lines.slice(0, metaStart).join("\n").trimEnd();
		}
	}
	const metaPart = markerIndex >= 0 ? raw.slice(markerIndex + metaMarker.length).trim() : "";
	if (metaPart) {
		const candidate = metaPart.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
		try {
			meta = normalizeMeta(JSON.parse(candidate));
		} catch {
			meta = { ...normalizeMeta(null), notes: metaPart };
		}
	}
	return { body, meta };
}

const rows = db.prepare("SELECT rowid, project_id, plan_version, chapter_id, content, meta_json FROM chapter_drafts").all();
const updates = [];
for (const row of rows) {
	const raw = row.content ?? "";
	if (!raw.trim()) continue;
	const { body, meta } = splitChapterOutput(raw);
	if (body === raw.trimEnd() && !meta) continue;
	updates.push({ ...row, body, meta });
}

if (dry) {
	console.log(`[dry] 将清理 ${updates.length} 条草稿：`);
	for (const item of updates) {
		const counts = item.meta ? Object.entries(item.meta).filter(([, value]) => (Array.isArray(value) ? value.length : Boolean(value))).map(([key, value]) => `${key}:${Array.isArray(value) ? value.length : "✓"}`).join(", ") : "无元信息";
		console.log(`- ${item.project_id} v${item.plan_version} ${item.chapter_id} 正文 ${item.body.length} 字符（原 ${item.content.length}）；${counts}`);
	}
} else {
	const update = db.prepare("UPDATE chapter_drafts SET content = ?, meta_json = ?, raw_output = COALESCE(raw_output, ?) WHERE rowid = ?");
	db.transaction(() => {
		for (const item of updates) update.run(item.body, item.meta ? JSON.stringify(item.meta) : item.meta_json, item.content, item.rowid);
	})();
	console.log(`已清理 ${updates.length} 条草稿；原始输出已存入 raw_output。`);
}
db.close();
