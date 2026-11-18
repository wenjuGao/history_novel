import 'server-only'

import { db } from '@/lib/db'

// 人物年份档案的读取层：数据由 npm run corpus:years 预处理生成（src/lib/corpus-years.mjs），
// 这里只做查询与判定，不在保存范围或读取候选时生成数据。

export type PersonDeed = { year: number; text: string; period: string; volume: string; book: string; url: string }

export type PersonProfile = {
	name: string
	birth: number | null
	birthPrecision: 'exact' | 'approx' | 'unknown'
	death: number | null
	deathPrecision: 'exact' | 'approx' | 'unknown'
	activeFrom: number | null
	activeTo: number | null
	laterMentions: number
	trimmed: boolean
	entryCount: number
	deeds: PersonDeed[]
	yearSource: 'anchor' | 'model' | 'mixed'
	needsReview: boolean
	/** 跨度或证据不足以支撑「可考」的档案，只进待核组，不混入按年份筛出的确定候选。 */
	plausible: boolean
}

// 一个人在史料里连续活跃的上限：超过它多半是把同名的几代人或后世追述并到了一起。
const MAX_PLAUSIBLE_SPAN = 90

function rowsReady(kind: string) {
	const row = db.prepare('SELECT rows FROM corpus_state WHERE kind = ?').get(kind) as { rows: number } | undefined
	return Boolean(row && row.rows > 0)
}

export function yearsIndexReady() {
	return rowsReady('years')
}

function parseDeeds(value: string): PersonDeed[] {
	try {
		const parsed = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed
			.filter((deed) => deed && typeof deed.text === 'string' && Number.isInteger(deed.year))
			.slice(0, 5)
			.map((deed) => ({
				year: deed.year as number,
				text: String(deed.text).slice(0, 120),
				period: typeof deed.period === 'string' ? deed.period : '',
				volume: typeof deed.volume === 'string' ? deed.volume : '',
				book: typeof deed.book === 'string' ? deed.book : '',
				url: typeof deed.url === 'string' ? deed.url : '',
			}))
	} catch {
		return []
	}
}

type ProfileRow = {
	name: string
	birth_year: number | null
	birth_precision: string
	death_year: number | null
	death_precision: string
	first_year: number | null
	last_year: number | null
	later_mentions: number
	interval_trimmed: number
	entry_count: number
	deeds: string
	year_source: string
	needs_review: number
}

function toProfile(row: ProfileRow): PersonProfile {
	const span = row.first_year !== null && row.last_year !== null ? row.last_year - row.first_year : null
	const plausible =
		span !== null && span >= 0 && span <= MAX_PLAUSIBLE_SPAN && (row.entry_count >= 3 || row.death_year !== null)
	return {
		name: row.name,
		birth: row.birth_year,
		birthPrecision: (row.birth_precision as PersonProfile['birthPrecision']) ?? 'unknown',
		death: row.death_year,
		deathPrecision: (row.death_precision as PersonProfile['deathPrecision']) ?? 'unknown',
		activeFrom: row.first_year,
		activeTo: row.last_year,
		laterMentions: row.later_mentions ?? 0,
		trimmed: row.interval_trimmed === 1,
		entryCount: row.entry_count ?? 0,
		deeds: parseDeeds(row.deeds),
		yearSource: (row.year_source as PersonProfile['yearSource']) ?? 'anchor',
		needsReview: row.needs_review === 1,
		plausible,
	}
}

export function personProfiles(names: string[]): Map<string, PersonProfile> {
	const list = [...new Set(names.filter(Boolean))]
	if (!list.length) return new Map()
	const profiles = new Map<string, PersonProfile>()
	const placeholders = list.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT name, birth_year, birth_precision, death_year, death_precision, first_year, last_year,
				later_mentions, interval_trimmed, entry_count, deeds, year_source, needs_review
			 FROM corpus_person_profile WHERE name IN (${placeholders})`,
		)
		.all(...list) as ProfileRow[]
	for (const row of rows) profiles.set(row.name, toProfile(row))
	return profiles
}

/** 生卒或活动区间与范围有交集即算「生活在此期间」；档案缺失或不可信时返回 null，交给待核组。 */
export function profileInScope(profile: PersonProfile | undefined, startYear: number, endYear: number): boolean | null {
	if (!profile || !profile.plausible) return null
	const from = profile.birth ?? profile.activeFrom
	const to = profile.death ?? profile.activeTo
	if (from === null || to === null) return null
	return from <= endYear && to >= startYear
}

/** 事件候选用的年份下限：优先活动区间，缺失时退回档案里的任意带年记事。 */
export function profileSpan(profile: PersonProfile | undefined): { start: number; end: number } | null {
	if (!profile) return null
	const start = profile.birth ?? profile.activeFrom
	const end = profile.death ?? profile.activeTo
	if (start === null || end === null) return null
	return { start, end }
}
