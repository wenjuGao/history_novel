import 'server-only'

import OpenAI from 'openai'
import { BAILIAN_MODELS, getBailianConfiguration, type BailianModelId } from '@/lib/bailian'
import { billingMode } from '@/lib/bailian-endpoint.mjs'
import { db } from '@/lib/db'
import { astronomicalToHistorical } from '@/lib/history-time'
import { eventBroughtPersons, type EventPerson } from '@/lib/event-persons'

// 人物性格与精神风貌的批量生成：输入只有已采用事件的证据原文与品性线索，模型只负责把这些线索组织成连贯描述。
// 外发是显式动作（与剧情提案、章纲同一口径：请求内确认，或项目已长期同意）；未命中的姓名一律丢弃，写库标 profile_source='model' 等待作者核对。

export const profileModelId = 'qwen3.8-flash' as BailianModelId
export const profileBatchSize = 20
export const profileMaxOutputTokens = 4000

export class ProfileError extends Error {
	readonly status: number
	constructor(message: string, status = 502) {
		super(message)
		this.status = status
	}
}

export type ProfileEstimate = {
	billingMode: string
	modelId: string
	inputTokenAllowance: number
	maxOutputTokens: number
	tokenAllowance: number
	ceilingCny: number | null
}

export type ProfileSubject = {
	name: string
	/** 带出该人物的已采用事件（标题＋证据原文＋品性线索），最多 8 条。 */
	events: Array<{ title: string; year: number; evidence: string; cues: string[]; reveal: string }>
}

function yearLabel(year: number | null) {
	if (year === null) return ''
	const historical = astronomicalToHistorical(year)
	return historical < 0 ? `公元前${-historical}年` : `公元${historical}年`
}

/** 只送本机已核对过的内容：人名、事件标题、纪年、证据原文与品性线索，不带作品名之外的其它资料。 */
export function profileSubjects(persons: EventPerson[], names?: string[]): ProfileSubject[] {
	const wanted = names?.length ? new Set(names) : null
	return persons
		.filter((person) => person.selected === 1 && (!wanted || wanted.has(person.name)))
		.map((person) => ({
			name: person.name,
			events: person.events.slice(0, 8).map((event) => ({
				title: event.title.slice(0, 120),
				year: astronomicalToHistorical(event.start),
				evidence: event.evidence.slice(0, 900),
				cues: event.cues.map((cue) => `${cue.kind}「${cue.word}」`).slice(0, 8),
				reveal: event.reveal.slice(0, 600),
			})),
		}))
		.filter((subject) => subject.events.length)
}

export const profileSystemPrompt = `你是历史题材长篇小说的人物设定助手。用户给出若干人物，每人附带若干条本机史料记事（已核对的原文与品性线索）。
只为这些人物归纳「性格」与「精神风貌」两项描述，作为作者的待核初稿。
要求：
1. 全部依据所给记事，不得引入记事之外的史实，不得虚构生平；证据不足时写「史料未足」并说明缺什么。
2. 性格写稳定的行事倾向；精神风貌写气度、节操与时代气质，两者不重复。
3. 每位人物各 60 至 160 字，陈述句，不用条目符号，不写成评语堆砌。
4. 严格只输出 JSON：{"persons":[{"name":"…","personality":"…","temperament":"…"}]}， persons 数量与输入人物数一致，name 原样返回。`.trim()

export function profilePayload(projectId: string, names?: string[]): { projectId: string; persons: ProfileSubject[] } {
	return { projectId, persons: profileSubjects(eventBroughtPersons(projectId), names) }
}

export function profileEstimateFor(userPrompt: string, mode: string, modelId: BailianModelId, personCount: number): ProfileEstimate {
	const prices = BAILIAN_MODELS[modelId] ?? BAILIAN_MODELS[profileModelId]
	const maxOutputTokens = Math.min(profileMaxOutputTokens, 400 + personCount * 320)
	const inputTokenAllowance = Buffer.byteLength(profileSystemPrompt + userPrompt, 'utf8') + 1024
	return {
		billingMode: mode,
		modelId,
		inputTokenAllowance,
		maxOutputTokens,
		tokenAllowance: inputTokenAllowance + maxOutputTokens,
		ceilingCny:
			mode === 'token-plan' ? null : (inputTokenAllowance * prices.inputPricePerMillion + maxOutputTokens * prices.outputPricePerMillion) / 1_000_000,
	}
}

/** 外发清单：不发请求，只算出会被送出去的人物与字数，供作者确认。 */
export function profilePreview(projectId: string, names?: string[]) {
	const payload = profilePayload(projectId, names)
	const configuration = getBailianConfiguration()
	const modelId = configuration?.fastModel ?? profileModelId
	const userPrompt = JSON.stringify(payload)
	return {
		blocked: profilesBlockedReason(projectId),
		count: payload.persons.length,
		names: payload.persons.map((person) => person.name),
		eventCount: payload.persons.reduce((sum, person) => sum + person.events.length, 0),
		characters: [...userPrompt].length,
		model: modelId,
		estimate: profileEstimateFor(userPrompt, billingMode(configuration?.baseURL ?? process.env.BAILIAN_BASE_URL), modelId, payload.persons.length),
	}
}

