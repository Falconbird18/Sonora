import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the viewer's actual gesture handlers with a deterministic animation clock.
const component = fs.readFileSync(
	new URL('../src/lib/ScoreViewer.svelte', import.meta.url),
	'utf8'
);
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const source = ts.createSourceFile(
	'viewer.ts',
	script,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS
);
const names = new Set([
	'flushPan',
	'cancelPanGesture',
	'onWorkspaceDragStart',
	'onWindowMouseUp',
	'cancelViewGesture',
	'cancelActiveStroke',
	'touchDistance',
	'touchMidpoint',
	'onPinchTouchStart',
	'onPinchTouchMove',
	'onPinchTouchEnd',
	'applyTouchPinch',
	'setZoom',
	'cancelZoomAnimation',
	'animateZoom',
	'onWheel',
	'stopPanMomentum',
	'startPanMomentum',
	'onWorkspacePointerDown',
	'onWorkspacePointerMove',
	'onWorkspacePointerUp'
]);
const handlers = source.statements
	.filter((n) => ts.isFunctionDeclaration(n) && names.has(n.name.text))
	.map((n) => n.getText(source))
	.join('\n');
const frames = new Map();
let frameId = 0;
let now = 0;
const workspace = {
	clientWidth: 1000,
	clientHeight: 800,
	getBoundingClientRect: () => ({ left: 0, top: 0 }),
	setPointerCapture() {},
	releasePointerCapture() {}
};
const context = vm.createContext({
	performance: { now: () => now },
	requestAnimationFrame: (fn) => {
		frames.set(++frameId, fn);
		return frameId;
	},
	cancelAnimationFrame: (id) => frames.delete(id),
	setTimeout: () => 1,
	clearTimeout() {},
	persistPrefs() {},
	commitZoomRender() {},
	workspace,
	host: workspace,
	zoom: 1,
	zoomPending: null,
	zoomRaf: 0,
	zoomFrameTime: 0,
	prefetchTimer: undefined,
	zoomFocusX: 0,
	zoomFocusY: 0,
	zoomTimer: undefined,
	visualScale: 1,
	panX: 0,
	panY: 0,
	panVx: 0,
	panVy: 0,
	panMomentumRaf: 0,
	panDrag: null,
	panCapture: null,
	panRaf: 0,
	pendingPanX: 0,
	pendingPanY: 0,
	panMoved: false,
	panStartX: 0,
	panStartY: 0,
	annotating: false,
	textEditor: null,
	pinch: null,
	pinchRaf: 0,
	resumeTouchPan: false,
	drawing: null,
	draggingAnnot: null,
	isDrawing: false,
	strokes: {},
	cancelHandwriting() {},
	restoreTransform() {},
	redraw() {},
	reading: true,
	$settings: { reduceMotion: false }
});
vm.runInContext(
	ts.transpile(handlers, { target: ts.ScriptTarget.ES2022 }),
	context
);
function frame() {
	now += 16;
	const pending = [...frames.values()];
	frames.clear();
	pending.forEach((fn) => fn(now));
}
const wheel = {
	preventDefault() {},
	ctrlKey: true,
	deltaMode: 0,
	deltaY: -40,
	clientX: 500,
	clientY: 400
};
context.onWheel(wheel);
context.onWheel(wheel);
context.onWheel(wheel);
frame();
assert.ok(
	context.zoom > 1 && context.zoom < Math.exp(120 * 0.0016),
	'coarse wheel steps interpolate over frames'
);
for (let i = 0; i < 30 && context.zoomPending !== null; i++) frame();
assert.ok(
	Math.abs(context.zoom - Math.exp(120 * 0.0016)) < 0.001,
	'wheel input accumulates between frames'
);
assert.ok(
	Math.abs((500 - context.panX) / context.zoom - 500) < 0.001,
	'zoom keeps cursor anchored'
);
const target = { closest: () => null };
const pointer = {
	pointerId: 1,
	pointerType: 'mouse',
	buttons: 1,
	preventDefault() {},
	button: 0,
	clientX: 100,
	clientY: 100,
	target,
	currentTarget: workspace
};
context.onWorkspacePointerDown(pointer);
assert.ok(context.panDrag, 'reading mode permits pan');
now += 16;
context.onWorkspacePointerMove({ ...pointer, clientX: 140, clientY: 120 });
frame();
const beforeRelease = context.panX;
context.onWorkspacePointerUp({ ...pointer, type: 'pointerup' });
frame();
assert.ok(context.panX > beforeRelease, 'release retains momentum velocity');
context.onWheel({ ...wheel, ctrlKey: false, deltaX: 0, deltaY: 10 });
assert.equal(context.panMomentumRaf, 0, 'wheel interrupts momentum');
context.onWorkspacePointerDown(pointer);
now += 16;
context.onWorkspacePointerMove({ ...pointer, clientX: 140 });
context.onWorkspacePointerUp({ ...pointer, type: 'pointercancel' });
assert.equal(context.panMomentumRaf, 0, 'cancelled gestures do not fling');

