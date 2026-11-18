import { openDatabase } from './lib/db.mjs'
import { YEAR_ANCHORED_BOOKS, buildNameIndex, buildProfile, indexVolume } from '../src/lib/corpus-years.mjs'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
if (argv.includes('--help')) {
	console.log('用法：npm run corpus:years -- [--book 史書id] [--max-deeds 5] [--quiet]')
	console.log('解析带绝对纪年的史料卷文，生成 corpus_entry（可定年记事）与 corpus_person_profile（人物年份档案）。零 Token。')
	process.exit(0)
}
function flag(name, fallback) {
	const index = argv.indexOf(`--${name}`)
	return index >= 0 ? argv[index + 1] : fallback
}
const onlyBook = flag('book', null)
const deedsLimit = Number(flag('max-deeds', 5))
const quiet = argv.includes('--quiet')

const { database } = openDatabase()
const indexedNames = database.prepare('SELECT DISTINCT name FROM corpus_person').all().map((row) => row.name)
const nameIndex = buildNameIndex(indexedNames)
const bookRows = database
	.prepare('SELECT book_id AS id, name FROM corpus_book ORDER BY start_year')
	.all()
	.filter((book) => YEAR_ANCHORED_BOOKS.includes(book.id) && (!onlyBook || book.id === onlyBook))

if (!bookRows.length) {
	console.error('没有可解析的带年纪史料。请先执行 npm run corpus:index 与 npm run corpus:persons。')
	process.exit(1)
}

const insertEntry = database.prepare(
	`INSERT INTO corpus_entry(book_id, entry_key, volume_name, year_astronomical, year_label, sequence, period, text, has_death, year_precision, source_url, indexed_at)
	 VALUES (@book_id, @entry_key, @volume_name, @year, @year_label, @sequence, @period, @text, @has_death, @year_precision, @source_url, @indexed_at)`,
)
const insertEntryPerson = database.prepare('INSERT INTO corpus_entry_person(entry_key, name, is_death) VALUES (?, ?, ?)')
const upsertProfile = database.prepare(
	`INSERT INTO corpus_person_profile(name, birth_year, birth_precision, death_year, death_precision, first_year, last_year, later_mentions, interval_trimmed, entry_count, deeds, year_source, needs_review, updated_at)
	 VALUES (@name, @birth_year, @birth_precision, @death_year, @death_precision, @first_year, @last_year, @later_mentions, @interval_trimmed, @entry_count, @deeds, 'anchor', 1, @updated_at)
	 ON CONFLICT(name) DO UPDATE SET birth_year = excluded.birth_year, birth_precision = excluded.birth_precision, death_year = excluded.death_year,
		death_precision = excluded.death_precision, first_year = excluded.first_year, last_year = excluded.last_year,
		later_mentions = excluded.later_mentions, interval_trimmed = excluded.interval_trimmed,
		entry_count = excluded.entry_count, deeds = excluded.deeds, year_source = excluded.year_source, needs_review = excluded.needs_review, updated_at = excluded.updated_at`,
)

// 条目主键只由书目、卷、行号与年份决定：同一份快照重跑得到同一批 key，已采用事件对原文的引用因此保持稳定。
function entryKey(bookId, volumeName, entry) {
	return createHash('sha256')
		.update([bookId, volumeName, entry.year, entry.line, entry.text.slice(0, 24)].join('|'))
		.digest('hex')
		.slice(0, 32)
}

const builtAt = new Date().toISOString()
let anchors = 0

