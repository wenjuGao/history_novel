import 'server-only'

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'

// 参考小说在项目里的角色只有一个：提供抽象写作规格。小说正文与段落一律不进入任何生成上下文。

export type ReferenceVolume = {
	volume: string
	title: string
	characters: number
	textSha256: string
	convertedAt: string
}

export type RegisteredSeries = {
	key: string
	name: string
	volumes: ReferenceVolume[]
	combinedSha256: string
	spec: { sha256: string; methods: string[]; origin: string; sourcePath: string; characters: number } | null
}

function combinedHash(textSha256s: string[]) {
	return createHash('sha256')
		.update(textSha256s.join('\n'), 'utf8')
		.digest('hex')
}

export function registeredReferenceSeries(): RegisteredSeries[] {
	const novels = db
		.prepare(
			`SELECT series_key AS seriesKey, series AS name, volume, title, characters, text_sha256 AS textSha256, converted_at AS convertedAt
			 FROM reference_novel ORDER BY series_key, volume_order`,
		)
		.all() as Array<{ seriesKey: string; name: string; volume: string; title: string; characters: number; textSha256: string; convertedAt: string }>
	const specs = db
		.prepare(
			`SELECT series_key AS seriesKey, spec_sha256 AS sha256, combined_sha256 AS combinedSha256, methods_json AS methods, origin, source_path AS sourcePath, length(spec_text) AS characters
			 FROM reference_spec`,
		)
		.all() as Array<{ seriesKey: string; sha256: string; combinedSha256: string; methods: string; origin: string; sourcePath: string; characters: number }>

	const grouped = new Map<string, RegisteredSeries>()
	for (const novel of novels) {
		const entry = grouped.get(novel.seriesKey) ?? { key: novel.seriesKey, name: novel.name, volumes: [], combinedSha256: '', spec: null }
		entry.volumes.push({ volume: novel.volume, title: novel.title, characters: novel.characters, textSha256: novel.textSha256, convertedAt: novel.convertedAt })
		grouped.set(novel.seriesKey, entry)
	}
	for (const entry of grouped.values()) {
		entry.combinedSha256 = combinedHash(entry.volumes.map((volume) => volume.textSha256))
		const spec = specs.find((item) => item.seriesKey === entry.key && item.combinedSha256 === entry.combinedSha256)
		if (spec) {
			let methods: string[] = []
			try {
				methods = JSON.parse(spec.methods) as string[]
			} catch {
				methods = []
			}
			entry.spec = { sha256: spec.sha256, methods, origin: spec.origin, sourcePath: spec.sourcePath, characters: spec.characters }
		}
	}
	return [...grouped.values()]
}

export function pinReferenceSeries(projectId: string, seriesKey?: string) {
	const registered = registeredReferenceSeries()
	if (!registered.length) throw new Error('本机尚未登记参考小说，请先执行 npm run refs:register。')
	// 只有一个系列时直接固定它；多系列必须由界面显式选择，避免悄悄选错书。
	const withSpec = registered.filter((series) => series.spec)
	const target = seriesKey ? withSpec.find((series) => series.key === seriesKey) : withSpec.length === 1 ? withSpec[0] : undefined
	if (!target) {
		throw new Error(seriesKey ? '未找到该参考小说系列的本机登记或写作规格。' : `本机有 ${withSpec.length} 个可用系列，请指定要固定的系列。`)
	}
	const now = new Date().toISOString()
	db.transaction(() => {
		db.prepare(
			`INSERT INTO project_reference(project_id, series_key, combined_sha256, spec_sha256, pinned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(project_id) DO UPDATE SET series_key = excluded.series_key, combined_sha256 = excluded.combined_sha256, spec_sha256 = excluded.spec_sha256, updated_at = excluded.updated_at`,
		).run(projectId, target.key, target.combinedSha256, target.spec?.sha256 ?? '', now, now)
		// 固定即把登记规格派生为作品规格草稿（未确认）；只有确认版本进入大纲与正文请求。
		// 文本与最新版本相同时不新增版本（重复固定幂等）。
		if (target.spec) {
			const specRow = db
				.prepare('SELECT spec_text AS specText, methods_json AS methods FROM reference_spec WHERE spec_sha256 = ?')
				.get(target.spec.sha256) as { specText: string; methods: string } | undefined
			if (specRow) {
				const latest = latestSpecVersion(projectId)
				if (!latest || latest.specText !== specRow.specText) {
					const version = (latest?.version ?? 0) + 1
					db.prepare(
						`INSERT INTO project_reference_spec(project_id, version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at)
						 VALUES (?, ?, ?, ?, 'registered', ?, ?, NULL, ?)`,
					).run(projectId, version, specRow.specText, specRow.methods, target.spec.sha256, target.combinedSha256, now)
				}
			}
		}
	})()
	return target
}

export type ProjectSpecVersion = {
	version: number
	specText: string
	methods: string[]
	origin: 'registered' | 'edited'
	baseSpecSha256: string
	sourceCombinedSha256: string
	confirmedAt: string | null
	createdAt: string
}

