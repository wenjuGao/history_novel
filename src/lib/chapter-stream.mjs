export async function collectChapterStream(stream, { prefix = '', checkpoint, heartbeat, signal, now = Date.now }) {
	let content = prefix
	let requestId = null
	let usage = null
	let finishReason = null
	let savedLength = content.length
	let savedAt = now()
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted()
			heartbeat?.()
			requestId = chunk.id || requestId
			if (chunk.usage) usage = chunk.usage
			const choice = chunk.choices?.[0]
			content += choice?.delta?.content ?? ''
			if (content.length > 100_000) throw new Error('章节超过保存大小限制。')
			finishReason = choice?.finish_reason ?? finishReason
			if (content.length - savedLength >= 256 || now() - savedAt >= 500) {
				checkpoint({ content, requestId, usage, finishReason })
				savedLength = content.length
				savedAt = now()
			}
		}
		signal?.throwIfAborted()
		return { content, requestId, usage, finishReason, complete: finishReason === 'stop' && content.slice(prefix.length).trim().length > 0 }
	} finally {
		checkpoint({ content, requestId, usage, finishReason })
	}
}
