// 回归用的假模型拦截器：只替换本进程的 fetch，人物性格/风貌生成走它，绝不外呼真实端点。
import assert from 'node:assert/strict'

if (process.env.EVENT_FIRST_FIXTURE === '1') {
	const requestLog = process.env.EVENT_FIRST_REQUEST_LOG
	if (!requestLog) throw new Error('假模型子进程缺少 EVENT_FIRST_REQUEST_LOG')
	const { appendFileSync, writeFileSync } = await import('node:fs')
	writeFileSync(requestLog, '')
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
		if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, options)
		assert.ok(['dashscope.aliyuncs.com', 'token-plan.cn-beijing.maas.aliyuncs.com'].includes(url.hostname), `回归脚本不得访问编排之外的外网主机：${url.hostname}`)
		assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-only', '假模型流不接受真实凭证')
		const body = JSON.parse(options.body)
		assert.equal(body.response_format?.type, 'json_object', '人物设定请求应是结构化输出')
		assert.equal(body.enable_thinking, false, '人物设定请求应关闭思考模式')
		const payload = JSON.parse(body.messages.find((item) => item.role === 'user').content)
		appendFileSync(requestLog, `${JSON.stringify({ names: (payload.persons ?? []).map((person) => person.name), events: (payload.persons ?? []).map((person) => person.events.length) })}\n`)
		const persons = (payload.persons ?? []).map((person) => ({
			name: person.name,
			personality: `假稿：由 ${person.events.length} 条记事归纳。`,
			temperament: '假稿：气度与节操。',
		}))
		// 混入一个模型编造的姓名：服务端必须丢掉它，不能写进对不上号的档案。
		persons.push({ name: '假稿不存在的人', personality: '不该写入。', temperament: '' })
		const completion = {
			id: 'event-first-fixture-1',
			object: 'chat.completion',
			choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ persons }) }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
		}
		return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } })
	}
}
