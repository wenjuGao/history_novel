import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { seedStoryPlan } from './lib/story-chain.mjs'

// 正文首次生成与重新生成的两段可区分文本；章纲重写由 fixture 依据请求里的章节编号编排。
const originalBody = '首次生成的章节正文。'.repeat(20)
const regeneratedBody = '重新生成后的章节正文。'.repeat(20)

if (process.env.REGENERATE_FIXTURE === '1') {
	const seen = new Map()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
		if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, options)
		assert.equal(url.hostname, 'token-plan.cn-beijing.maas.aliyuncs.com', 'Fixture refuses external network')
		assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-only')
		const body = JSON.parse(options.body)
		assert.equal(body.enable_thinking, false)
		const payload = JSON.parse(body.messages[1].content)
		if (process.env.REGENERATE_FIXTURE_LOG) appendFileSync(process.env.REGENERATE_FIXTURE_LOG, `${JSON.stringify({ stream: body.stream ?? false, payload })}\n`)

		// 章纲重生成走非流式 JSON：一次调用只交出所重写那一章的设定，证据编号只取请求里给到的编号。
		if (body.stream !== true) {
			assert.ok(payload.chapterNumber || payload.previousChapterNumber, '章纲请求必须标明本次处理的是哪一章')
			const evidenceId = payload.evidence?.[0]?.id ?? 'unknown'
			const number = payload.chapterNumber ?? 0
			return Response.json({
				id: `fixture-plan-${number}`,
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant',
							content: JSON.stringify({
								title: `重写后的第 ${number} 章`,
								pov: '朱全忠',
								time: '905 年春，汴州',
								synopsis: `按当前提案重写的第 ${number} 章梗概。`,
								plot: [`情节一：第 ${number} 章承接前章钩子。`, '情节二：本章留下新的悬念。'],
								historyEvidence: [evidenceId],
								fiction: ['本章对白与场景细节为虚构。'],
								endingHook: `第 ${number} 章末重写后的新钩子。`,
							}),
						},
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
			})
		}

		const chapterId = payload.chapter?.id ?? 'unknown'
		const round = (seen.get(chapterId) ?? 0) + 1
		seen.set(chapterId, round)
		const content = round === 1 ? originalBody : `${regeneratedBody}（第 ${round} 次重写）`
		const frames = [
			{ id: `fixture-${chapterId}-${round}`, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
			{ id: `fixture-${chapterId}-${round}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
			{ id: `fixture-${chapterId}-${round}`, choices: [], usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 } },
		]
		let index = 0
		const encoder = new TextEncoder()
		return new Response(
			new ReadableStream({
				pull(controller) {
					if (index < frames.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[index++])}\n\n`))
					else {
						controller.enqueue(encoder.encode('data: [DONE]\n\n'))
						controller.close()
					}
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' } },
		)
	}
} else {
	// 空串按未设置处理：服务端用 `||` 判空，`HISTORY_DATA_DIR=` 会把测试作品写进真实 data/local。
	const seeded = process.env.HISTORY_DATA_DIR?.trim()
	const directory = seeded ? path.resolve(seeded) : mkdtempSync(path.join(os.tmpdir(), 'story-regenerate-'))
	assert.notEqual(directory, path.resolve(process.cwd()), 'HISTORY_DATA_DIR 不能是仓库目录，请指向隔离副本或留空自建临时目录。')
	assert.notEqual(directory, path.resolve(process.cwd(), 'data', 'local'), 'HISTORY_DATA_DIR 不能指向真实工作区 data/local。')
	const socket = createServer()
	socket.listen(0, '127.0.0.1')
	await once(socket, 'listening')
	const port = socket.address().port
	await new Promise((resolve) => socket.close(resolve))
	const base = `http://127.0.0.1:${port}`
	const logFile = path.join(directory, 'requests.jsonl')
	let server
	let logs = ''

	async function start() {
		server = spawn(
			process.execPath,
			['--import', fileURLToPath(import.meta.url), 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
			{
				cwd: process.cwd(),
				detached: true,
				env: {
					...process.env,
					HISTORY_TEST_BUILD: '1',
					HISTORY_DATA_DIR: directory,
					REGENERATE_FIXTURE: '1',
					REGENERATE_FIXTURE_LOG: logFile,
					DASHSCOPE_API_KEY: 'fixture-only',
					BAILIAN_BASE_URL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
					BAILIAN_MODEL_WRITING: 'qwen3.8-max',
					NEXT_TELEMETRY_DISABLED: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		await new Promise((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error('Fixture server startup timed out')), 60000)
			const capture = (chunk) => {
				const text = chunk.toString()
				logs = (logs + text).slice(-6000)
				if (text.includes('Ready in')) {
					clearTimeout(deadline)
					resolve()
				}
			}
			server.stdout.on('data', capture)
			server.stderr.on('data', capture)
			server.once('exit', (code) => {
				clearTimeout(deadline)
				reject(new Error(`Fixture server exited: ${code}`))
			})
		})
	}

	async function stop() {
		if (!server || server.exitCode !== null) return
		const exited = once(server, 'exit')
		process.kill(-server.pid, 'SIGTERM')
		await exited
	}

	async function call(route, body, expected = 200, method) {
		const response = await fetch(base + route, {
			method: method ?? (body === undefined ? 'GET' : 'POST'),
			headers: { origin: base, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const data = await response.json()
		assert.equal(response.status, expected, JSON.stringify(data))
		return data
	}

	async function waitForChapter(storyRoute, chapterId, expected) {
		const deadline = Date.now() + 25000
		while (Date.now() < deadline) {
			const state = await call(storyRoute)
			const item = state.chapters.find((entry) => entry.chapterId === chapterId)
			if (item?.status === expected) return state
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error(`Chapter ${chapterId} did not reach ${expected}`)
	}

	// 请求记录分「正文（流式）」与「章纲（非流式）」两堆，便于核对一次调用只处理一章。
	function sentRequests() {
		const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
		return {
			story: lines.filter((line) => line.stream === true).map((line) => line.payload),
			plans: lines.filter((line) => line.stream !== true).map((line) => line.payload),
		}
	}

	try {
		rmSync(logFile, { force: true })
		await start()
		const chain = await seedStoryPlan(base, { name: '重新生成隔离测试', plannedChapters: 3, extraEvents: 1 })
		const projectId = chain.projectId
		const routes = chain.routes
		const chapterPlanRoute = `/api/projects/${projectId}/chapter-plan`
		let state = chain.state
		const [one, two, three] = state.plan.chapters.map((item) => item.id)
		let request = { version: state.version, planHash: state.planHash }
		const chapter = (id, list = state) => list.chapters.find((item) => item.chapterId === id)

		await call(routes.story, { ...request, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })
		for (const id of [one, two, three]) {
			await call(routes.story, { ...request, chapterId: id, action: 'generate' }, 202)
			await waitForChapter(routes.story, id, 'draft')
			await call(routes.story, { ...request, chapterId: id, action: 'accept' })
		}
		state = await call(routes.story)
		assert.equal(chapter(three).content, originalBody, '三章正文逐章生成并各自接受')
		assert.equal(sentRequests().story.length, 3, '三次正文请求，一次一章')

		// REQ-060：覆盖本章已保存正文前必须明确确认；未确认时零请求、零改动。
		const unconfirmed = await call(routes.story, { ...request, chapterId: two, action: 'regenerate' }, 400)
		assert.match(unconfirmed.error, /覆盖/)
		assert.equal(sentRequests().story.length, 3, '未确认的重新生成不发送任何请求')
		// 已有草稿的普通生成仍被拒绝：重新生成是显式动作，不能靠重试绕过归档。
		const duplicated = await call(routes.story, { ...request, chapterId: two, action: 'generate' }, 409)
		assert.match(duplicated.error, /已有生成记录/)

		await call(routes.story, { ...request, chapterId: two, action: 'regenerate', regenerateConfirmed: true }, 202)
		state = await waitForChapter(routes.story, two, 'draft')
		assert.ok(chapter(two).content.startsWith(regeneratedBody), '本章正文被新正文整体覆盖')
		assert.ok(!chapter(two).content.includes(originalBody), '覆盖不是接在旧文末尾续写')
		assert.equal(chapter(two).status, 'draft', '重生成结果默认不自动接受')
		assert.equal(chapter(two).needsReview, 0, '本章等待人工接受，不是待复核')
		assert.equal(chapter(three).needsReview, 1, '其后章节因前文重写转待复核')
		assert.equal(state.storyStates.find((item) => item.chapterId === two).status, 'stale', '旧的故事状态随覆盖失效')
		// REQ-027：重生成请求仍只带本章一章的设定。
		const lastStory = sentRequests().story.at(-1)
		assert.equal(lastStory.chapter.id, two, '正文请求只携带被重生成的那一章')

		// 旧正文进备份表并可读回（GET ?backup=<chapterId>）。
		const backupView = await call(`${routes.story}?backup=${two}`)
		assert.equal(backupView.backup.content, originalBody, '归档里能取回被覆盖的旧正文')
		assert.match(backupView.backup.reason, /覆盖|重新生成/)
		state = await call(routes.story)
		assert.equal(chapter(two).backupCount, 1)
		assert.equal(chapter(two).backupChars, originalBody.length)

		// 恢复上一版：当前正文先归档，再写回旧文，任何一次点击都不丢字。
		await call(routes.story, { ...request, chapterId: two, action: 'restore' })
		state = await call(routes.story)
		assert.equal(chapter(two).content, originalBody, '恢复后正文回到旧版')
		assert.equal(chapter(two).backupCount, 2, '恢复前把重生成版本也归档了')
		assert.equal(chapter(two).status, 'draft', '恢复后需重新接受本章')
		const secondBackup = await call(`${routes.story}?backup=${two}`)
		assert.ok(secondBackup.backup.content.startsWith(regeneratedBody), '最近一次归档是重生成版本')
		assert.equal(state.storyStates.find((item) => item.chapterId === two).status, 'stale')

		// 生成中的章节不能被再次覆盖：fixture 落定太快，因此把草稿显式置回 generating 再请求。
		await call(routes.story, { ...request, chapterId: two, action: 'regenerate', regenerateConfirmed: true }, 202)
		state = await waitForChapter(routes.story, two, 'draft')
		assert.match(chapter(two).content, /第 3 次重写/, '第二次覆盖同样整体重写，不接在旧文之后')
		const drafts = new Database(path.join(directory, 'workspace.sqlite'))
		const lockDraft = (status) => {
			drafts.prepare('UPDATE chapter_drafts SET status=? WHERE project_id=? AND chapter_id=?').run(status, projectId, two)
		}
		lockDraft('generating')
		const busy = await call(routes.story, { ...request, chapterId: two, action: 'regenerate', regenerateConfirmed: true }, 409)
		assert.match(busy.error, /正在生成/)
		lockDraft('draft')
		drafts.close()
		await call(routes.story, { ...request, chapterId: two, action: 'accept' })
		await call(routes.story, { ...request, chapterId: three, action: 'accept' })
		const missing = await call(routes.story, { ...request, chapterId: 'chapter-404', action: 'regenerate', regenerateConfirmed: true }, 404)
		assert.match(missing.error, /章节不存在/)

		// 章纲按章重生成：一次调用只重写所选那一章的设定。
		const planState = await call(chapterPlanRoute)
		assert.equal(planState.blocked, null, '提案绑定有效时章纲重生成入口可用')
		const rewritten = await call(chapterPlanRoute, { action: 'regenerate', chapterId: two, allowExternalTransfer: true })
		assert.equal(rewritten.chapterId, two, '响应标明重写的是哪一章')
		assert.equal(rewritten.accepted, true, JSON.stringify(rewritten.issues))
		assert.match(rewritten.chapter.title, /重写后的第 2 章/)
		assert.equal(sentRequests().plans.length, 1, '一次调用只请求一章章纲')
		const planPayload = sentRequests().plans[0]
		assert.equal(planPayload.chapterNumber, 2, '请求标明重生成的是目录第 2 章')
		assert.equal(planPayload.currentChapter.title, state.plan.chapters[1].title, '请求带上本章原设定供对照')
		assert.equal(planPayload.previousChapter.title, state.plan.chapters[0].title, '请求带上前一章用于承接钩子')
		assert.equal(planPayload.nextChapter.title, state.plan.chapters[2].title, '请求带上后一章用于衔接')

		const badId = await call(chapterPlanRoute, { action: 'regenerate', chapterId: 'chapter-nope', allowExternalTransfer: true }, 409)
		assert.match(badId.error, /不在当前/)
		const noTransfer = await call(chapterPlanRoute, { action: 'regenerate', chapterId: two }, 400)
		assert.match(noTransfer.error, /外发/)

		// 章纲重生成结果保存为新版本：已接受正文按章节继承，被改写的本章与其后章节转待复核。
		state = await call(routes.story)
		request = { version: state.version, planHash: state.planHash }
		const revised = structuredClone(state.plan)
		revised.chapters[1] = { ...revised.chapters[1], ...rewritten.chapter, id: two }
		const saved = await call(routes.story, { plan: revised, expectedVersion: state.version }, 200, 'PUT')
		assert.equal(saved.version, state.version + 1, '保存章纲产生新版本')
		assert.deepEqual(
			{ carried: saved.carried, preserved: saved.preserved, needsReview: saved.needsReview },
			{ carried: 3, preserved: 1, needsReview: 2 },
			'三章正文继承，章纲未改的前章保留确认，改写章纲的本章与依赖它的后章转待复核',
		)
		state = await call(routes.story)
		request = { version: state.version, planHash: state.planHash }
		assert.equal(state.approval, null, '新版仍撤销方案级确认')
		assert.equal(chapter(one).status, 'accepted', '未受影响的前章保持已接受')
		assert.equal(chapter(one).needsReview, 0)
		assert.equal(chapter(two).needsReview, 1, '章纲被改写的本章转待复核')
		assert.match(chapter(two).reviewReason, /章纲/)
		assert.equal(chapter(three).content, originalBody, '后章正文原样带入新版本')
		await call(routes.story, { ...request, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })

		// 剧情提案调整后（新增已采用史实让提案输入哈希变化），两类重新生成都必须先回到提案步骤。
		const people = (await call(routes.setup)).people
		await call(routes.events, {
			action: 'add',
			title: '汴州再议',
			kind: 'historical',
			start: 908,
			end: 908,
			documentId: chain.documentId,
			evidence: chain.chronicled,
			confirmed: true,
			participants: [people[0].id],
		})
		const outlineState = await call(routes.outline)
		assert.equal(outlineState.proposalBlocked, true, '提案类拦截要可区分，界面据此保留重新生成入口')
		assert.ok(outlineState.proposalIssue, '已保存章纲的过期原因随 GET 回显')
		const stalePlan = await call(chapterPlanRoute, { action: 'regenerate', chapterId: two, allowExternalTransfer: true }, 409)
		assert.match(stalePlan.error, /提案/)
		const staleBody = await call(routes.story, { ...request, chapterId: one, action: 'regenerate', regenerateConfirmed: true }, 409)
		assert.match(staleBody.error, /提案/)

		const archived = new Database(path.join(directory, 'workspace.sqlite'), { readonly: true })
		const backupRows = archived
			.prepare('SELECT chapter_id AS chapterId, content FROM chapter_draft_backups WHERE project_id=? ORDER BY archived_at')
			.all(projectId)
		assert.equal(backupRows.length, 3, '两次覆盖加一次恢复各留一条归档')
		assert.deepEqual([...new Set(backupRows.map((row) => row.chapterId))], [two], '归档只落在被重写的那一章')
		assert.equal(backupRows.filter((row) => !row.content).length, 0, '空正文不写归档行')
		archived.close()

		console.log(
			'PASS: chapter plan and chapter body regeneration entries, overwrite confirmation, archive-before-overwrite with restore, downstream review marking, one chapter per request, proposal-boundary gating and plan revision carrying drafts forward; provider network replaced by fixture.',
		)
	} catch (error) {
		console.error(logs)
		throw error
	} finally {
		await stop()
		if (!seeded) rmSync(directory, { recursive: true, force: true })
	}
}
