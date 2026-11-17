import 'server-only'

import OpenAI from 'openai'
import { resolveBailianEndpoint, billingMode } from './bailian-endpoint.mjs'

export const BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export const BAILIAN_MODELS = {
	'qwen3.8-max': {
		name: 'Qwen 3.8 Max',
		role: '写作规格、大纲与章节正文',
		inputPricePerMillion: 12,
		outputPricePerMillion: 36
	},
	'qwen3.8-flash': {
		name: 'Qwen 3.8 Flash',
		role: '史料提取、关联辅助与规则审阅',
		inputPricePerMillion: 0.8,
		outputPricePerMillion: 2.7
	}
} as const

export type BailianModelId = keyof typeof BAILIAN_MODELS

export type BailianConfiguration = {
	apiKey: string
	baseURL: string
	billingMode: string
	writingModel: BailianModelId
	fastModel: BailianModelId
}

function parseModelId(value: string | undefined, fallback: BailianModelId): BailianModelId {
	if (!value) return fallback
	if (value in BAILIAN_MODELS) return value as BailianModelId
	throw new Error('百炼模型配置不在项目允许列表中。')
}

export function getBailianConfiguration(): BailianConfiguration | null {
	const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
	if (!apiKey) return null

	const baseURL = resolveBailianEndpoint(process.env.BAILIAN_BASE_URL)

	return {
		apiKey,
		baseURL,
		billingMode: billingMode(baseURL),
		writingModel: parseModelId(process.env.BAILIAN_MODEL_WRITING, 'qwen3.8-max'),
		fastModel: parseModelId(process.env.BAILIAN_MODEL_FAST, 'qwen3.8-flash')
	}
}

export function createBailianClient(configuration = getBailianConfiguration()) {
	if (!configuration) throw new Error('请在服务端环境变量配置 DASHSCOPE_API_KEY。')
	return new OpenAI({ apiKey: configuration.apiKey, baseURL: configuration.baseURL })
}