for (const book of bookRows) {
	const volumes = database
		.prepare('SELECT volume_name AS volumeName, source_url AS sourceUrl, text FROM corpus_volume WHERE book_id = ? ORDER BY volume_name')
		.all(book.id)
	let carryYear = null
	let carryLabel = ''
	let written = 0
	database
		.transaction(() => {
			// 重跑先清空该书目的年纪索引，保证结果只由当前解析规则决定。
			database.prepare('DELETE FROM corpus_entry_person WHERE entry_key IN (SELECT entry_key FROM corpus_entry WHERE book_id = ?)').run(book.id)
			database.prepare('DELETE FROM corpus_entry WHERE book_id = ?').run(book.id)
			for (const volume of volumes) {
				const result = indexVolume(volume.text, nameIndex, { carryYear, carryLabel })
				carryYear = result.carryYear
				carryLabel = result.carryLabel
				anchors += result.anchors
				result.entries.forEach((entry, index) => {
					const key = entryKey(book.id, volume.volumeName, entry)
					insertEntry.run({
						book_id: book.id,
						entry_key: key,
						volume_name: volume.volumeName,
						year: entry.year,
						year_label: entry.yearLabel.slice(0, 80),
						sequence: index + 1,
						period: entry.period,
						text: entry.text,
						has_death: entry.deaths.length ? 1 : 0,
						year_precision: entry.yearPrecision,
						source_url: volume.sourceUrl,
						indexed_at: builtAt,
					})
					const deathNames = new Set(entry.deaths.map((death) => death.name))
					for (const name of entry.names) insertEntryPerson.run(key, name, deathNames.has(name) ? 1 : 0)
					written += 1
				})
			}
		})()
	if (!quiet) console.log(`${book.name}　 ${volumes.length} 卷　年纪标题 ${anchors}　带年记事 ${written}`)
}

// 人物年份档案跨书聚合，因此在全部书目索引完后统一重建，避免后跑的书覆盖前一本的区间。
const entryRows = database
	.prepare(
		`SELECT p.name AS name, e.year_astronomical AS year, e.year_precision AS yearPrecision, e.text, e.period,
				e.volume_name AS volumeName, e.source_url AS sourceUrl, b.name AS bookName, p.is_death AS isDeath
		 FROM corpus_entry_person p JOIN corpus_entry e ON e.entry_key = p.entry_key JOIN corpus_book b ON b.book_id = e.book_id`,
	)
	.all()
const byName = new Map()
for (const row of entryRows) {
	const entry = {
		year: row.year,
		yearPrecision: row.yearPrecision,
		text: row.text,
		period: row.period,
		volumeName: row.volumeName,
		sourceUrl: row.sourceUrl,
		bookName: row.bookName,
		names: [row.name],
		deaths: row.isDeath ? [{ name: row.name }] : [],
	}
	const list = byName.get(row.name)
	if (list) list.push(entry)
	else byName.set(row.name, [entry])
}

let deaths = 0
let profiles = 0
database
	.transaction(() => {
		database.prepare("DELETE FROM corpus_person_profile WHERE year_source = 'anchor'").run()
		for (const [name, owned] of byName) {
			const profile = buildProfile(name, owned, { deedsLimit })
			if (!profile) continue
			upsertProfile.run({
				name,
				birth_year: profile.birth,
				birth_precision: profile.birthPrecision,
				death_year: profile.death,
				death_precision: profile.deathPrecision,
				first_year: profile.firstYear,
				last_year: profile.lastYear,
				later_mentions: profile.laterMentions,
				interval_trimmed: profile.intervalTrimmed ? 1 : 0,
				entry_count: profile.entryCount,
				deeds: JSON.stringify(profile.deeds),
				updated_at: builtAt,
			})
			profiles += 1
			if (profile.death !== null) deaths += 1
		}
	})()

const entryCount = database.prepare('SELECT COUNT(*) AS count FROM corpus_entry').get()?.count ?? 0
const personState = database.prepare("SELECT sha256 FROM corpus_state WHERE kind = 'persons'").get()
database
	.prepare(
		`INSERT INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES ('years', ?, ?, ?, ?)
		 ON CONFLICT(kind) DO UPDATE SET sha256 = excluded.sha256, rows = excluded.rows, built_at = excluded.built_at, notes = excluded.notes`,
	)
	.run(
		createHash('sha256')
			.update(personState?.sha256 ?? '')
			.update('|deeds=')
			.update(String(deedsLimit))
			.digest('hex'),
		entryCount,
		builtAt,
		JSON.stringify({ books: bookRows.map((book) => book.id), anchors, profiles, deaths, indexedNames: nameIndex.size }),
	)

console.log(`完成：带年记事 ${entryCount} 条、人物年份档案 ${profiles} 位（其中卒年可考 ${deaths} 位）。`)
