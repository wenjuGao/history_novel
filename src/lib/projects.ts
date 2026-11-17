import 'server-only'

import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { pinCorpus } from '@/lib/source-text'
import { pinReferenceSeries } from '@/lib/reference-spec'

export type Project = {
	id: string
	name: string
	createdAt: string
	updatedAt: string
	version: number
}

type ProjectRow = {
	id: string
	name: string
	created_at: string
	updated_at: string
	version: number
}

function toProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		version: row.version
	}
}

export function listProjects(): Project[] {
	const rows = db.prepare('SELECT id, name, created_at, updated_at, version FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
	return rows.map(toProject)
}

export function getProject(id: string): Project | null {
	const row = db.prepare('SELECT id, name, created_at, updated_at, version FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
	return row ? toProject(row) : null
}

/** 作品入口：回到首个未完成的前置步骤；全部就绪时回到章节目录。 */
export type ProjectEntryStep = 'scope' | 'references' | 'persons' | 'events' | 'proposals' | 'outline' | 'chapters'

export function resolveProjectEntry(projectId: string): ProjectEntryStep {
	const has = (sql: string) => Boolean(db.prepare(sql).get(projectId))
	if (!has('SELECT 1 FROM project_scope WHERE project_id = ? LIMIT 1')) return 'scope'
	// 古籍固定是证据校验的前提；参考小说固定决定写作规格可用性。
	if (!has('SELECT 1 FROM project_corpus WHERE project_id = ? LIMIT 1')) return 'references'
	if (!has('SELECT 1 FROM project_reference WHERE project_id = ? LIMIT 1')) return 'references'
	if (!has('SELECT 1 FROM characters WHERE project_id = ? AND selected = 1 LIMIT 1')) return 'persons'
	if (!has("SELECT 1 FROM plot_events WHERE project_id = ? AND status = 'adopted' AND kind = 'historical' AND needs_review = 0 LIMIT 1")) return 'events'
	// REQ-056：章纲必须绑定选定提案，未选定回到提案步骤。
	if (!has("SELECT 1 FROM plot_proposals WHERE project_id = ? AND status = 'selected' LIMIT 1")) return 'proposals'
	if (!has('SELECT 1 FROM story_plans WHERE project_id = ? LIMIT 1')) return 'outline'
	return 'chapters'
}

export function createProject(name: string): Project {
	const normalizedName = name.trim()
	if (normalizedName.length < 1 || normalizedName.length > 80) {
		throw new Error('项目名称需为 1 至 80 个字符。')
	}

	const now = new Date().toISOString()
	const row: ProjectRow = {
		id: randomUUID(),
		name: normalizedName,
		created_at: now,
		updated_at: now,
		version: 1
	}

	db.prepare('INSERT INTO projects (id, name, created_at, updated_at, version) VALUES (@id, @name, @created_at, @updated_at, @version)').run(row)
	// 新建项目即固定本机全量古籍语料，以及本机唯一/默认的参考小说（只提供抽象写作规格）。
	// 两者尚未入库时不阻断建项目，由「参考资料」面板提示重试。
	try {
		pinCorpus(row.id)
	} catch {
		// 忽略：corpus_state 为空时留待用户在资料面板执行 npm run corpus:index 后重新固定。
	}
	try {
		pinReferenceSeries(row.id)
	} catch {
		// 忽略：参考小说未登记时留待 npm run refs:register 后重新固定。
	}

	return toProject(row)
}
