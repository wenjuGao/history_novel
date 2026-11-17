import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

// 参考小说登记：只登记本机已转换文本的哈希与抽象写作规格。
// 小说正文永远只以哈希形式出现，规格文本才是可以进入生成上下文的产物。

export function sha256Of(buffer) {
	return createHash('sha256').update(buffer).digest('hex')
}

export async function loadReferenceCatalog(root) {
	const raw = await readFile(path.join(root, 'data', 'catalog', 'reference-novels.json'), 'utf8')
	return { catalog: JSON.parse(raw), catalogSha256: sha256Of(raw) }
}

async function fileSha(pathname) {
	return sha256Of(await readFile(pathname))
}

export async function registerReferenceNovels(database, { root, onVolume } = {}) {
	const { catalog, catalogSha256 } = await loadReferenceCatalog(root)
	const summary = { catalogSha256, series: 0, verified: 0, missing: [], specs: [] }
	const registeredAt = new Date().toISOString()

	const upsertNovel = database.prepare(
		`INSERT INTO reference_novel(source_sha256, series_key, series, volume, volume_order, title, filename, characters, bytes, text_path, text_sha256, toc_entries, converted_at, registered_at)
		 VALUES (@source_sha256, @series_key, @series, @volume, @volume_order, @title, @filename, @characters, @bytes, @text_path, @text_sha256, @toc_entries, @converted_at, @registered_at)
		 ON CONFLICT(source_sha256) DO UPDATE SET series_key = excluded.series_key, series = excluded.series, volume = excluded.volume, volume_order = excluded.volume_order, title = excluded.title,
			filename = excluded.filename, characters = excluded.characters, bytes = excluded.bytes, text_path = excluded.text_path, text_sha256 = excluded.text_sha256,
			toc_entries = excluded.toc_entries, converted_at = excluded.converted_at, registered_at = excluded.registered_at`,
	)

	for (const series of catalog.series ?? []) {
		summary.series += 1
		const hashes = []
		for (const volume of series.volumes ?? []) {
			const directory = path.join('data', 'local', 'converted', volume.sourceSha256)
			const textPath = path.join(root, directory, 'text.txt')
			const mobiPath = path.join(root, directory, 'original.mobi')
			let manifest
			try {
				manifest = JSON.parse(await readFile(path.join(root, directory, 'manifest.json'), 'utf8'))
			} catch {
				summary.missing.push(`${series.name} ${volume.volume}：缺少转换目录 ${directory}`)
				onVolume?.({ series: series.name, volume: volume.volume, status: 'missing' })
				continue
			}
			const problems = []
			if (manifest.sourceSha256 !== volume.sourceSha256) problems.push('manifest 源哈希与目录不符')
			if (manifest.textSha256 !== volume.textSha256) problems.push('manifest 正文哈希与目录不符')
			let mobiSha = ''
			let textSha = ''
			try {
				mobiSha = await fileSha(mobiPath)
				textSha = await fileSha(textPath)
			} catch {
				problems.push('转换产物文件缺失')
			}
			if (mobiSha && mobiSha !== volume.sourceSha256) problems.push('MOBI 文件与登记哈希不一致')
			if (textSha && textSha !== volume.textSha256) problems.push('正文文本与登记哈希不一致')
			if (problems.length) {
				summary.missing.push(`${series.name} ${volume.volume}：${problems.join('；')}`)
				onVolume?.({ series: series.name, volume: volume.volume, status: 'invalid', problems })
				continue
			}
			const convertedAt = (await stat(textPath)).mtime.toISOString()
			upsertNovel.run({
				source_sha256: volume.sourceSha256,
				series_key: series.key,
				series: series.name,
				volume: volume.volume,
				volume_order: volume.order ?? 0,
				title: volume.title,
				filename: volume.sourceName,
				characters: manifest.characters ?? volume.characters ?? 0,
				bytes: manifest.sourceBytes ?? volume.bytes ?? 0,
				text_path: path.join(directory, 'text.txt'),
				text_sha256: volume.textSha256,
				toc_entries: (manifest.tableOfContents ?? []).length,
				converted_at: convertedAt,
				registered_at: registeredAt,
			})
			hashes.push(volume.textSha256)
			summary.verified += 1
			onVolume?.({ series: series.name, volume: volume.volume, status: 'ok', characters: volume.characters })
		}

		const expected = (series.volumes ?? []).length
		if (!hashes.length || hashes.length !== expected) continue
		const combinedSha256 = createHash('sha256').update(hashes.join('\n'), 'utf8').digest('hex')
		let specText = ''
		try {
			specText = (await readFile(path.join(root, series.spec.path), 'utf8')).trim()
		} catch {
			summary.missing.push(`${series.name}：缺少写作规格文件 ${series.spec.path}`)
			continue
		}
		const specSha256 = sha256Of(Buffer.from(`${combinedSha256}\u0000${specText}`, 'utf8'))
		const methods = [...specText.matchAll(/^### \d+\.\s*(.+)$/gm)].map((match) => match[1].trim())
		database
			.prepare(
				`INSERT INTO reference_spec(spec_sha256, series_key, combined_sha256, spec_text, methods_json, origin, source_path, generated_at)
				 VALUES (@spec_sha256, @series_key, @combined_sha256, @spec_text, @methods_json, @origin, @source_path, @generated_at)
				 ON CONFLICT(spec_sha256) DO UPDATE SET spec_text = excluded.spec_text, methods_json = excluded.methods_json, generated_at = excluded.generated_at`,
			)
			.run({
				spec_sha256: specSha256,
				series_key: series.key,
				combined_sha256: combinedSha256,
				spec_text: specText,
				methods_json: JSON.stringify(methods),
				origin: series.spec.origin === 'manual' ? 'manual' : series.spec.origin === 'trial' ? 'trial' : 'model',
				source_path: series.spec.path,
				generated_at: registeredAt,
			})
		summary.specs.push({ seriesKey: series.key, combinedSha256, specSha256, methods })
	}

	database
		.prepare(
			`INSERT INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES ('references', ?, ?, ?, ?)
			 ON CONFLICT(kind) DO UPDATE SET sha256 = excluded.sha256, rows = excluded.rows, built_at = excluded.built_at, notes = excluded.notes`,
		)
		.run(catalogSha256, summary.verified, registeredAt, JSON.stringify({ missing: summary.missing }))
	return summary
}
