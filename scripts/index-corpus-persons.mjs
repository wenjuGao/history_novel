import { openDatabase } from './lib/db.mjs'
import { corpusBooks } from '../src/lib/corpus-books.mjs'
import { extractPersonCandidates, extractPersonEdges } from '../src/lib/corpus-person-extract.mjs'
import { iterateCorpusVolumes, corpusReportSha256 } from '../src/lib/corpus-import.mjs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--help')) {
	console.log('用法：npm run corpus:persons -- [--min-mentions 3] [--max-persons 400] [--book 史書id]')
	process.exit(0)
}
function flag(name, fallback) {
	const index = argv.indexOf(`--${name}`)
	return index >= 0 ? argv[index + 1] : fallback
}

const minMentions = Number(flag('min-mentions', 3))
const maxPersons = Number(flag('max-persons', 400))
const maxEdges = Number(flag('max-edges', 300))
const onlyBook = flag('book', null)
const quiet = argv.includes('--quiet')

const corpusRoot = process.env.HISTORY_CORPUS_DIR || path.join(process.cwd(), 'data', 'local', 'corpus', 'wikisource')
const { database } = openDatabase()

const reportRaw = await readFile(path.join(corpusRoot, 'report.json'), 'utf8')
const reportHash = corpusReportSha256(reportRaw)

const bookNameById = new Map(corpusBooks.map((book) => [book.id, book.name]))
const upsertPerson = database.prepare(
	`INSERT INTO corpus_person(book_id, name, mentions, volume_hits, volumes, evidence, evidence_volume, evidence_url, indexed_at)
	 VALUES (@book_id, @name, @mentions, @volume_hits, @volumes, @evidence, @evidence_volume, @evidence_url, @indexed_at)
	 ON CONFLICT(book_id, name) DO UPDATE SET mentions = excluded.mentions, volume_hits = excluded.volume_hits, volumes = excluded.volumes,
		evidence = excluded.evidence, evidence_volume = excluded.evidence_volume, evidence_url = excluded.evidence_url, indexed_at = excluded.indexed_at`,
)
const upsertEdge = database.prepare(
	`INSERT INTO corpus_person_edge(book_id, name_a, name_b, co_mentions, volumes, evidence, evidence_volume, evidence_url, indexed_at)
	 VALUES (@book_id, @name_a, @name_b, @co_mentions, @volumes, @evidence, @evidence_volume, @evidence_url, @indexed_at)
	 ON CONFLICT(book_id, name_a, name_b) DO UPDATE SET co_mentions = excluded.co_mentions, volumes = excluded.volumes,
		evidence = excluded.evidence, evidence_volume = excluded.evidence_volume, evidence_url = excluded.evidence_url, indexed_at = excluded.indexed_at`,
)

let current = null
let persons = new Map()
let edges = new Map()
let volumesSeen = 0
let totals = { persons: 0, edges: 0 }

function flushBook() {
	if (!current) return
	const keep = [...persons.values()]
		.filter((person) => person.mentions >= minMentions)
		.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'zh'))
		.slice(0, maxPersons)
	const keepNames = new Set(keep.map((person) => person.name))
	const keepEdges = [...edges.values()]
		.filter((edge) => edge.co >= 2 && keepNames.has(edge.a) && keepNames.has(edge.b))
		.sort((a, b) => b.co - a.co)
		.slice(0, maxEdges)
	const builtAt = new Date().toISOString()
	database.transaction(() => {
		// 每次重跑先清空该书的候选，保证索引结果只由当前规则决定。
		database.prepare('DELETE FROM corpus_person WHERE book_id = ?').run(current)
		database.prepare('DELETE FROM corpus_person_edge WHERE book_id = ?').run(current)
		for (const person of keep) {
			upsertPerson.run({
				book_id: current,
				name: person.name,
				mentions: person.mentions,
				volume_hits: person.volumes.size,
				volumes: JSON.stringify([...person.volumes].slice(0, 12)),
				evidence: person.evidence,
				evidence_volume: person.evidenceVolume ?? '',
				evidence_url: person.evidenceUrl ?? '',
				indexed_at: builtAt,
			})
		}
		for (const edge of keepEdges) {
			upsertEdge.run({
				book_id: current,
				name_a: edge.a,
				name_b: edge.b,
				co_mentions: edge.co,
				volumes: JSON.stringify([...edge.volumes].slice(0, 12)),
				evidence: edge.evidence,
				evidence_volume: edge.evidenceVolume ?? '',
				evidence_url: edge.evidenceUrl ?? '',
				indexed_at: builtAt,
			})
		}
	})()
	totals.persons += keep.length
	totals.edges += keepEdges.length
	if (quiet) return
	const preview = keep
		.slice(0, 20)
		.map((person) => `${person.name}:${person.mentions}`)
		.join(' ')
	console.log(`${bookNameById.get(current) ?? current}　 ${String(volumesSeen).padStart(4)} 卷　人名 ${keep.length}　强关联 ${keepEdges.length}　Top20 ${preview}`)
}

for await (const volume of iterateCorpusVolumes(database)) {
	if (onlyBook && volume.bookId !== onlyBook) continue
	if (volume.bookId !== current) {
		flushBook()
		current = volume.bookId
		persons = new Map()
		edges = new Map()
		volumesSeen = 0
	}
	volumesSeen += 1
	const candidates = extractPersonCandidates(volume.text)
	for (const [name, candidate] of candidates) {
		const target = persons.get(name) ?? { name, mentions: 0, volumes: new Set(), evidence: '', evidenceVolume: '', evidenceUrl: '' }
		target.mentions += candidate.mentions
		target.volumes.add(volume.volumeName)
		// 证据只在缺失或退化成人名本身时替换，替换后卷名与原文链接同步跟上。
		if (!target.evidence || target.evidence === name) {
			target.evidence = candidate.evidence
			target.evidenceVolume = volume.volumeName
			target.evidenceUrl = volume.sourceUrl
		}
		persons.set(name, target)
	}
	if (candidates.size > 1) {
		for (const [key, edge] of extractPersonEdges(volume.text, [...candidates.keys()])) {
			const target = edges.get(key) ?? { a: edge.a, b: edge.b, co: 0, volumes: new Set(), evidence: edge.evidence, evidenceVolume: '', evidenceUrl: '' }
			target.co += edge.co
			target.volumes.add(volume.volumeName)
			if (!target.evidenceVolume && edge.evidence.length > 6) {
				target.evidence = edge.evidence
				target.evidenceVolume = volume.volumeName
				target.evidenceUrl = volume.sourceUrl
			}
			edges.set(key, target)
		}
	}
}
flushBook()

const stateRow = database.prepare('SELECT COUNT(*) AS count FROM corpus_person').get()
database
	.prepare(
		`INSERT INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES ('persons', ?, ?, ?, ?)
		 ON CONFLICT(kind) DO UPDATE SET sha256 = excluded.sha256, rows = excluded.rows, built_at = excluded.built_at, notes = excluded.notes`,
	)
	.run(reportHash, stateRow?.count ?? 0, new Date().toISOString(), JSON.stringify({ books: corpusBooks.length, minMentions, maxPersons, yearsAstronomical: true }))

console.log(`完成：入库人名 ${totals.persons} 条、强关联 ${totals.edges} 条（min-mentions ${minMentions}）。`)
