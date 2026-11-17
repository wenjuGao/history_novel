// CLI 脚本与 Next 服务共用同一份列补丁，避免两边的表形状各自漂移。
// 新列一律写在这里（以及 006 之类的建表语句），不要再在各处散落 ALTER TABLE。

export const addedColumns = {
	story_plan_approvals: {
		billing_mode: "TEXT NOT NULL DEFAULT 'pay-as-you-go'",
		model_id: "TEXT NOT NULL DEFAULT 'qwen3.8-max'",
		token_budget: 'INTEGER',
		evidence_confirmed: 'INTEGER NOT NULL DEFAULT 0',
	},
	chapter_generation_attempts: {
		billing_mode: "TEXT NOT NULL DEFAULT 'pay-as-you-go'",
		reserved_tokens: 'INTEGER NOT NULL DEFAULT 0',
		content: "TEXT NOT NULL DEFAULT ''",
		estimated_cost_cny: 'REAL NOT NULL DEFAULT 0',
		initiator: "TEXT NOT NULL DEFAULT 'manual'",
	},
	chapter_drafts: {
		active_attempt_id: 'TEXT',
		meta_json: 'TEXT',
		raw_output: 'TEXT',
		needs_review: 'INTEGER NOT NULL DEFAULT 0',
		review_reason: 'TEXT',
		auto_continuations: 'INTEGER NOT NULL DEFAULT 0',
	},
	documents: { corpus_ref: 'TEXT' },
	characters: { review_status: "TEXT NOT NULL DEFAULT 'confirmed'" },
	historical_relations: { review_status: "TEXT NOT NULL DEFAULT 'confirmed'" },
	plot_events: {
		needs_review: 'INTEGER NOT NULL DEFAULT 0',
		verified_at: 'TEXT',
	},
	reference_novel: { volume_order: 'INTEGER NOT NULL DEFAULT 0' },
}

export function applyAddedColumns(database) {
	for (const [table, columns] of Object.entries(addedColumns)) {
		const existing = database.pragma(`table_info(${table})`)
		for (const [name, definition] of Object.entries(columns)) {
			if (!existing.some((column) => column.name === name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
		}
	}
}
