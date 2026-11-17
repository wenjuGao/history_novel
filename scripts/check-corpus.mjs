import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'

const root = process.cwd()
const catalog = JSON.parse(await readFile(path.join(root, 'data/catalog/history-books.json'), 'utf8'))
const corpusRoot = path.join(root, 'data/local/corpus/wikisource')
const report = { expectedBooks: catalog.books.length, expectedPages: 0, books: [], errors: [] }

function safeFileStem(value) {
	return Buffer.from(value, 'utf8').toString('base64url')
}

for (const book of catalog.books) {
	report.expectedPages += book.expectedPageCount
	const directory = path.join(corpusRoot, book.id)
	let status = null
	let index = null
	try {
		status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'))
		const indexPath = path.join(directory, `index-${status.indexOldid ?? 'unversioned'}.json`)
		index = JSON.parse(await readFile(indexPath, 'utf8'))
	} catch {
		report.books.push({ name: book.name, expected: book.expectedPageCount, collected: 0, status: 'not-started' })
		continue
	}

	const pagesDirectory = path.join(directory, 'pages')
	let valid = 0
	const bookErrors = []
	const pageFiles = await readdir(pagesDirectory).catch(() => [])
	for (const volume of index.volumes) {
		const stem = safeFileStem(volume.title)
		const candidates = pageFiles.filter((name) => name.startsWith(`${stem}--`) && name.endsWith('.json'))
		if (!candidates.length) {
			if (bookErrors.length < 20) bookErrors.push(`${volume.title}: missing page record`)
			continue
		}
		let pageValid = false
		for (const file of candidates) {
			try {
				const recordPath = path.join(pagesDirectory, file)
				const record = JSON.parse(await readFile(recordPath, 'utf8'))
				const compressedPath = path.resolve(corpusRoot, record.rawHtmlPath)
				if (!compressedPath.startsWith(`${path.resolve(corpusRoot)}${path.sep}`)) throw new Error('snapshot path escapes corpus directory')
				const compressed = await readFile(compressedPath)
				const rawHtml = gunzipSync(compressed).toString('utf8')
				const rawHash = createHash('sha256').update(rawHtml, 'utf8').digest('hex')
				const textHash = createHash('sha256').update(record.text, 'utf8').digest('hex')
				if (
					record.bookId !== book.id ||
					!record.oldid ||
					rawHash !== record.rawHtmlSha256 ||
					textHash !== record.textSha256 ||
					!record.sourceUrl ||
					!record.licenseUrl
				) {
					throw new Error('metadata or checksum mismatch')
				}
				pageValid = true
				break
			} catch (error) {
				if (bookErrors.length < 20) bookErrors.push(`${volume.title}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		if (pageValid) valid += 1
	}

	const complete = valid === book.expectedPageCount && status.observedVolumeCount === book.expectedPageCount && status.failed === 0
	if (!complete && bookErrors.length < 20)
		bookErrors.push(`expected ${book.expectedPageCount} pages, have ${valid}; observed ${status.observedVolumeCount}; failures ${status.failed}`)
	report.books.push({
		name: book.name,
		expected: book.expectedPageCount,
		collected: valid,
		failed: status.failed,
		status: complete ? 'complete' : 'incomplete'
	})
	report.expectedPages += 0
	report.errors.push(...bookErrors.map((error) => `${book.name}: ${error}`))
}

report.collectedPages = report.books.reduce((sum, book) => sum + book.collected, 0)
report.completedBooks = report.books.filter((book) => book.status === 'complete').length
report.complete = report.completedBooks === report.expectedBooks && report.collectedPages === report.expectedPages && report.errors.length === 0
console.log(JSON.stringify(report, null, 2))
if (!report.complete) process.exitCode = 1
