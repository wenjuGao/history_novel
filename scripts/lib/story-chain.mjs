import assert from 'node:assert/strict'

// 回归脚本共用的前置链路：范围 → 上传原文 → 人物与关系 → 采用事件 → 本地剧情提案 → 本地骨架章纲。
// 全程只走零 Token 的本地路径（`action: 'local'` / `action: 'skeleton'`），不产生任何模型请求。
const chronicled = '元年，太祖以汴州为开国之地，会群臣于内殿。'

// 002 迁移建的表（关系、虚构设定、人物活动）没有级联规则，删作品前必须先清掉它们。
const cleanupStatements = [
	'DELETE FROM plot_event_participants WHERE event_id IN (SELECT id FROM plot_events WHERE project_id = ?)',
	'DELETE FROM character_activity WHERE character_id IN (SELECT id FROM characters WHERE project_id = ?)',
	'DELETE FROM plot_events WHERE project_id = ?',
	'DELETE FROM historical_relations WHERE project_id = ?',
	'DELETE FROM fiction_settings WHERE project_id = ?',
	'DELETE FROM chapter_drafts WHERE project_id = ?',
	'DELETE FROM chapter_generation_attempts WHERE project_id = ?',
	// 010 迁移建的本章状态表没有级联规则，清掉它才不会让后续作品读到上一部的既定事实。
	'DELETE FROM chapter_states WHERE project_id = ?',
	'DELETE FROM characters WHERE project_id = ?',
	'DELETE FROM documents WHERE project_id = ?',
	'DELETE FROM story_plan_approvals WHERE project_id = ?',
	'DELETE FROM story_plan_revisions WHERE project_id = ?',
	'DELETE FROM story_plans WHERE project_id = ?',
	'DELETE FROM plot_proposals WHERE project_id = ?',
	'DELETE FROM project_scope WHERE project_id = ?',
	'DELETE FROM project_corpus WHERE project_id = ?',
	'DELETE FROM project_reference WHERE project_id = ?',
	'DELETE FROM project_reference_spec WHERE project_id = ?',
	'DELETE FROM project_auto_settings WHERE project_id = ?',
	'DELETE FROM auto_runs WHERE project_id = ?',
	'DELETE FROM projects WHERE id = ?',
]

/** 按依赖顺序删除测试作品；传入 better-sqlite3 连接与作品 ID。 */
export function cleanupStoryProject(database, projectId) {
	for (const sql of cleanupStatements) database.prepare(sql).run(projectId)
}

export async function seedStoryPlan(base, { name, plannedChapters = 2, extraEvents = 0 } = {}) {
	const send = async (route, body, expected = 200, method) => {
		const isGet = body === undefined
		const response = await fetch(`${base}${route}`, {
			method: isGet ? 'GET' : method ?? 'POST',
			headers: { origin: base, 'content-type': 'application/json' },
			body: isGet ? undefined : JSON.stringify(body),
		})
		const data = await response.json()
		assert.equal(response.status, expected, `${route} -> ${JSON.stringify(data)}`)
		return data
	}

	const project = await send('/api/projects', { name }, 201)
	const projectId = project.project.id
	const routes = {
		scope: `/api/projects/${projectId}/scope`,
		documents: `/api/projects/${projectId}/documents`,
		setup: `/api/projects/${projectId}/setup`,
		events: `/api/projects/${projectId}/events`,
		references: `/api/projects/${projectId}/references`,
		proposals: `/api/projects/${projectId}/proposals`,
		outline: `/api/projects/${projectId}/outline`,
		story: `/api/projects/${projectId}/story`,
	}

	await send(routes.scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')
	const form = new FormData()
	form.append('category', 'history')
	form.append('file', new File([chronicled], 'chronicle.txt', { type: 'text/plain' }))
	const upload = await fetch(`${base}${routes.documents}`, { method: 'POST', headers: { origin: base }, body: form })
	assert.equal(upload.status, 201, await upload.text())
	const documentId = (await send(routes.documents)).documents.find((item) => !item.corpusRef).id

	for (const person of [
		{ name: '朱全忠', start: '904', end: '907', region: '汴州' },
		{ name: '李克用', start: '904', end: '908', region: '洛阳' },
	]) {
		await send(routes.setup, { action: 'person', ...person, documentId, evidence: chronicled, confirmed: true })
	}
	const people = (await send(routes.setup)).people
	const zhu = people.find((item) => item.name === '朱全忠')
	const li = people.find((item) => item.name === '李克用')
	await send(routes.setup, { action: 'select', id: zhu.id, selected: true })
	await send(routes.setup, { action: 'relation', from: zhu.id, to: li.id, label: '彼此讨伐', start: '905', end: '907', documentId, evidence: chronicled, confirmed: true })

	await send(routes.events, { action: 'adopt', sourceKey: `activity:${zhu.id}`, confirmed: true })
	await send(routes.events, {
		action: 'add',
		title: '宣武军入朝',
		kind: 'historical',
		start: 906,
		end: 906,
		documentId,
		evidence: chronicled,
		confirmed: true,
		participants: [li.id],
	})
	// 本地骨架章纲每章至少一条已采用事件，需要更多章节时补采事件。
	for (let index = 1; index <= extraEvents; index += 1) {
		await send(routes.events, {
			action: 'add',
			title: `汴州议事 ${index}`,
			kind: 'historical',
			start: 907 + (index % 3),
			end: 907 + (index % 3),
			documentId,
			evidence: chronicled,
			confirmed: true,
			participants: [zhu.id],
		})
	}
	assert.equal((await send(routes.outline)).evidence.length, 2 + extraEvents, '链路应备齐已采用证据')

	// 新建项目会自动固定参考小说；未确认写作规格时章纲进不去（REQ-010）。
	const references = await send(routes.references)
	if (references.pinned && references.pinned.version === null) {
		await send(routes.references, { action: 'confirmSpec', version: references.pinned.pendingVersion })
	}

	await send(routes.proposals, { action: 'local' })
	await send(routes.proposals, { action: 'select', slot: 1 })
	await send(routes.outline, { action: 'skeleton', plannedChapters })
	const state = await send(routes.story)
	assert.equal(state.proposalIssue, null, '骨架章纲应绑定选定提案')
	return { projectId, routes, send, state, documentId, chronicled }
}
