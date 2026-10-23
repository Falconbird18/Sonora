import assert from 'node:assert/strict';
import { createServer } from 'vite';
const rows = new Map();
const folderRows = new Map();
let pdfCalls = 0;
globalThis.__folderFixture = {
	scores: {
		where() {
			return {
				equals() {
					return { toArray: async () => [...rows.values()] };
				}
			};
		},
		async bulkPut(items) {
			for (const item of items) rows.set(item.id, item);
		},
		async delete(id) {
			rows.delete(id);
		}
	},
	annotations: {
		where() {
			return {
				equals() {
					return { async delete() {} };
				}
			};
		}
	},
	folders: { async put() {} },
	libraryFolders: { async toArray() { return [...folderRows.values()]; }, async bulkPut(items) { for(const item of items) folderRows.set(item.id,item); }, async bulkDelete(ids) { for(const id of ids) folderRows.delete(id); } },
	lists: {},
	async transaction(...args) {
		return args.at(-1)();
	}
};
globalThis.__pdfFixtureCall = () => pdfCalls++;
const server = await createServer({
	plugins: [
		{
			name: 'folder-fixture',
			enforce: 'pre',
			load(id) {
				if (id.endsWith('/src/lib/db.ts'))
					return 'export const db = globalThis.__folderFixture;';
				if (id.endsWith('/src/lib/pdfUtils.ts'))
					return 'export async function getPdfInfoFromSource() { globalThis.__pdfFixtureCall(); throw Error("PDF rendering must be deferred"); }';
			}
		}
	],
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { syncFolder } = await server.ssrLoadModule('/src/lib/folderSync.ts');
	const files = Array.from(
		{ length: 1000 },
		(_, i) =>
			new File(['%PDF fixture'], `score-${i}.pdf`, {
				type: 'application/pdf',
				lastModified: 100
			})
	);
	const handle = {
		async queryPermission() {
			return 'granted';
		},
		async *entries() {
			for (const file of files)
				yield [
					file.name,
					{
						kind: 'file',
						async getFile() {
							return file;
						}
					}
				];
		}
	};
	const folder = { id: 'library-root', name: 'Fixture', addedAt: 1, handle };
	assert.deepEqual(await syncFolder(folder), {
		added: 1000,
		updated: 0,
		removed: 0
	});
	assert.equal(pdfCalls, 0);
	assert.equal(rows.size, 1000);
	assert.ok(
		[...rows.values()].every((row) => row.pdfBlob?.size && !row.thumbnailUrl)
	);
	assert.deepEqual(await syncFolder(folder), {
		added: 0,
		updated: 0,
		removed: 0
	});
	// A changed file invalidates the old preview; unchanged files keep theirs.
	const first = rows.get('library-root:score-0.pdf');
	first.thumbnailUrl = 'data:image/png;base64,old';
	first.totalPages = 20;
	files[0] = new File(['%PDF replacement larger'], 'score-0.pdf', {
		type: 'application/pdf',
		lastModified: 200
	});
	assert.deepEqual(await syncFolder(folder), {
		added: 0,
		updated: 1,
		removed: 0
	});
	assert.equal(rows.get(first.id).thumbnailUrl, undefined);
	assert.equal(rows.get(first.id).totalPages, 1);
	assert.equal(pdfCalls, 0);
	console.log(
		'Browser folder checks passed: 1,000 rows publish without PDF rendering, unchanged scans skip writes, changed files invalidate previews.'
	);
} finally {
	await server.close();
	delete globalThis.__folderFixture;
	delete globalThis.__pdfFixtureCall;
}
