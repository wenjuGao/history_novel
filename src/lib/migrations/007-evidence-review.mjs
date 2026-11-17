// 007 证据复核迁移（一次性，PRAGMA user_version 守护）：
// 1) 旧「已采用 + 派生」事件缺少可验证的人工确认记录，一律标记待复核；
//    之后作者在事件面板逐条核对原文并确认（needs_review=0、verified_at 记录确认时间）。
// 2) 强关联关系时间改为可空：自动共现线索不再用作品年份代填活动年份；
//    旧 auto 关系的时间清空为待核线索，作者核对原文后确认并补时间才进入关系图。

export const EVIDENCE_REVIEW_VERSION = 7

export function applyEvidenceReviewMigration(database) {
	const current = database.pragma('user_version', { simple: true })
	if (current >= EVIDENCE_REVIEW_VERSION) return

	const columns = database.pragma('table_info(plot_events)')
	if (!columns.some((column) => column.name === 'needs_review') || !columns.some((column) => column.name === 'verified_at')) {
		// applyAddedColumns 应先于本迁移执行；此处兜底，避免新库半初始化时报错。
		throw new Error('plot_events 缺少复核列，先执行 applyAddedColumns。')
	}

	// 重建表以硬编码列集为基础：若后续在 schema-columns 给 historical_relations 加列而不更新本迁移，
	// 重建会静默丢列。这里显式断言列集一致，宁可失败也不丢失数据。
	const expectedColumns = ['id', 'project_id', 'from_id', 'to_id', 'label', 'document_id', 'evidence', 'start_year', 'end_year', 'review_status']
	const actualColumns = database.pragma('table_info(historical_relations)').map((column) => column.name)
	const unexpectedColumns = actualColumns.filter((name) => !expectedColumns.includes(name))
	if (unexpectedColumns.length) {
		throw new Error(`historical_relations 存在 007 未知的列（${unexpectedColumns.join('、')}）；请先扩展 007 迁移的重建语句再升级。`)
	}

	const markAndRebuild = database.transaction(() => {
		database.exec(`
			UPDATE plot_events
			 SET needs_review = 1
			 WHERE origin = 'derived' AND status = 'adopted' AND verified_at IS NULL AND needs_review = 0
		`)
		database.exec(`
			CREATE TABLE historical_relations_v2 (
			 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
			 from_id TEXT NOT NULL REFERENCES characters(id), to_id TEXT NOT NULL REFERENCES characters(id),
			 label TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), evidence TEXT NOT NULL,
			 start_year INTEGER, end_year INTEGER, review_status TEXT NOT NULL DEFAULT 'confirmed',
			 CHECK(from_id != to_id), CHECK(start_year IS NULL OR end_year IS NULL OR start_year <= end_year)
			);
			INSERT INTO historical_relations_v2 (id, project_id, from_id, to_id, label, document_id, evidence, start_year, end_year, review_status)
			 SELECT id, project_id, from_id, to_id, label, document_id, evidence,
				CASE WHEN review_status = 'auto' THEN NULL ELSE start_year END,
				CASE WHEN review_status = 'auto' THEN NULL ELSE end_year END,
				review_status
			 FROM historical_relations;
			DROP TABLE historical_relations;
			ALTER TABLE historical_relations_v2 RENAME TO historical_relations;
		`)
		// user_version 随数据变更原子提交，消除“已迁移但未标记”的崩溃窗口。
		database.pragma(`user_version = ${EVIDENCE_REVIEW_VERSION}`)
	})
	markAndRebuild()
}
