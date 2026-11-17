import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { collectChapterStream } from '../src/lib/chapter-stream.mjs'
import { seedStoryPlan } from './lib/story-chain.mjs'

const partial = '流式断线测试正文。'.repeat(40)
const suffix = '这是继续生成的新内容。'
// 自动续写脚本段：每段内容互不相同，用于区分「有进展的截断」与「原地重复」。
const autoSegments = ['自动续写第一段。'.repeat(12), '自动续写第二段。'.repeat(12), '自动续写第三段。'.repeat(12), '自动续写第四段。'.repeat(12)]
const repeated = '反复输出同一段落的续写内容。'.repeat(6)
// 章三在人工续写后收尾的固定文本。
const manualFinish = '人工确认后补完的收尾段落。'.repeat(8)

if (process.env.STORY_STREAM_FIXTURE === '1') {
	const seen = new Map()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
		if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, options)
		assert.equal(url.hostname, 'token-plan.cn-beijing.maas.aliyuncs.com', 'Fixture refuses external network')
		assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-only')
		const body = JSON.parse(options.body)
		assert.equal(body.stream, true)
		assert.equal(body.enable_thinking, false)
		const payload = JSON.parse(body.messages[1].content)
		// 记录送出的请求体，便于回归核对正文请求确实带上了已确认的写作规格与既定故事状态。
		if (process.env.STORY_FIXTURE_LOG) appendFileSync(process.env.STORY_FIXTURE_LOG, `${JSON.stringify(payload)}\n`)
		const chapterId = payload.chapter?.id ?? 'unknown'
		const round = (seen.get(chapterId) ?? 0) + 1
		seen.set(chapterId, round)
		const continuation = payload.continuation?.savedText
		// 只有章一的人工续写带固定检查点文本；自动续写的 savedText 就是上一段累计正文。
		if (continuation && chapterId === 'chapter-01') assert.equal(continuation, partial)
		// 章二：截断两次后正常收尾；章三：重复输出（测回滚）后人工续写收尾；章四：一直截断（测自动续写上限）。
		const scripted = { 'chapter-02': 'auto', 'chapter-03': 'repeat', 'chapter-04': 'cap' }[chapterId]
		if (scripted) {
			const added =
				scripted === 'auto'
					? // 首轮在长度上限处把元信息标记也截断了：续写只能接在正文之后，残段不得混入前缀。
						autoSegments[Math.min(round - 1, 2)] + (round === 1 ? '[[META]] {"标题"' : '')
					: scripted === 'cap'
						? autoSegments[(round - 1) % autoSegments.length]
						: round <= 2
							? repeated
							: manualFinish
			const last = scripted === 'repeat' ? round >= 3 : scripted === 'auto' ? round >= 3 : false
			const frames = [
				{ id: `fixture-${chapterId}-${round}`, choices: [{ index: 0, delta: { content: added }, finish_reason: null }] },
				{ id: `fixture-${chapterId}-${round}`, choices: [{ index: 0, delta: {}, finish_reason: last ? 'stop' : 'length' }] },
				{ id: `fixture-${chapterId}-${round}`, choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } },
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
					}
				}),
				{ headers: { 'content-type': 'text/event-stream' } }
			)
		}
		const frames = [
			{
				id: continuation ? 'fixture-resume' : 'fixture-first',
				choices: [{ index: 0, delta: { content: continuation ? suffix : partial }, finish_reason: null }]
			},
			{ id: 'fixture-resume', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
			{ id: 'fixture-resume', choices: [], usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 } }
		]
		let index = 0
		const encoder = new TextEncoder()
		return new Response(
			new ReadableStream({
				pull(controller) {
					if (!continuation && index === 1) {
						controller.error(new Error('fixture disconnected'))
						return
					}
					if (index < frames.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[index++])}\n\n`))
					else {
						controller.enqueue(encoder.encode('data: [DONE]\n\n'))
						controller.close()
					}
				}
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	}
} else {
	const saved = []
	async function* interrupted() {
		yield { id: 'offline', choices: [{ delta: { content: partial } }] }
		assert(saved.length > 0, 'Must checkpoint before stream completes')
		throw new Error('offline disconnect')
	}
	await assert.rejects(collectChapterStream(interrupted(), { checkpoint: (item) => saved.push(item) }), /offline disconnect/)
	assert.equal(saved.at(-1).content, partial)
	async function* truncated() {
		yield { choices: [{ delta: { content: '未完' }, finish_reason: 'length' }] }
	}
	assert.equal((await collectChapterStream(truncated(), { checkpoint: () => {} })).complete, false)

	// 默认建一个空目录自检；传入 HISTORY_DATA_DIR（例如从真实库做的在线备份）时复用它，
	// 这样本机已登记的古籍与参考小说会参与项目自动固定，规格门禁与请求规格断言走真实分支。
	const seeded = process.env.HISTORY_DATA_DIR
	const directory = seeded ?? mkdtempSync(path.join(os.tmpdir(), 'story-stream-'))
	const socket = createServer()
	socket.listen(0, '127.0.0.1')
	await once(socket, 'listening')
	const port = socket.address().port
	await new Promise((resolve) => socket.close(resolve))
	const base = `http://127.0.0.1:${port}`
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
					STORY_STREAM_FIXTURE: '1',
					STORY_FIXTURE_LOG: path.join(directory, 'requests.jsonl'),
					DASHSCOPE_API_KEY: 'fixture-only',
					BAILIAN_BASE_URL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
					BAILIAN_MODEL_WRITING: 'qwen3.8-max',
					NEXT_TELEMETRY_DISABLED: '1'
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		)
		await new Promise((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error('Fixture server startup timed out')), 45000)
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

	async function call(route, body, expected = 200) {
		const response = await fetch(base + route, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { origin: base, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
		const data = await response.json()
		assert.equal(response.status, expected, JSON.stringify(data))
		return data
	}

	async function waitForChapter(route, chapterId, expected) {
		const deadline = Date.now() + 20000
		while (Date.now() < deadline) {
			const state = await call(route)
			const chapter = state.chapters.find((item) => item.chapterId === chapterId)
			if (chapter?.status === expected) return state
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error(`Chapter ${chapterId} did not reach ${expected}`)
	}

	// 请求记录按章节 id 归档，便于核对「每章送出了几次模型请求」。
	function sentByChapter() {
		const lines = readFileSync(path.join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
		const grouped = new Map()
		for (const line of lines) {
			const payload = JSON.parse(line)
			const chapterId = payload.chapter?.id ?? 'unknown'
			grouped.set(chapterId, [...(grouped.get(chapterId) ?? []), payload])
		}
		return grouped
	}

	try {
		// 复用真实库备份时，请求记录会跨次累积；每次运行只核对本次的首次与续写两笔。
		rmSync(path.join(directory, 'requests.jsonl'), { force: true })
		await start()
		// T052：章纲走完整本地链路（采用证据→选定提案→本地骨架章纲），不再由静态试跑资料初始化。
		const chain = await seedStoryPlan(base, { name: '流式恢复隔离测试', plannedChapters: 4, extraEvents: 2 })
		const testProjectId = chain.projectId
		const route = chain.routes.story
		let state = chain.state
		const [one, two, three, four] = state.plan.chapters.map((item) => item.id)
		const request = { version: state.version, planHash: state.planHash }
		const chapter = (id, list = state) => list.chapters.find((item) => item.chapterId === id)
		const reference = (await call(chain.routes.references)).pinned
		// REQ-035：确认只固定方案哈希、证据核对与资料外发；整书预算不是必填项。
		await call(route, { ...request, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })
		const first = await call(route, { ...request, chapterId: one, action: 'generate' }, 202)
		assert.equal(first.status, 'generating')
		assert.equal(first.autoContinuationLimit, 2, '自动续写上限需回显给前端')
		state = await waitForChapter(route, one, 'failed-or-unknown')
		assert.equal(chapter(one).content, partial)

		const interruptedDatabase = new Database(path.join(directory, 'workspace.sqlite'))
		// 只改写本测试作品的草稿与尝试记录：复用真实库备份时，全表更新会把其他作品的生成状态一起搅乱。
		const scopeToProject = (sql) => interruptedDatabase.prepare(`${sql} WHERE project_id=?`)
		scopeToProject("UPDATE chapter_drafts SET status='generating'").run(testProjectId)
		await call(route, { ...request, chapterId: one, action: 'resume', retryConfirmed: true }, 409)
		scopeToProject('UPDATE chapter_drafts SET updated_at=?').run(new Date(Date.now() - 180000).toISOString(), testProjectId)
		scopeToProject("UPDATE chapter_generation_attempts SET status='started', finished_at=NULL").run(testProjectId)
		interruptedDatabase.close()

		await stop()
		await start()
		state = await call(route)
		assert.equal(chapter(one).status, 'failed-or-unknown', 'Dead process must not retain generation lock')
		assert.equal(chapter(one).content, partial, 'Restart must preserve partial text')
		await call(route, { ...request, chapterId: one, action: 'resume', retryConfirmed: false }, 400)
		await call(route, { ...request, chapterId: one, action: 'resume', retryConfirmed: true }, 202)
		state = await waitForChapter(route, one, 'draft')
		assert.equal(chapter(one).content, partial + suffix)
		assert.equal(chapter(one).attemptCount, 2)
		assert.equal(chapter(one).actualCostCny, null)
		assert.equal(chapter(one).completionTokens, 100)
		// REQ-027：只有人工接受后的章节才成为下一章的既定事实。
		await call(route, { ...request, chapterId: one, action: 'edit', content: partial + suffix })
		await call(route, { ...request, chapterId: one, action: 'accept' })
		state = await call(route)
		assert.equal(chapter(one).status, 'accepted')
		assert.equal(state.storyStates.length, 1, '接受后固化一条故事状态')
		assert.equal(state.storyStates[0].chapterId, one)
		assert.equal(state.storyStates[0].status, 'confirmed')
		assert.ok(state.storyStates[0].draftInputHash, '状态记录绑定接受时的输入版本')

		// REQ-026/032：章二消费已确认的前章状态；两次明确长度截断后自动续写并收尾。
		await call(route, { ...request, chapterId: two, action: 'generate' }, 202)
		state = await waitForChapter(route, two, 'draft')
		assert.equal(chapter(two).content, autoSegments.slice(0, 3).join(''), '自动续写按段并入检查点正文')
		assert.ok(!chapter(two).content.includes('[[META]]'), '截断的元信息残段不得留在正文里')
		assert.equal(chapter(two).attemptCount, 3, '首次加两次自动续写各留一条记录')
		assert.equal(chapter(two).autoContinuations, 2)
		const second = sentByChapter().get(two) ?? []
		assert.equal(second.length, 3, '章二送出三次请求')
		for (const payload of second) {
			assert.equal(payload.confirmedStoryState.usedInputs.length, 1, '章二只带入已确认的前章状态')
			assert.equal(payload.confirmedStoryState.usedInputs[0].chapter, `第 1 章《${state.plan.chapters[0].title}》`)
			assert.ok(payload.confirmedStoryState.usedInputs[0].stateInputHash, '带入的前章状态记录输入版本')
		}
		assert.ok(second[1].continuation.savedText, '自动续写请求带上新增前的检查点正文')
		await call(route, { ...request, chapterId: two, action: 'accept' })

		// REQ-032：续写内容与已有正文重复时回滚本段新增，交回人工，不并入正文。
		await call(route, { ...request, chapterId: three, action: 'generate' }, 202)
		state = await waitForChapter(route, three, 'failed-or-unknown')
		assert.equal(chapter(three).content, repeated, '重复段已回滚')
		assert.equal(chapter(three).attemptCount, 2)
		assert.equal(chapter(three).autoContinuations, 1)
		assert.match(chapter(three).errorMessage, /重复/)
		await call(route, { ...request, chapterId: three, action: 'resume', retryConfirmed: true }, 202)
		state = await waitForChapter(route, three, 'draft')
		assert.equal(chapter(three).content, repeated + manualFinish, '人工续写从检查点接着写')
		assert.equal(chapter(three).attemptCount, 3)
		assert.equal(chapter(three).autoContinuations, 0, '人工续写重置自动续写次数')
		await call(route, { ...request, chapterId: three, action: 'accept' })

		// REQ-032：持续截断到达上限后停在检查点，不无限续写，也不自动接受。
		await call(route, { ...request, chapterId: four, action: 'generate' }, 202)
		state = await waitForChapter(route, four, 'failed-or-unknown')
		assert.equal(chapter(four).content, autoSegments.slice(0, 3).join(''), '保留各段检查点正文')
		assert.equal(chapter(four).attemptCount, 3)
		assert.equal(chapter(four).autoContinuations, 2)
		assert.match(chapter(four).errorMessage, /输出未完成/, '上限处停在未完成状态')
		await call(route, { ...request, chapterId: four, action: 'accept' }, 409)

		// REQ-025/029：改写已接受的前章后，本章状态失效、依赖它的后续章节全部待复核。
		await call(route, { ...request, chapterId: one, action: 'edit', content: `${partial + suffix}前章改写后的新结尾。` })
		state = await call(route)
		assert.equal(chapter(one).stateStatus, 'stale', '本章状态在改写后失效')
		for (const id of [two, three, four]) {
			assert.equal(chapter(id).needsReview, 1, `章节 ${id} 应因前文变更待复核`)
			assert.match(chapter(id).reviewReason, /改写/)
		}
		assert.equal(state.storyStates.filter((item) => item.status === 'confirmed').length, 0, '前文改写后没有状态可再进入新请求')
		assert.equal(state.storyStates.filter((item) => item.status === 'stale').length, 3, '被改写章与其后已固化状态全部转为已失效')
		assert.match(state.storyStates.find((item) => item.chapterId === one).staleReason, /改写/)

		// 待复核的已接受章节不必重写正文即可复核并重新接受（REQ-029）；重接受后其后章节仍需逐章复核。
		await call(route, { ...request, chapterId: two, action: 'accept' })
		state = await call(route)
		assert.equal(chapter(two).status, 'accepted')
		assert.equal(chapter(two).needsReview, 0, '重新接受即完成本章复核')
		assert.equal(chapter(three).needsReview, 1, '其后章节仍需复核')
		assert.equal(state.storyStates.find((item) => item.chapterId === two).status, 'confirmed')

		// 改写过的章一重新接受后，固化的输入版本必须指向改写后的正文，而不是当初的模型请求。
		await call(route, { ...request, chapterId: one, action: 'accept' })
		state = await call(route)
		assert.equal(state.storyStates.find((item) => item.chapterId === one).status, 'confirmed', '改写后重新接受即恢复为既定事实')

		// 前文重新接受后其后章节再次待复核；复核完成前不得在其上继续生成（REQ-026/029）。
		const blocked = await call(route, { ...request, chapterId: four, action: 'generate' }, 409)
		assert.match(blocked.error, /待复核/)
		// 每次请求都必须带上同一份已确认写作规格。
		const byChapter = sentByChapter()
		assert.deepEqual(
			Object.fromEntries([...byChapter].map(([id, items]) => [id, items.length])),
			{ [one]: 2, [two]: 3, [three]: 3, [four]: 3 },
			'章一首次加人工续写，章二至章四各含自动续写段'
		)
		const sent = [...byChapter.values()].flat()
		for (const payload of sent) {
			if (reference) {
				assert.equal(payload.referenceSpecification, reference.specText, '正文请求的规格全文应与确认版本一致')
				assert.deepEqual(payload.referenceMethods, reference.methods, '正文请求的抽象方法应来自同一确认版本')
				assert.equal(payload.referenceSpecVersion, reference.version, '正文请求应记录规格版本')
			} else {
				// 本机未登记参考小说时没有可确认的规格版本，请求不得伪称某个版本生效。
				assert.equal(payload.referenceSpecVersion, null, '未登记参考小说不得伪造规格版本')
			}
		}
		const database = new Database(path.join(directory, 'workspace.sqlite'), { readonly: true })
		const attempts = database
			.prepare('SELECT status,content FROM chapter_generation_attempts WHERE project_id=? AND chapter_id=? ORDER BY attempt_number')
			.all(testProjectId, one)
		assert.equal(attempts[0].content, partial)
		assert.equal(attempts[1].content, partial + suffix)
		const trace = database
			.prepare(
				"SELECT d.input_hash AS draftHash, s.draft_input_hash AS stateHash FROM chapter_drafts d JOIN chapter_states s ON s.project_id=d.project_id AND s.plan_version=d.plan_version AND s.chapter_id=d.chapter_id WHERE d.project_id=? AND d.chapter_id=? AND s.status='confirmed'"
			)
			.get(testProjectId, one)
		assert.equal(trace.stateHash, trace.draftHash, '已确认状态记录的输入版本就是本章当前正文的版本')
		database.close()
		console.log(
			'PASS: HTTP 202 background stream, disconnect checkpoint, server restart, explicit continuation, accepted story state fed to the next chapter, bounded auto-continuation with duplicate rollback and cap, downstream review marking; provider network replaced by fixture.'
		)
	} catch (error) {
		console.error(logs)
		throw error
	} finally {
		await stop()
		if (!seeded) rmSync(directory, { recursive: true, force: true })
	}
}
