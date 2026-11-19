import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { cleanupStoryProject } from './lib/story-chain.mjs'

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000'
const database = new Database(path.join(process.env.HISTORY_DATA_DIR ?? 'data/local', 'workspace.sqlite'))
database.pragma('foreign_keys = ON')
let projectId

async function call(route, body, expected = 200, method) {
	const isGet = body === undefined
	const response = await fetch(`${base}${route}`, {
		method: isGet ? 'GET' : method ?? 'POST',
		headers: { origin: base, 'content-type': 'application/json' },
		body: isGet ? undefined : JSON.stringify(body),
	})
	const data = await response.json()
	assert.equal(response.status, expected, JSON.stringify(data))
	return data
}

const chronicled = '元年，太祖以汴州为开国之地，会群臣于内殿。'

try {
	const project = await call('/api/projects', { name: `剧情事件测试-${Date.now()}` }, 201)
	projectId = project.project.id
	const scope = `/api/projects/${projectId}/scope`
	const documents = `/api/projects/${projectId}/documents`
	const setup = `/api/projects/${projectId}/setup`
	const events = `/api/projects/${projectId}/events`
	const references = `/api/projects/${projectId}/references`
	const proposals = `/api/projects/${projectId}/proposals`
	const outline = `/api/projects/${projectId}/outline`
	const story = `/api/projects/${projectId}/story`

	await call(scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')
	const form = new FormData()
	form.append('category', 'history')
	form.append('file', new File([chronicled], 'chronicle.txt', { type: 'text/plain' }))
	const upload = await fetch(`${base}${documents}`, { method: 'POST', headers: { origin: base }, body: form })
	assert.equal(upload.status, 201, await upload.text())
	// 新建项目会自动固定本机古籍，资料列表首位不再保证是本次上传的测试原文，须显式取非语料条目。
	const documentId = (await call(documents)).documents.find((item) => !item.corpusRef).id

	for (const person of [
		{ name: '朱全忠', start: '904', end: '907', region: '汴州' },
		{ name: '李克用', start: '904', end: '908', region: '洛阳' },
	]) {
		await call(setup, { action: 'person', ...person, documentId, evidence: chronicled, confirmed: true })
	}
	const people = (await call(setup)).people
	const zhu = people.find((item) => item.name === '朱全忠')
	const li = people.find((item) => item.name === '李克用')
	await call(setup, { action: 'select', id: zhu.id, selected: true })
	await call(setup, { action: 'relation', from: zhu.id, to: li.id, label: '彼此讨伐', start: '905', end: '907', documentId, evidence: chronicled, confirmed: true })

	const initial = await call(events)
	assert.equal(initial.candidates.length, 3, 'two activities plus one relation')
	assert.equal(initial.events.length, 0)

	// T050：派生候选只能由作者核对原文后采用，未勾选核对与重复采用都要拒绝。
	await call(events, { action: 'adopt', sourceKey: `activity:${zhu.id}`, confirmed: false }, 400)
	await call(events, { action: 'adopt', sourceKey: `activity:${zhu.id}`, confirmed: true })
	const adopted = await call(events)
	assert.equal(adopted.events.length, 1)
	assert.equal(adopted.candidates.length, 2)
	assert.equal(adopted.events[0].status, 'adopted')
	assert.equal(adopted.events[0].origin, 'derived')
	assert.deepEqual(adopted.events[0].participants.map((item) => item.id), [zhu.id])
	await call(events, { action: 'adopt', sourceKey: `activity:${zhu.id}`, confirmed: true }, 400)

	await call(events, { action: 'add', title: '空白的夜谈', kind: 'fiction', start: 905, end: 905 })
	await call(events, { action: 'add', title: '缺证据', kind: 'historical', start: 905, end: 905 }, 400)
	await call(events, { action: 'add', title: '错证据', kind: 'historical', start: 905, end: 905, documentId, evidence: '原文没有这句话', confirmed: true }, 400)
	await call(events, { action: 'add', title: '未确认', kind: 'historical', start: 905, end: 905, documentId, evidence: chronicled }, 400)
	await call(events, { action: 'add', title: '超出范围', kind: 'fiction', start: 1200, end: 1201 }, 400)
	await call(events, { action: 'add', title: '宣武军入朝', kind: 'historical', start: 906, end: 906, documentId, evidence: chronicled, confirmed: true, participants: [li.id] })

	const list = await call(events)
	assert.equal(list.events.length, 3)
	const fictionEvent = list.events.find((item) => item.kind === 'fiction')
	assert.equal((await call(events, { action: 'update', id: fictionEvent.id, status: 'reject' })).events.find((item) => item.id === fictionEvent.id).status, 'rejected')
	assert.equal((await call(events, { action: 'update', id: fictionEvent.id, status: 'restore' })).events.find((item) => item.id === fictionEvent.id).status, 'candidate')

	// T051：新建项目自动固定参考小说，写作规格停在草稿版本，确认前大纲有前置阻断。
	assert.match((await call(outline)).blocked, /写作规格尚未确认/)
	await call(references, { action: 'confirmSpec', version: 1 })

	// T052：规格确认后章纲仍未解锁——必须先在同一组已采用史实上选定一份剧情提案。
	assert.match((await call(outline)).blocked, /剧情提案/)
	await call(outline, { plannedChapters: 6 }, 409)
	const proposalState = await call(proposals)
	assert.equal(proposalState.blocked, null)
	assert.deepEqual(proposalState.evidence.map((item) => item.id), ['E1', 'E2'])
	assert.equal(proposalState.proposals.length, 0)
	const proposalPreview = await call(proposals, {})
	assert.equal(proposalPreview.dryRun, true)
	assert.equal(proposalPreview.prompt.user.adoptedEvents.length, 2)
	assert.ok(proposalPreview.estimate.inputTokenAllowance > 0)
	await call(proposals, { action: 'generate' }, 400)
	await call(proposals, { action: 'select', slot: 4 }, 400)
	const locals = await call(proposals, { action: 'local' })
	assert.equal(locals.proposals.length, 3, 'local proposals fill all three slots')
	assert.ok(locals.proposals.every((item) => item.source === 'local' && item.status === 'draft'))
	assert.ok(locals.proposals.every((item) => item.inputHash === proposalState.inputHash))
	assert.ok(locals.proposals.every((item) => item.evidence.length && item.evidence.every((id) => ['E1', 'E2'].includes(id))))
	const badEvidence = await call(proposals, {
		action: 'save',
		slot: 1,
		proposal: { title: '编造依据', viewpoint: '限知', mainLine: '主线', synopsis: '', conflicts: ['冲突'], fiction: ['虚构'], evidence: ['E9'] },
	}, 400)
	assert.match(badEvidence.error, /不存在的证据编号/)
	await call(proposals, { action: 'save', slot: 1, proposal: { title: '缺冲突', viewpoint: '限知', mainLine: '主线', synopsis: '', conflicts: [], fiction: ['虚构'], evidence: ['E1'] } }, 400)
	const chosen = await call(proposals, { action: 'select', slot: 2 })
	assert.equal(chosen.selected.slot, 2)
	assert.equal((await call(outline)).blocked, null)
	// 重生成只替换未选定的槽位：选定的一份原地不动，其余各追加新版本。
	const regenerated = await call(proposals, { action: 'local' })
	const kept = regenerated.proposals.find((item) => item.slot === 2)
	assert.equal(kept.revision, 1)
	assert.equal(kept.title, locals.proposals.find((item) => item.slot === 2).title)
	assert.equal(kept.status, 'selected')
	assert.equal(regenerated.proposals.find((item) => item.slot === 1).revision, 2)
	// 人工改写另存为新版本并标明来源，选定状态留在槽位上不丢。
	const edited = await call(proposals, {
		action: 'save',
		slot: 2,
		proposal: { title: '双人物对照（改写）', viewpoint: '两人限知轮换', mainLine: '按人分线推进', synopsis: '改写后的梗概', conflicts: ['取舍代价'], fiction: ['会面属虚构'], evidence: ['E1', 'E2'] },
	})
	assert.equal(edited.proposal.source, 'manual')
	assert.equal(edited.proposal.revision, 2)
	assert.equal(edited.proposal.status, 'selected')
	const listed = await call(proposals)
	assert.equal(listed.selected.revision, 2)
	assert.equal(listed.history.find((item) => item.slot === 2).revisions.length, 2, 'previous drafts stay readable')
	// 史实变化后旧提案不能直接选定，须先按新输入重新生成。
	const driftedScope = { startYear: 900, endYear: 911, region: '汴州、洛阳' }
	await call(scope, driftedScope, 200, 'PUT')
	const staleSelect = await call(proposals, { action: 'select', slot: 1 }, 409)
	assert.match(staleSelect.error, /史实已变化/)
	// 评审修复：人工改写只动文字，不得将过期提案重新盖章成新输入版本，否则 REQ-050 的位置式证据编号会静默改指其他条目。
	const duringDrift = await call(proposals)
	assert.ok(duringDrift.evidence.length > 0, '漂移范围内仍有已采用事件，改写提案时沿用其证据编号')
	const reworded = await call(proposals, {
		action: 'save',
		slot: 2,
		proposal: { title: '过期提案的改写', viewpoint: '两人限知轮换', mainLine: '按人分线推进', synopsis: '', conflicts: ['取舍代价'], fiction: ['会面属虚构'], evidence: duringDrift.evidence.map((item) => item.id) },
	})
	assert.equal(reworded.proposal.inputHash, duringDrift.selected.inputHash, '人工改写必须保留提案原有的输入版本')
	assert.match((await call(proposals, { action: 'select', slot: 2 }, 409)).error, /史实已变化/, '改写后的过期提案仍不得选定')
	await call(scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')
	const rebased = await call(proposals)
	assert.equal(rebased.selected.inputHash, rebased.inputHash)

	const outlineState = await call(outline)
	assert.equal(outlineState.blocked, null)
	assert.deepEqual(
		outlineState.evidence.map((item) => item.id),
		['E1', 'E2'],
	)
	assert.equal(outlineState.generationContext.evidence.length, 2)
	assert.ok(outlineState.generationContext.historicalCharacters.includes('朱全忠'))

	const preview = await call(outline, { plannedChapters: 6 })
	assert.equal(preview.dryRun, true)
	assert.ok(preview.estimate.inputTokenAllowance > 0)
	assert.equal(preview.prompt.user.adoptedEvents.length, 2)
	// 需求 2：章数放开到 1000，预览按「一次一组（最多 10 章）」回显调用次数与折算后的合计用量。
	assert.equal(preview.groups, 1, '6 章一次调用即可')
	const fullGroup = await call(outline, { plannedChapters: 10 })
	assert.equal(fullGroup.groups, 1)
	const grouped = await call(outline, { plannedChapters: 25 })
	assert.equal(grouped.groups, 3)
	assert.equal(grouped.estimate.maxOutputTokens, fullGroup.estimate.maxOutputTokens * 3, '输出上限按整组章数折算再乘组数')
	assert.ok(Math.abs(grouped.estimate.inputTokenAllowance / 3 - fullGroup.estimate.inputTokenAllowance) < 64, '合计输入须是三次同规模调用的累加')
	assert.match(grouped.prompt.user.instructions, /本次只输出第 1 至 10 章/)
	await call(outline, { plannedChapters: 0 }, 400)
	await call(outline, { plannedChapters: 1001 }, 400)
	await call(outline, { action: 'generate', plannedChapters: 4 }, 400)

	const draft = {
		schemaVersion: 2,
		title: '汴上新年',
		synopsis: '两个势力在年号之间摇摆。',
		centralQuestion: '改元之后，旧年号还能用多久？',
		scope: { period: '900—910', regions: ['汴州', '洛阳'], plannedChapters: 2 },
		historicalAnchors: [{ evidenceId: 'E1', fact: '太祖以汴州为开国之地。' }],
		fictionBoundary: ['驿站文书与夜谈均属虚构。'],
		chapters: [
			{
				id: 'chapter-01',
				title: '新旗',
				pov: '沈砚',
				synopsis: '更名后的公文进入驿站。',
				plot: ['核对货单。', '军将带走领队。'],
				historyEvidence: ['E1'],
				fiction: ['沈砚其人属虚构。'],
				endingHook: '货单背面另有一行字。',
			},
			{
				id: 'chapter-02',
				title: '旧年号',
				pov: '李克用',
				synopsis: '河东仍用旧年号。',
				plot: ['账册年月不一致。'],
				historyEvidence: ['E2'],
				fiction: [],
				endingHook: '有人撕去一页。',
			},
		],
		humanReviewQuestions: ['E2 是否覆盖本章全部断言？'],
	}
	const saved = await call(outline, { expectedVersion: 0, plan: draft }, 200, 'PUT')
	assert.equal(saved.version, 1)
	const state = await call(story)
	assert.equal(state.planHash, saved.planHash)
	assert.equal(state.version, 1)
	assert.equal(state.plan.generationContext.evidence.length, 2)
	assert.equal(state.estimate.chapters.length, 2)
	assert.equal(state.approval, null)
	await call(story, { action: 'initialize' }, 409)
	// REQ-051：缺少预期版本的保存一律拒绝，不回退成按当前版本覆盖并静默撤销确认。
	assert.match((await call(outline, { plan: draft }, 400, 'PUT')).error, /预期版本号/)
	await call(outline, { expectedVersion: 99, plan: draft }, 409, 'PUT')

	const second = await call(outline, { expectedVersion: 1, plan: { ...draft, chapters: [...draft.chapters, { ...draft.chapters[0], id: 'chapter-03' }] } }, 200, 'PUT')
	assert.equal(second.version, 2)
	const unknown = await call(outline, { expectedVersion: 2, plan: { ...draft, historicalAnchors: [{ evidenceId: 'E9', fact: '不存在。' }] } }, 400, 'PUT')
	assert.match(unknown.error, /不存在的证据编号/)

	const current = await call(story)
	// REQ-035：确认方案不再填写整书预算，只核对证据与外发。
	const approved = await call(story, {
		action: 'approve',
		version: current.version,
		planHash: current.planHash,
		evidenceConfirmed: true,
		allowExternalTransfer: true,
	})
	assert.ok(approved.approved)
	const bumped = await call(outline, { expectedVersion: current.version, plan: draft }, 200, 'PUT')
	const afterOutline = await call(story)
	assert.equal(afterOutline.version, bumped.version)
	assert.equal(afterOutline.approval, null, 'a new outline version must revoke the previous approval')
	assert.equal(afterOutline.chapters.length, 0)

	// T052：本地骨架章纲零 Token、可幂等重跑，并且每一版都带着当时的提案绑定。
	const skeleton = await call(outline, { action: 'skeleton', plannedChapters: 2 })
	assert.equal(skeleton.committed, true)
	assert.equal(skeleton.origin, 'local')
	assert.equal(skeleton.chapters, 2)
	const bound = await call(story)
	assert.equal(bound.proposalIssue, null)
	assert.equal(bound.plan.proposal.slot, 2)
	// 前面的过期改写让选定项升到第 3 版：范围恢复后它重新成立，骨架章纲绑定的就是这一版。
	assert.equal(bound.plan.proposal.revision, 3)
	const reskeleton = await call(outline, { action: 'skeleton', plannedChapters: 2 })
	assert.equal(reskeleton.committed, false)
	assert.equal(reskeleton.version, skeleton.version, 'an identical skeleton must not create a new version')
	// 输入版本一变，章纲的确认与写入都要先回到提案步骤；旧提案本身也过期，只能重新生成。
	await call(scope, driftedScope, 200, 'PUT')
	const drifted = await call(story)
	assert.match(drifted.proposalIssue, /已变化/)
	const driftedPut = await call(outline, { expectedVersion: drifted.version, plan: draft }, 409, 'PUT')
	assert.match(driftedPut.error, /重新生成或重新选定/)
	const driftedApprove = await call(story, {
		action: 'approve',
		version: drifted.version,
		planHash: drifted.planHash,
		evidenceConfirmed: true,
		allowExternalTransfer: true,
	}, 409)
	assert.match(driftedApprove.error, /提案/)
	await call(scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')
	assert.equal((await call(story)).proposalIssue, null)

	const rewritten = await call(events, {
		action: 'add',
		title: '候选改写后采用',
		kind: 'historical',
		start: 904,
		end: 907,
		documentId,
		evidence: chronicled,
		confirmed: true,
		sourceKey: `activity:${li.id}`,
		participants: [li.id],
	})
	assert.equal(rewritten.events.length, 4)
	const rewrittenEvent = rewritten.events.find((item) => item.title === '候选改写后采用')
	assert.equal(rewrittenEvent.origin, 'derived')
	assert.ok(!rewritten.candidates.some((item) => item.sourceKey === `activity:${li.id}`), 'the rewritten candidate stops offering itself')
	await call(events, {
		action: 'add',
		title: '重复采用',
		kind: 'historical',
		start: 904,
		end: 907,
		documentId,
		evidence: chronicled,
		confirmed: true,
		sourceKey: `activity:${li.id}`,
	}, 400)

	const pending = await call(events, { action: 'add', title: '待改范围的事件', kind: 'fiction', start: 901, end: 901, status: 'candidate' })
	const pendingEvent = pending.events.find((item) => item.title === '待改范围的事件')
	assert.equal(pendingEvent.status, 'candidate')
	const relationKey = initial.candidates.find((item) => item.sourceKey.startsWith('relation:')).sourceKey
	await call(scope, { startYear: 1100, endYear: 1110, region: '汴州' }, 200, 'PUT')
	await call(events, { action: 'adopt', sourceKey: relationKey, confirmed: true }, 400)
	await call(events, { action: 'update', id: pendingEvent.id, status: 'adopt', confirmed: true }, 400)
	await call(scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')
	// 范围恢复后，未核对原文的采用仍要拒绝；核对后才落为已采用事件。
	await call(events, { action: 'adopt', sourceKey: relationKey, confirmed: false }, 400)
	await call(events, { action: 'update', id: pendingEvent.id, status: 'adopt' }, 400)
	await call(events, { action: 'adopt', sourceKey: relationKey, confirmed: true })

	// 需求 1：区域非必填，留空即不限区域，人物只凭时间证据匹配。
	await call(scope, { startYear: 900, endYear: 910, region: '' }, 200, 'PUT')
	const openRegion = await call(setup)
	assert.equal(openRegion.scope.region, '', '保存的范围要原样记住“不限区域”')
	assert.equal(openRegion.people.every((item) => item.match), true, '不限区域时活动年份落在区间内的人物都应匹配')
	await call(scope, { startYear: 900, endYear: 910, region: '汴州、洛阳' }, 200, 'PUT')

	// 需求 2（以事件为主）：第 03 步按时间阶段列出体现人物性格与风貌的记事，人名只标注、不作前提；证据必须回到原文。
	const corpusEvents = await call(`${events}/candidates?start=901&end=907`)
	assert.equal(corpusEvents.ready, true, '请先执行 npm run corpus:years')
	const knownNames = new Set((await call(setup)).people.map((item) => item.name))
	const entryProbe = database.prepare('SELECT COUNT(*) AS count FROM corpus_volume WHERE book_id = ? AND volume_name = ? AND instr(text, ?) > 0')
	for (const item of corpusEvents.candidates.slice(0, 10)) {
		assert.ok(item.year >= 901 && item.year <= 907, `记事年份 ${item.year} 不在查询区间内`)
		assert.ok(item.tier === 1 || item.tier === 2, `候选里混入了非品性记事：tier ${item.tier}`)
		assert.deepEqual(item.missingNames, item.names.filter((name) => !knownNames.has(name)), `未建档人名要标成待建：${item.names.join('、')}`)
		assert.equal(entryProbe.get(item.bookId, item.volume, item.text).count > 0, true, `${item.volume} 里找不到该记事原文`)
	}
	const sample = corpusEvents.candidates.find((item) => item.documentId && item.participantIds.length > 0)
	if (sample) {
		const added = await call(events, {
			action: 'add',
			title: '通鉴记事采用',
			kind: 'historical',
			start: sample.year,
			end: sample.year,
			documentId: sample.documentId,
			evidence: sample.text,
			confirmed: true,
			sourceKey: sample.key,
			participants: sample.participantIds,
		})
		assert.equal(added.events.some((item) => item.sourceKey === sample.key), true, '采用后的事件应带着记事来源标记')
		const reread = await call(`${events}/candidates?start=901&end=907`)
		const rereadItem = reread.candidates.find((item) => item.key === sample.key)
		assert.equal(rereadItem?.adopted, true, '已采用的记事要留在列表里并标「已采用」')
		const again = await call(events, { action: 'adoptMany', items: [{ key: sample.key, confirmed: true }] }, 400)
		assert.match(again.error, /该记事已采用过/, '同一记事不能被采用两次')
	} else {
		assert.equal(corpusEvents.candidates.length, 0, '有记事却没有可采用的出处或人物，说明候选拼装漏了字段')
	}

	for (const event of (await call(events)).events) await call(events, { action: 'remove', id: event.id })
	assert.equal((await call(outline)).evidence.length, 0)
	await call(outline, { plannedChapters: 4 }, 409)
	await call(outline, { expectedVersion: bumped.version, plan: draft }, 409, 'PUT')

	console.log('PASS: event derivation, adoption guards, evidence rules, dry-run outline preview, version chain revoking approval; no model requests.')
} finally {
	if (projectId) {
		cleanupStoryProject(database, projectId)
	}
	database.close()
}