function toVersion(row: { version: number; spec_text: string; methods_json: string; origin: string; base_spec_sha256: string; source_combined_sha256: string; confirmed_at: string | null; created_at: string }): ProjectSpecVersion {
	let methods: string[] = []
	try {
		methods = JSON.parse(row.methods_json) as string[]
	} catch {
		methods = []
	}
	return {
		version: row.version,
		specText: row.spec_text,
		methods,
		origin: row.origin === 'edited' ? 'edited' : 'registered',
		baseSpecSha256: row.base_spec_sha256,
		sourceCombinedSha256: row.source_combined_sha256,
		confirmedAt: row.confirmed_at,
		createdAt: row.created_at,
	}
}

function latestSpecVersion(projectId: string): ProjectSpecVersion | null {
	const row = db
		.prepare(
			`SELECT version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at
			 FROM project_reference_spec WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
		)
		.get(projectId) as Parameters<typeof toVersion>[0] | undefined
	return row ? toVersion(row) : null
}

export function projectSpecVersions(projectId: string): ProjectSpecVersion[] {
	const rows = db
		.prepare(
			`SELECT version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at
			 FROM project_reference_spec WHERE project_id = ? ORDER BY version`,
		)
		.all(projectId) as Array<Parameters<typeof toVersion>[0]>
	return rows.map(toVersion)
}

// 保存作品规格草稿：编辑产生新版本（未确认），不影响已确认版本继续生效。
// 改版前固定的作品可能一条规格版本都没有，此时以当前固定系列的登记规格为种子，避免卡在「无版本可确认」。
export function saveProjectSpec(projectId: string, specText: string, methods?: string[]) {
	const text = specText.trim()
	if (!text) throw new Error('写作规格不能为空。')
	if (text.length > 100_000) throw new Error('写作规格过长（最多 100,000 字符）。')
	const latest = latestSpecVersion(projectId)
	const seed = latest ?? registeredSpecSeed(projectId)
	if (!seed) throw new Error('请先固定参考小说，再编辑作品写作规格。')
	const version = (latest?.version ?? 0) + 1
	const now = new Date().toISOString()
	db.transaction(() => {
		db.prepare(
			`INSERT INTO project_reference_spec(project_id, version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at)
			 VALUES (?, ?, ?, ?, 'edited', ?, ?, NULL, ?)`,
		).run(projectId, version, text, JSON.stringify(methods?.length ? methods : seed.methods), seed.baseSpecSha256, seed.sourceCombinedSha256, now)
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	return { version }
}

// 当前固定系列的登记规格文本：作品没有本地规格版本时的派生来源。
function registeredSpecSeed(projectId: string) {
	const pinned = db
		.prepare('SELECT series_key AS seriesKey, spec_sha256 AS specSha256 FROM project_reference WHERE project_id = ?')
		.get(projectId) as { seriesKey: string; specSha256: string } | undefined
	if (!pinned?.specSha256) return null
	const spec = db
		.prepare('SELECT spec_text AS specText, methods_json AS methods FROM reference_spec WHERE spec_sha256 = ?')
		.get(pinned.specSha256) as { specText: string; methods: string } | undefined
	if (!spec?.specText.trim()) return null
	const volumes = db
		.prepare('SELECT text_sha256 AS textSha256 FROM reference_novel WHERE series_key = ? ORDER BY volume_order')
		.all(pinned.seriesKey) as Array<{ textSha256: string }>
	let methods: string[] = []
	try {
		methods = JSON.parse(spec.methods) as string[]
	} catch {
		methods = []
	}
	return { specText: spec.specText, methods, baseSpecSha256: pinned.specSha256, sourceCombinedSha256: combinedHash(volumes.map((volume) => volume.textSha256)) }
}

// 确认作品规格版本：确认后该版本进入大纲与正文请求。
export function confirmProjectSpec(projectId: string, version: number) {
	const row = db.prepare('SELECT version, spec_text, confirmed_at FROM project_reference_spec WHERE project_id = ? AND version = ?').get(projectId, version) as
		| { version: number; spec_text: string; confirmed_at: string | null }
		| undefined
	if (!row) throw new Error('规格版本不存在。')
	if (!row.spec_text.trim()) throw new Error('规格内容为空，无法确认。')
	const active = db
		.prepare('SELECT version FROM project_reference_spec WHERE project_id = ? AND confirmed_at IS NOT NULL ORDER BY version DESC LIMIT 1')
		.get(projectId) as { version: number } | undefined
	if (active && row.version < active.version) {
		throw new Error(`生效版本只能前进：当前已确认到 v${active.version}，如需采用更早的写法请把它另存为新草稿再确认。`)
	}
	const now = new Date().toISOString()
	db.transaction(() => {
		db.prepare('UPDATE project_reference_spec SET confirmed_at = ? WHERE project_id = ? AND version = ?').run(now, projectId, version)
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	return { version, confirmedAt: now }
}

export type ActiveReferenceSpec = {
	seriesKey: string
	series: string
	/** 仅在 version 非空（存在已确认版本）时有值；未确认时保持空串，调用方不得用它判断「已确认」。 */
	specSha256: string
	combinedSha256: string
	specText: string
	methods: string[]
	origin: string
	volumes: number
	version: number | null
	pendingVersion: number | null
	drift: string | null
	driftKind: 'source' | 'series' | null
}

// 生成上下文只允许取规格文本，且只用作品已确认的规格版本；
// 同时报告：登记源文本或所属系列是否变化（需复核）、是否存在未确认的更新草稿。
export function activeReferenceSpec(projectId: string): ActiveReferenceSpec | null {
	const pinned = db
		.prepare('SELECT series_key AS seriesKey, combined_sha256 AS combinedSha256, spec_sha256 AS specSha256 FROM project_reference WHERE project_id = ?')
		.get(projectId) as { seriesKey: string; combinedSha256: string; specSha256: string } | undefined
	if (!pinned) return null
	const volumes = db
		.prepare('SELECT text_sha256 AS textSha256, volume FROM reference_novel WHERE series_key = ? ORDER BY volume_order')
		.all(pinned.seriesKey) as Array<{ textSha256: string; volume: string }>
	const seriesName = (db.prepare('SELECT series AS name FROM reference_novel WHERE series_key = ? LIMIT 1').get(pinned.seriesKey) as { name?: string } | undefined)?.name ?? pinned.seriesKey
	if (!volumes.length) {
		return { ...pinned, specSha256: '', series: seriesName, specText: '', methods: [], origin: 'model', volumes: 0, version: null, pendingVersion: null, drift: '参考小说系列已从本机登记中消失', driftKind: 'series' }
	}
	const current = combinedHash(volumes.map((volume) => volume.textSha256))

	// 只取生效版本与最新版本两行：规格文本可达数万字符，逐版本全量载入会让每次轮询都重算哈希。
	const confirmed = confirmedSpecVersion(projectId)
	const latest = latestSpecVersion(projectId)

	// 兜底：作品尚无规格版本（008 之前固定且未回填的极端情况），沿用登记规格文本供展示与派生草稿，但它不算已确认版本。
	if (!confirmed && !latest) {
		const seed = registeredSpecSeed(projectId)
		if (!seed) {
			return { ...pinned, specSha256: '', series: seriesName, specText: '', methods: [], origin: 'model', volumes: volumes.length, version: null, pendingVersion: null, drift: '找不到与项目哈希匹配的写作规格', driftKind: 'series' }
		}
		return {
			seriesKey: pinned.seriesKey,
			series: seriesName,
			specSha256: '',
			combinedSha256: current,
			specText: seed.specText,
			methods: seed.methods,
			origin: 'registered',
			volumes: volumes.length,
			version: null,
			pendingVersion: null,
			drift: current === pinned.combinedSha256 ? '写作规格尚无已确认版本，请保存并确认一个版本。' : '本机小说文本已变化，规格需重新生成',
			driftKind: current === pinned.combinedSha256 ? null : 'source',
		}
	}

	// drift 只表示登记来源变化（需要重新登记或重新确认）；规格尚未确认由 version=null 表达，不混在这里，
	// 否则「参考资料」面板会把它说成登记问题，也会破坏既有回归对 drift 的断言。
	const sourceDrifted = Boolean(confirmed?.sourceCombinedSha256) && confirmed?.sourceCombinedSha256 !== current
	const seriesDrifted = !sourceDrifted && Boolean(confirmed?.baseSpecSha256) && Boolean(pinned.specSha256) && confirmed?.baseSpecSha256 !== pinned.specSha256
	return {
		seriesKey: pinned.seriesKey,
		series: seriesName,
		specSha256: confirmed ? createHash('sha256').update(confirmed.specText, 'utf8').digest('hex') : '',
		combinedSha256: current,
		specText: confirmed?.specText ?? '',
		methods: confirmed?.methods ?? [],
		origin: confirmed?.origin ?? 'registered',
		volumes: volumes.length,
		version: confirmed?.version ?? null,
		pendingVersion: latest && latest.version !== confirmed?.version ? latest.version : null,
		drift: sourceDrifted
			? '登记源文本已变化，请重新登记后再固定'
			: seriesDrifted
				? '已确认的规格版本不属于当前固定的参考系列，请重新编辑并确认规格'
				: null,
		driftKind: sourceDrifted ? 'source' : seriesDrifted ? 'series' : null,
	}
}

// 当前生效的已确认规格版本（版本号最大的那一条）。
function confirmedSpecVersion(projectId: string): ProjectSpecVersion | null {
	const row = db
		.prepare(
			`SELECT version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at
			 FROM project_reference_spec WHERE project_id = ? AND confirmed_at IS NOT NULL ORDER BY version DESC LIMIT 1`,
		)
		.get(projectId) as Parameters<typeof toVersion>[0] | undefined
	return row ? toVersion(row) : null
}
