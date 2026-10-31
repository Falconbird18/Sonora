import assert from 'node:assert/strict';
import { createServer } from 'vite';

for (const component of ['ScoreViewer', 'ui/PracticeTools']) {
	const server = await createServer({
		server: { middlewareMode: true, hmr: false, ws: false },
		appType: 'custom'
	});
	try {
		const client = server.environments.client;
		const cssUrl = `/src/lib/${component}.svelte?svelte&type=style&lang.css`;
		for (const phase of ['cold start', 'invalidated modules']) {
			const css = await client.transformRequest(cssUrl);
			assert.ok(
				css?.code.includes('svelte-'),
				`${component}: ${phase} returns scoped CSS`
			);
			assert.ok(
				!css.code.includes('<script'),
				`${component}: ${phase} never returns component source`
			);
			if (phase === 'cold start') client.moduleGraph.invalidateAll();
		}
	} finally {
		await server.close();
	}
}
console.log(
	'Dev CSS regression passed: CSS-first requests on cold and invalidated components'
);