// A missed mouse-up must not leave the viewer dragging on hover.
context.onWorkspacePointerDown(pointer);
now += 16;
context.onWorkspacePointerMove({ ...pointer, clientX: 160 });
const beforeHover = context.panX;
context.onWorkspacePointerMove({ ...pointer, buttons: 0, clientX: 500 });
assert.equal(context.panDrag, null, 'released button cancels stale pan');
frame();
assert.equal(
	context.panX,
	beforeHover + 60,
	'hover adds no motion after missed release'
);
assert.equal(
	context.panMomentumRaf,
	0,
	'missed release does not start momentum'
);
context.onWorkspacePointerDown(pointer);
context.onWorkspacePointerDown({ ...pointer, clientX: 200 });
assert.equal(
	context.panStartX,
	200,
	'fresh press recovers an interrupted drag'
);
context.cancelPanGesture();
assert.equal(context.panCapture, null, 'blur/cancellation releases capture');
assert.equal(context.panDrag, null, 'blur/cancellation clears dragging cursor');
let preventedDrag = false;
context.onWorkspacePointerDown(pointer);
context.onWorkspaceDragStart({
	preventDefault() {
		preventedDrag = true;
	}
});
assert.ok(preventedDrag, 'native drag ghost is prevented');
assert.equal(context.panDrag, null, 'native drag interruption clears pan');
context.onWorkspacePointerDown(pointer);
const beforeBatch = context.panX;
context.onWorkspacePointerMove({ ...pointer, clientX: 120 });
context.onWorkspacePointerMove({ ...pointer, clientX: 150 });
assert.equal(context.panX, beforeBatch, 'pointer moves wait for display frame');
assert.equal(frames.size, 1, 'rapid moves share a single frame');
frame();
assert.equal(
	context.panX,
	beforeBatch + 50,
	'frame retains every movement delta'
);
context.onWorkspacePointerUp({ ...pointer, type: 'lostpointercapture' });
assert.equal(context.panDrag, null, 'lost capture clears pan');
assert.equal(context.panMomentumRaf, 0, 'lost capture does not fling');
context.onWorkspacePointerDown(pointer);
context.onWindowMouseUp({ button: 0 });
assert.equal(
	context.panDrag,
	null,
	'mouse-up recovers when pointer-up is missing'
);
assert.equal(
	context.panCapture,
	null,
	'fallback mouse-up releases captured element'
);