export function profilesBlockedReason(projectId: string): string | null {
	if (!getBailianConfiguration()) return '未配置百炼 API Key，无法调用模型。'
	if (!profileSubjects(eventBroughtPersons(projectId)).length) return '请先在第 03 步采用事件带出人物，再配置性格与风貌。'
	return null
}

function parseModelJson(raw: string): unknown {
	const start = raw.indexOf('{')
	const end = raw.lastIndexOf('}')
	if (start < 0 || end <= start) throw new ProfileError('模型未返回可解析的人物设定 JSON。')
	try {
		return JSON.parse(raw.slice(start, end + 1)) as unknown
	} catch {
		throw new ProfileError('模型未返回可解析的人物设定 JSON。')
	}
}

export type ProfileDraft = { name: string; personality: string; temperament: string }

function sanitizeDrafts(raw: unknown, known: Set<string>): ProfileDraft[] {
	const source = (raw ?? {}) as Record<string, unknown>
	if (!Array.isArray(source.persons)) return []
	const drafts: ProfileDraft[] = []
	for (const item of source.persons as unknown[]) {
		const entry = (item ?? {}) as Record<string, unknown>
		const name = String(entry.name ?? '').trim()
		const personality = String(entry.personality ?? '').trim().slice(0, 4000)
		const temperament = String(entry.temperament ?? '').trim().slice(0, 4000)
		// 模型改写过的姓名不认，避免写进对不上号的人物档案。
		if (!name || !known.has(name) || !personality) continue
		drafts.push({ name, personality, temperament })
	}
	return drafts
}

export type ProfileGeneration = {
	generated: ProfileDraft[]
	missing: string[]
	usage: { promptTokens: number | null; completionTokens: number | null } | null
	requestId: string | null
	estimate: ProfileEstimate
}

/** 批量生成但不写库：作者确认后再由 save 落 manual，或直接落 model 待核。 */
export async function generatePersonProfiles(projectId: string, names?: string[]): Promise<ProfileGeneration> {
	const blocked = profilesBlockedReason(projectId)
	if (blocked) throw new ProfileError(blocked, 400)
	const payload = profilePayload(projectId, names)
	const configuration = getBailianConfiguration()!
	const modelId = configuration.fastModel
	const userPrompt = JSON.stringify(payload)
	const estimate = profileEstimateFor(userPrompt, configuration.billingMode, modelId, payload.persons.length)
	const client = new OpenAI({ apiKey: configuration.apiKey, baseURL: configuration.baseURL, maxRetries: 0, timeout: 600_000 })
	let completion: OpenAI.Chat.Completions.ChatCompletion
	try {
		completion = await client.chat.completions.create({
			model: modelId,
			messages: [
				{ role: 'system', content: profileSystemPrompt },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: estimate.maxOutputTokens,
			temperature: 0.4,
			response_format: { type: 'json_object' },
			enable_thinking: false,
		} as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { enable_thinking: boolean })
	} catch (error) {
		throw new ProfileError(
			error instanceof OpenAI.APIError ? `人物设定生成失败：HTTP ${error.status}；未写入任何人物。` : '人物设定请求状态未知；未写入任何人物，请先核对百炼请求记录。',
			502,
		)
	}
	const known = new Set(payload.persons.map((person) => person.name))
	const generated = sanitizeDrafts(parseModelJson(completion.choices[0]?.message?.content ?? ''), known)
	const usage = completion.usage
	return {
		generated,
		missing: [...known].filter((name) => !generated.some((draft) => draft.name === name)),
		usage: usage ? { promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null } : null,
		requestId: completion.id ?? null,
		estimate,
	}
}

/** 模型稿落库：只覆盖还没有人工定稿的人物（profile_source 为空或 model），作者写过的不动。 */
export function saveModelProfiles(projectId: string, drafts: ProfileDraft[], reviewStatus = 'auto') {
	const now = new Date().toISOString()
	let written = 0
	const skipped: string[] = []
	db.transaction(() => {
		for (const draft of drafts) {
			const person = db.prepare('SELECT id, profile_source AS profileSource FROM characters WHERE project_id = ? AND name = ?').get(projectId, draft.name) as
				| { id: string; profileSource: string }
				| undefined
			if (!person) {
				skipped.push(draft.name)
				continue
			}
			if (person.profileSource === 'manual') {
				skipped.push(draft.name)
				continue
			}
			db.prepare("UPDATE characters SET personality = ?, temperament = ?, profile_source = 'model', review_status = ? WHERE id = ?").run(
				draft.personality,
				draft.temperament,
				reviewStatus,
				person.id,
			)
			written += 1
		}
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	return { written, skipped }
}