context.strokes = { 1: [{ id: 'saved' }, { id: 'interrupted' }] };
context.drawing = {
	page: 1,
	stroke: { id: 'interrupted' },
	canvas: workspace,
	pointerId: 1
};
context.isDrawing = true;
context.cancelActiveStroke();
assert.equal(
	context.strokes[1].length,
	1,
	'pinch takeover removes interrupted stroke'
);
assert.equal(
	context.strokes[1][0].id,
	'saved',
	'pinch takeover preserves previous ink'
);
assert.equal(context.isDrawing, false, 'pinch takeover exits drawing mode');
context.zoom = 1;
context.panX = 0;
context.panY = 0;
const touch = (identifier, clientX, clientY = 200) => ({
	identifier,
	clientX,
	clientY
});
const touchEvent = (touches, type = 'touchmove') => ({
	touches,
	type,
	preventDefault() {}
});
context.onWorkspacePointerDown({ ...pointer, pointerType: 'touch' });
assert.ok(context.panDrag, 'single finger pans in reading mode');
context.onPinchTouchStart(
	touchEvent([touch(11, 100), touch(22, 300)], 'touchstart')
);
assert.equal(context.panDrag, null, 'second finger cancels one-finger drag');
context.onPinchTouchMove(
	touchEvent([touch(11, 100, 250), touch(22, 450, 250)])
);
context.onPinchTouchMove(
	touchEvent([touch(22, 500, 250), touch(11, 100, 250)])
);
assert.equal(context.zoom, 1, 'touch updates wait for display frame');
frame();
assert.equal(
	context.zoom,
	2,
	'pinch uses latest distance even if touch order changes'
);
assert.equal(
	(300 - context.panX) / context.zoom,
	200,
	'pinch keeps horizontal anchor'
);
assert.equal(
	(250 - context.panY) / context.zoom,
	200,
	'pinch keeps vertical anchor'
);
context.onPinchTouchMove(touchEvent([touch(11, 100), touch(22, 300)]));
frame();
assert.equal(context.zoom, 1, 'reversing pinch returns to original zoom');
assert.equal(
	context.panX,
	0,
	'repeated pinches do not accumulate horizontal drift'
);
assert.equal(
	context.panY,
	0,
	'repeated pinches do not accumulate vertical drift'
);
context.onPinchTouchMove(touchEvent([touch(11, 100), touch(22, 500)]));
context.onPinchTouchEnd(touchEvent([touch(11, 100)], 'touchend'));
assert.equal(context.zoom, 2, 'lifting finger flushes final pinch frame');
assert.equal(context.pinch, null, 'lifting finger clears pinch');
assert.equal(context.pinchRaf, 0, 'no queued pinch remains after end');
context.onWorkspacePointerMove({
	...pointer,
	pointerType: 'touch',
	clientX: 150
});
assert.ok(context.panDrag, 'remaining finger can resume panning');
assert.equal(
	context.panMoved,
	true,
	'pinch continuation cannot trigger a page turn'
);
context.cancelViewGesture();
context.onPinchTouchStart(
	touchEvent([touch(11, 100), touch(22, 300)], 'touchstart')
);
context.onPinchTouchMove(touchEvent([touch(11, 100), touch(22, 400)]));
context.cancelViewGesture();
assert.equal(context.pinchRaf, 0, 'focus loss cancels queued pinch');
assert.equal(context.pinch, null, 'focus loss clears pinch');
context.$settings.reduceMotion = true;
context.zoom = 1;
context.onWheel(wheel);
frame();
assert.ok(
	Math.abs(context.zoom - Math.exp(40 * 0.0016)) < 1e-8,
	'reduced motion skips zoom easing'
);
context.$settings.reduceMotion = false;
context.onWheel(wheel);
frame();
context.onWorkspacePointerDown(pointer);
assert.equal(context.zoomPending, null, 'starting pan stops zoom easing');
context.cancelViewGesture();
console.log('Viewer gesture regressions passed');

// The new preference must coexist with main's handwriting settings and old saves.
const stores = await import('svelte/store');
const settingsSource = fs.readFileSync(
	new URL('../src/lib/settingsStore.ts', import.meta.url),
	'utf8'
);
function loadSettings(saved) {
	let raw = JSON.stringify(saved);
	const exports = {};
	vm.runInNewContext(
		ts.transpile(settingsSource, {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022
		}),
		{
			exports,
			require: (name) => {
				assert.equal(name, 'svelte/store');
				return stores;
			},
			localStorage: {
				getItem: () => raw,
				setItem: (_key, value) => {
					raw = value;
				}
			}
		}
	);
	return { store: exports.settings, saved: () => JSON.parse(raw) };
}
const preferences = loadSettings({
	handwritingPauseMs: 2750,
	handwritingMode: 'music'
});
assert.equal(
	stores.get(preferences.store).pageShadows,
	true,
	'old saves retain shadows by default'
);
preferences.store.patch({ pageShadows: false });
assert.equal(
	preferences.saved().pageShadows,
	false,
	'shadow preference persists'
);
assert.equal(
	preferences.saved().handwritingPauseMs,
	2750,
	'handwriting pause is preserved'
);
assert.equal(
	preferences.saved().handwritingMode,
	'music',
	'handwriting mode is preserved'
);
assert.equal(
	stores.get(loadSettings(preferences.saved()).store).pageShadows,
	false,
	'disabled shadows survive reload'
);
console.log('Viewer settings persistence regressions passed');
