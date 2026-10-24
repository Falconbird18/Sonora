<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		Trash2,
		Check,
		X,
		Files,
		House,
		Pencil,
		ChevronRight,
		Clock3,
		Plus,
		ListMusic,
		Share2,
		FolderOpen,
		FolderPlus,
		Globe,
		Grid2X2,
		List,
		Music2,
		RefreshCw,
		Settings,
		Star
	} from '@lucide/svelte';
	import LibrarySelection from './ui/LibrarySelection.svelte';
	import LibraryFolderItem from './ui/LibraryFolderItem.svelte';
	import FolderOrganizeDialog from './ui/FolderOrganizeDialog.svelte';
	import {
		createDiskFolder,
		moveDiskEntry,
		deleteDiskFolder
	} from './libraryFolders';
	import {
		foldersFromPaths,
		parentPath,
		diskFolderId,
		validateFolderName
	} from './libraryFolderPaths';
	import SearchField from './ui/SearchField.svelte';
	import Notice from './ui/Notice.svelte';
	import ListEditor from './ui/ListEditor.svelte';
	import AppSelect from './ui/AppSelect.svelte';
	import { createList } from './lists';

	import { createLibraryQuery } from './libraryQuery';
	import { repairMetadata, createRepairContext } from './works';
	import { formatComposer } from './composerDisplay';
	import ScoreCard from './ui/ScoreCard.svelte';
	import ScoreListItem from './ui/ScoreListItem.svelte';
	import MetadataDialog from './ui/MetadataDialog.svelte';
	import ScoreImportDialog from './ui/ScoreImportDialog.svelte';
	let importOpen = $state(false);
	import ComposerPortrait from './ui/ComposerPortrait.svelte';
	import IconButton from './ui/IconButton.svelte';
	import SettingsPanel from './ui/SettingsPanel.svelte';
	import ImslpSearchPanel from './ui/ImslpSearchPanel.svelte';
	import { maybeOrganizeScoreFile, saveScoreMetadata } from './scoreMeta';
	import { settings } from './settingsStore';
	import { db } from './db';
	import {
		chooseAndAddFolder,
		resolveScoreSource,
		syncFolder,
		syncAllFolders
	} from './folderSync';
	import {
		checkForUpdate,
		shouldShowUpdateBanner,
		dismissUpdate,
		type UpdateInfo
	} from './updateChecker';
	import { refreshComposersFromRemote } from './composerDatabase';
	import {
		getComposerPortrait,
		hydratePortraitCache
	} from './composerPortraits';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { isTauri } from './paths';
	import type {
		LibraryFolder,
		FolderSource,
		ScoreItem,
		ScoreMetadataUpdate,
		ScoreList
	} from './types';

	const THUMBNAIL_VERSION = 2;
	let {
		onSelectScore,
		paused = false
	}: {
		onSelectScore: (
			score: ScoreItem,
			context?: { listId: string; entryId: string }
		) => void;
		paused?: boolean;
	} = $props();
	let scores = $state.raw<ScoreItem[]>([]),
		folder = $state<FolderSource | undefined>(),
		search = $state('');
	let filter = $state<'all' | 'favorites' | 'recent'>('all'),
		composer = $state<string | null>(null),
		sort = $state<'recent' | 'title' | 'composer'>('recent');
	let view = $state<'grid' | 'list'>('grid'),
		menuScoreId = $state<string | null>(null),
		metadata = $state<ScoreItem | null>(null);
	let syncPending = false;
	let syncing = $state(false),
		notice = $state(''),
		error = $state('');
	let openingId = $state<string | null>(null),
		timer: ReturnType<typeof setInterval> | undefined,
		backfillRunning = false;
	let settingsOpen = $state(false);
	let settingsSection = $state<'sharing' | null>(null);
	let imslpOpen = $state(false);
	let libraryMode = $state<'all' | 'folders'>('folders');
	let selectedFolderId = $state<string | null>(null);
	let draggedEntries = $state<{ path: string; directory: boolean }[]>([]);
	let dropTarget = $state<string | null>(null);
	let pointerDrag = $state<{
		id: string;
		directory: boolean;
		x: number;
		y: number;
		active: boolean;
	} | null>(null);
	let pointerPosition = $state({ x: 0, y: 0 });
	let pointerSource: HTMLElement | null = null;
	let libraryFolders = $state<LibraryFolder[]>([]);
	let selectedScores = $state<string[]>([]);
	let selectedFolders = $state<string[]>([]);
	let organizeDialog = $state<'create' | 'rename' | 'delete' | null>(null);
	let folderBusy = $state(false);
	let folderError = $state('');
	const selectionCount = $derived(
		selectedScores.length + selectedFolders.length
	);
	const folderById = $derived(new Map(libraryFolders.map((f) => [f.id, f])));
	const childFolders = $derived(
		libraryFolders
			.filter((f) => f.parentId === (selectedFolderId ?? ''))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
	const folderCounts = $derived.by(() => {
		const counts = new Map<string, { scores: number; folders: number }>();
		const entry = (id: string) => {
			let value = counts.get(id);
			if (!value) {
				value = { scores: 0, folders: 0 };
				counts.set(id, value);
			}
			return value;
		};
		for (const score of scores)
			entry(diskFolderId(parentPath(score.sourcePath ?? ''))).scores++;
		for (const f of libraryFolders) entry(f.parentId).folders++;
		return counts;
	});
	const breadcrumbs = $derived.by(() => {
		const path = folderById.get(selectedFolderId ?? '')?.sourcePath ?? '';
		let current = '';
		return path
			.split('/')
			.filter(Boolean)
			.map((name) => {
				current = current ? `${current}/${name}` : name;
				return { name, id: diskFolderId(current) };
			});
	});
	const destinationFolders = $derived(
		libraryFolders
			.filter(
				(f) =>
					!selectedFolders.some(
						(id) =>
							f.id === id ||
							f.sourcePath?.startsWith(`${folderById.get(id)?.sourcePath}/`)
					)
			)
			.map((f) => ({ id: f.id, path: f.sourcePath ?? f.name }))
	);

	function clearSelection() {
		selectedScores = [];
		selectedFolders = [];
	}
	function toggleScore(id: string) {
		selectedScores = selectedScores.includes(id)
			? selectedScores.filter((value) => value !== id)
			: [...selectedScores, id];
	}
	function toggleFolder(id: string) {
		selectedFolders = selectedFolders.includes(id)
			? selectedFolders.filter((value) => value !== id)
			: [...selectedFolders, id];
	}
	function navigateFolder(id: string | null) {
		libraryMode = 'folders';
		selectedFolderId = id;
		selectedListId = null;
		search = '';
		composer = null;
		filter = 'all';
		clearSelection();
	}
	function showOrganize(mode: 'create' | 'rename' | 'delete') {
		folderError = '';
		organizeDialog = mode;
	}
	$effect(() => {
		selectedFolderId;
		libraryMode;
		filter;
		composer;
		selectedListId;
		untrack(clearSelection);
	});
	function showLibrary(mode: 'all' | 'folders') {
		navigateFolder(null);
		libraryMode = mode;
	}
	function prepareDrag(id: string, directory: boolean) {
		if (folderBusy || organizing || !folder?.nativePath || !isTauri()) {
			return false;
		}
		const folderIds = directory
			? selectedFolders.includes(id)
				? selectedFolders
				: [id]
			: selectedScores.includes(id)
				? selectedFolders
				: [];
		const scoreIds = directory
			? selectedFolders.includes(id)
				? selectedScores
				: []
			: selectedScores.includes(id)
				? selectedScores
				: [id];
		const paths = folderIds
			.map((value) => folderById.get(value)?.sourcePath)
			.filter((value): value is string => !!value);
		draggedEntries = [
			...paths
				.filter(
					(path) =>
						!paths.some(
							(other) => other !== path && path.startsWith(`${other}/`)
						)
				)
				.map((path) => ({ path, directory: true })),
			...scores
				.filter(
					(score) =>
						scoreIds.includes(score.id) &&
						score.sourcePath &&
						score.sourceFolderId === folder?.id &&
						!paths.some((path) => score.sourcePath!.startsWith(`${path}/`))
				)
				.map((score) => ({ path: score.sourcePath!, directory: false }))
		];
		if (!draggedEntries.length) {
			return false;
		}
		return true;
	}
	function startDrag(event: DragEvent, id: string, directory: boolean) {
		if (!prepareDrag(id, directory)) {
			event.preventDefault();
			return;
		}
		event.dataTransfer?.setData('application/x-sonora-library-items', 'move');
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}
	function pointerDown(event: PointerEvent, id: string, directory: boolean) {
		if (
			event.button !== 0 ||
			event.pointerType === 'touch' ||
			folderBusy ||
			!folder?.nativePath ||
			!isTauri()
		)
			return;
		if (
			(event.target as HTMLElement).closest(
				'.selection, .card-actions, .list-actions'
			)
		)
			return;
		pointerDrag = {
			id,
			directory,
			x: event.clientX,
			y: event.clientY,
			active: false
		};
		pointerSource = event.currentTarget as HTMLElement;
	}
	function pointerMove(event: PointerEvent) {
		if (!pointerDrag) return;
		if (!pointerDrag.active) {
			if (
				Math.hypot(
					event.clientX - pointerDrag.x,
					event.clientY - pointerDrag.y
				) < 6
			)
				return;
			if (!prepareDrag(pointerDrag.id, pointerDrag.directory)) {
				pointerDrag = null;
				return;
			}
			pointerDrag.active = true;
			pointerSource?.setPointerCapture(event.pointerId);
		}
		event.preventDefault();
		pointerPosition = { x: event.clientX + 16, y: event.clientY + 14 };
		const hit = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>('[data-folder-drop]');
		const id = hit?.getAttribute('data-folder-drop');
		dropTarget = id !== null && id !== undefined && acceptsDrop(id) ? id : null;
	}
	function pointerUp(event: PointerEvent) {
		const active = pointerDrag?.active;
		pointerDrag = null;
		if (pointerSource?.hasPointerCapture(event.pointerId))
			pointerSource.releasePointerCapture(event.pointerId);
		pointerSource = null;
		if (!active) return;
		// Suppress the click generated by releasing a dragged folder on its destination.
		const blockClick = (click: MouseEvent) => {
			click.preventDefault();
			click.stopImmediatePropagation();
		};
		document.addEventListener('click', blockClick, {
			capture: true,
			once: true
		});
		setTimeout(
			() => document.removeEventListener('click', blockClick, true),
			250
		);
		const target = dropTarget;
		if (target !== null) void dropEntries(event, target);
		else endDrag();
	}
	function cancelPointerDrag() {
		pointerDrag = null;
		pointerSource = null;
		endDrag();
	}

	function endDrag() {
		draggedEntries = [];
		dropTarget = null;
	}
	function acceptsDrop(id: string) {
		if (!draggedEntries.length || folderBusy || organizing) return false;
		const target = folderById.get(id)?.sourcePath ?? '';
		return (
			!draggedEntries.some(
				(entry) =>
					entry.directory &&
					(target === entry.path || target.startsWith(`${entry.path}/`))
			) && draggedEntries.some((entry) => parentPath(entry.path) !== target)
		);
	}
	function dragOver(event: DragEvent, id: string) {
		if (!acceptsDrop(id)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dropTarget = id;
	}
	async function dropEntries(event: DragEvent | PointerEvent, id: string) {
		if (!acceptsDrop(id) || !folder) return;
		event.preventDefault();
		event.stopPropagation();
		const entries = [...draggedEntries];
		const target = folderById.get(id)?.sourcePath ?? '';
		endDrag();
		folderBusy = true;
		error = '';
		try {
			// A focus-triggered scan may still be finishing when the user starts dragging.
			const waitStarted = Date.now();
			while (syncing) {
				if (Date.now() - waitStarted > 30_000)
					throw Error(
						'The library is still refreshing. Try the move again in a moment.'
					);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			for (const entry of entries)
				await moveDiskEntry(
					folder,
					entry.path,
					[target, entry.path.split('/').at(-1)!].filter(Boolean).join('/'),
					entry.directory
				);
			await syncFolder(folder);
			await refresh();
			clearSelection();
			notice = `Moved ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			try {
				await syncFolder(folder);
				await refresh();
			} catch {
				/* keep original error */
			}
		} finally {
			folderBusy = false;
		}
	}

	async function submitOrganization(
		parentId: string,
		name: string,
		moveSelected: boolean
	) {
		if (!folder) {
			folderError = 'Connect a score folder before organizing files.';
			return;
		}
		folderBusy = true;
		folderError = '';
		try {
			const parent = folderById.get(parentId)?.sourcePath ?? '';
			const folders = selectedFolders
				.map((id) => folderById.get(id)!)
				.filter(Boolean);
			const selectedPaths = folders.map((f) => f.sourcePath!);
			const entries = [
				...folders
					.filter(
						(f) =>
							!selectedPaths.some(
								(path) =>
									path !== f.sourcePath && f.sourcePath!.startsWith(`${path}/`)
							)
					)
					.map((f) => ({ path: f.sourcePath!, directory: true })),
				...scores
					.filter(
						(score) =>
							organizeDialog !== 'delete' &&
							selectedScores.includes(score.id) &&
							!selectedPaths.some((path) =>
								score.sourcePath?.startsWith(`${path}/`)
							)
					)
					.map((score) => {
						if (!score.sourcePath || score.sourceFolderId !== folder!.id)
							throw Error(
								'This score must be imported into the connected folder before moving it.'
							);
						return { path: score.sourcePath, directory: false };
					})
			];
			if (organizeDialog === 'delete') {
				for (const entry of entries.filter((entry) => entry.directory))
					await deleteDiskFolder(folder, entry.path);
			} else if (organizeDialog === 'rename') {
				const source = folders[0]?.sourcePath;
				if (!source) throw Error('Select one folder to rename.');
				const target = [parentPath(source), validateFolderName(name)]
					.filter(Boolean)
					.join('/');
				await moveDiskEntry(folder, source, target, true);
			} else {
				let targetParent = parent;
				if (organizeDialog === 'create') {
					const proposed = [parent, validateFolderName(name)]
						.filter(Boolean)
						.join('/');
					if (
						moveSelected &&
						entries.some(
							(entry) =>
								entry.directory && proposed.startsWith(`${entry.path}/`)
						)
					)
						throw Error('Choose a location outside the selected folder.');
					targetParent = await createDiskFolder(folder, parent, name);
				}
				if (moveSelected)
					for (const entry of entries) {
						const destination = [targetParent, entry.path.split('/').at(-1)!]
							.filter(Boolean)
							.join('/');
						await moveDiskEntry(
							folder,
							entry.path,
							destination,
							entry.directory
						);
					}
			}
			await syncFolder(folder);
			await refresh();
			clearSelection();
			if (organizeDialog === 'create') navigateFolder(parentId || null);
			organizeDialog = null;
			notice = 'Folder updated';
		} catch (e) {
			folderError = e instanceof Error ? e.message : String(e);
			// A batch can stop after an earlier item moved; always show the actual disk state.
			try {
				await syncFolder(folder);
				await refresh();
			} catch {
				/* retain the actionable original error */
			}
		} finally {
			folderBusy = false;
		}
	}
	let lists = $state<ScoreList[]>([]);
	let selectedListId = $state<string | null>(null);
	const selectedList = $derived(
		lists.find((list) => list.id === selectedListId)
	);
	async function newList() {
		try {
			const list = await createList('Untitled program');
			await refresh();
			selectedListId = list.id;
			selectedFolderId = null;
		} catch (e) {
			error = String(e);
		}
	}

	let organizing = $state(false);
	let organizationStatus = $state('');
	async function organizeExistingFiles() {
		if (organizing || syncing) return;
		organizing = true;
		organizationStatus = 'Organizing…';
		let moved = 0;
		try {
			for (const score of scores) {
				await maybeOrganizeScoreFile(score, score, true);
				moved++;
			}
			organizationStatus = `Organized ${moved} scores. Annotations and metadata preserved.`;
		} catch (e) {
			organizationStatus = `${moved} scores organized. ${String(e)}`;
		} finally {
			await refresh();
			organizing = false;
		}
	}

	let updateInfo = $state<UpdateInfo | null>(null);
	let updateBannerVisible = $state(false);

	async function refresh() {
		const [nextScores, nextFolder] = await Promise.all([
			db.scores.orderBy('addedAt').reverse().toArray(),
			db.folders.get('library-root')
		]);
		const repairContext = createRepairContext(nextScores);
		const repaired: Array<{ key: string; changes: Partial<ScoreItem> }> = [];
		for (const score of nextScores) {
			const patch = repairMetadata(score, nextScores, repairContext);
			if (Object.keys(patch).length) {
				Object.assign(score, patch);
				repaired.push({ key: score.id, changes: patch });
			}
		}
		if (repaired.length) await db.scores.bulkUpdate(repaired);
		lists = await db.lists.orderBy('updatedAt').reverse().toArray();
		const cachedFolders = await db.libraryFolders.toArray();
		libraryFolders = foldersFromPaths([
			...cachedFolders.map((f) => f.sourcePath ?? ''),
			...nextScores.map((score) => parentPath(score.sourcePath ?? ''))
		]);
		scores = nextScores;
		folder = nextFolder;
	}
	async function sync() {
		if (paused || organizing || folderBusy || draggedEntries.length) return;
		if (syncing) {
			syncPending = true;
			return;
		}
		syncing = true;
		error = '';
		try {
			const results = await syncAllFolders(true);
			const result = results[0];
			notice = result
				? 'skipped' in result && result.skipped
					? 'Library is up to date'
					: result.added || result.updated || result.removed
						? `${result.added + result.updated} updated · ${result.removed} removed`
						: 'Library is up to date'
				: 'Choose a score folder to begin';
			await refresh();
			void backfillThumbnails();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not sync the library';
		} finally {
			syncing = false;
			setTimeout(() => (notice = ''), 3000);
			if (syncPending) {
				syncPending = false;
				void sync();
			}
		}
	}
	async function chooseFolder() {
		error = '';
		try {
			await chooseAndAddFolder();
			await refresh();
			void backfillThumbnails();
		} catch (e) {
			if ((e as DOMException)?.name !== 'AbortError')
				error =
					e instanceof Error ? e.message : 'Could not choose the score folder';
		}
	}
	function prepareScore(score: ScoreItem): ScoreItem {
		const source = resolveScoreSource(score, folder);
		return {
			...score,
			thumbnailUrl: thumbnailPreviews[score.id] || score.thumbnailUrl,
			pdfUrl: source.url || score.pdfUrl,
			nativePath: source.nativePath || score.nativePath,
			pdfBlob: source.blob || score.pdfBlob
		};
	}
	async function openScore(
		score: ScoreItem,
		context?: { listId: string; entryId: string }
	) {
		closeMenu();
		error = '';
		openingId = score.id;
		try {
			const prepared = prepareScore(score);
			if (
				!prepared.pdfUrl &&
				!prepared.nativePath &&
				!(prepared.pdfBlob && prepared.pdfBlob.size > 0)
			)
				throw new Error(
					`“${score.title}” has no PDF source. Try refreshing the library.`
				);
			const openedAt = Date.now();
			void db.scores
				.update(score.id, { lastOpenedAt: openedAt })
				.catch((err) => console.warn('Could not update last opened', err));
			scores = scores.map((item) =>
				item.id === score.id ? { ...item, lastOpenedAt: openedAt } : item
			);
			onSelectScore({ ...prepared, lastOpenedAt: openedAt }, context);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not open this score';
		} finally {
			openingId = null;
		}
	}
	async function toggleFavorite(score: ScoreItem, event: MouseEvent) {
		event.stopPropagation();
		const favorite = !score.favorite;
		await db.scores.update(score.id, { favorite });
		scores = scores.map((item) =>
			item.id === score.id ? { ...item, favorite } : item
		);
		if (favorite) closeMenu();
	}
	function toggleMenu(score: ScoreItem, event: MouseEvent) {
		event.stopPropagation();
		menuScoreId = menuScoreId === score.id ? null : score.id;
	}
	function closeMenu() {
		menuScoreId = null;
	}
	function editMetadata(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		closeMenu();
		metadata = score;
	}

	function downloadScoreFile(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		menuScoreId = null;
		let href = score.pdfUrl || '';
		if (!href && score.pdfBlob) href = URL.createObjectURL(score.pdfBlob);
		if (!href) {
			error = 'No PDF available to download for this score.';
			return;
		}
		const link = document.createElement('a');
		link.href = href;
		link.download = `${score.title || 'score'}.pdf`;
		link.target = '_blank';
		link.rel = 'noopener';
		link.click();
		if (score.pdfBlob && !score.pdfUrl)
			setTimeout(() => URL.revokeObjectURL(href), 1000);
	}

	function printScoreFile(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		menuScoreId = null;
		const href =
			score.pdfUrl || (score.pdfBlob ? URL.createObjectURL(score.pdfBlob) : '');
		if (!href) {
			error = 'No PDF available to print for this score.';
			return;
		}
		const win = window.open(href, '_blank', 'noopener');
		if (win) {
			win.addEventListener('load', () => {
				try {
					win.print();
				} catch {}
			});
		} else {
			const frame = document.createElement('iframe');
			frame.style.display = 'none';
			frame.src = href;
			document.body.appendChild(frame);
			frame.onload = () => {
				try {
					frame.contentWindow?.print();
				} catch {}
				setTimeout(() => frame.remove(), 2000);
			};
		}
		if (score.pdfBlob && !score.pdfUrl)
			setTimeout(() => URL.revokeObjectURL(href), 5000);
	}

	async function saveMetadata(payload: ScoreMetadataUpdate) {
		if (!metadata) return;
		const id = metadata.id;
		try {
			const next = await saveScoreMetadata(id, payload);
			scores = scores.map((item) =>
				item.id === id ? { ...item, ...next } : item
			);
			metadata = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save metadata';
		}
	}
	async function deleteScore(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		closeMenu();
		if (!confirm(`Remove “${score.title}” from Sonora?`)) return;
		try {
			await db.transaction('rw', db.scores, db.annotations, async () => {
				await db.scores.delete(score.id);
				await db.annotations.where('scoreId').equals(score.id).delete();
			});
			scores = scores.filter((item) => item.id !== score.id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not remove this score';
		}
	}
	let thumbnailPreviews = $state<Record<string, string>>({});
	const failedThumbnails = new Set<string>();
	let backfillTimer: ReturnType<typeof setTimeout> | undefined;
	let libraryDisposed = false;
	async function backfillThumbnails() {
		if (backfillRunning || paused || libraryDisposed) return;
		backfillRunning = true;
		try {
			const needsThumbnail = (score: ScoreItem) =>
				!failedThumbnails.has(score.id) &&
				(!score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION);
			const visible = visibleEditions;
			const visibleIds = new Set(visible.map((score) => score.id));
			const pageAtStart = currentPage,
				folderAtStart = selectedFolderId;
			const missing = [
				...visible.filter(needsThumbnail),
				...scores.filter(
					(score) => !visibleIds.has(score.id) && needsThumbnail(score)
				)
			];
			const patches = new Map<string, Partial<ScoreItem>>();
			for (const score of missing.slice(0, 8)) {
				if (
					paused ||
					libraryDisposed ||
					pageAtStart !== currentPage ||
					folderAtStart !== selectedFolderId
				)
					break;
				try {
					const source = resolveScoreSource(score, folder);
					if (!source.url && !source.blob && !source.nativePath) {
						failedThumbnails.add(score.id);
						continue;
					}
					const info = await getPdfInfoFromSource(source);
					if (!info.thumbnailUrl) {
						failedThumbnails.add(score.id);
						continue;
					}
					const patch = {
						thumbnailUrl: info.thumbnailUrl,
						thumbnailVersion: THUMBNAIL_VERSION,
						totalPages: info.totalPages || score.totalPages || 1
					};
					await db.scores.update(score.id, patch);
					patches.set(score.id, patch);
					if (visibleIds.has(score.id))
						thumbnailPreviews[score.id] = info.thumbnailUrl;
				} catch (err) {
					failedThumbnails.add(score.id);
					console.warn('Thumbnail backfill failed', score.title, err);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			if (patches.size && !libraryDisposed)
				scores = scores.map((score) =>
					patches.has(score.id) ? { ...score, ...patches.get(score.id) } : score
				);
			for (const id of patches.keys()) delete thumbnailPreviews[id];
			if (
				!paused &&
				!libraryDisposed &&
				scores.some(
					(score) =>
						!failedThumbnails.has(score.id) &&
						(!score.thumbnailUrl ||
							score.thumbnailVersion !== THUMBNAIL_VERSION)
				)
			)
				backfillTimer = setTimeout(() => void backfillThumbnails(), 50);
		} finally {
			backfillRunning = false;
		}
	}
	onMount(() => {
		let disposed = false;
		const initialize = async () => {
			await refresh();
			// Hydrate any previously cached portraits so UI paints immediately offline.
			void hydratePortraitCache();
			void refreshComposersFromRemote().then((result) => {
				if (result.updated) {
					console.info(
						`Composer list updated from ${result.source} (${result.count} entries)`
					);
				}
			});
			void checkForUpdate().then((info) => {
				updateInfo = info;
				updateBannerVisible = shouldShowUpdateBanner(info);
			});
			if (disposed) return;
			const saved = localStorage.getItem('sonora-library-settings');
			if (saved) {
				try {
					const value = JSON.parse(saved);
					view = value.view === 'list' ? 'list' : 'grid';
					sort = ['recent', 'title', 'composer'].includes(value.sort)
						? value.sort
						: 'recent';
				} catch {}
			}
			if (disposed) return;
			await sync();
			if (disposed) return;
			void backfillThumbnails();
			// Library folder sync every 5 min; composer list/portraits every hour.
			timer = setInterval(
				() => {
					void sync();
					void refreshComposersFromRemote();
				},
				5 * 60 * 1000
			);
		};
		void initialize();
		const wake = () => {
			void sync();
			void refreshComposersFromRemote();
		};
		window.addEventListener('focus', wake);
		return () => {
			disposed = true;
			libraryDisposed = true;
			clearTimeout(backfillTimer);
			clearInterval(timer);
			window.removeEventListener('focus', wake);
		};
	});
	$effect(() => {
		localStorage.setItem(
			'sonora-library-settings',
			JSON.stringify({ view, sort })
		);
	});
	$effect(() => {
		visibleEditions;
		if (!paused) untrack(() => void backfillThumbnails());
	});
	const composers = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const score of scores) {
			const name = score.composer || 'Unknown Composer';
			counts[name] = (counts[name] ?? 0) + 1;
		}
		return counts;
	});
	const queryLibrary = $derived(createLibraryQuery(scores));
	const filtered = $derived(queryLibrary({ search, composer, filter, sort }));
	$effect(() => {
		search;
		selectedListId = null;
	});
	const selectedFolder = $derived(
		selectedFolderId ? folderById.get(selectedFolderId) : undefined
	);
	const editions = $derived(
		filtered.filter((score) =>
			libraryMode === 'all' || search || composer || filter !== 'all'
				? true
				: diskFolderId(parentPath(score.sourcePath ?? '')) ===
					(selectedFolderId ?? '')
		)
	);
	const displayedFolders = $derived(
		libraryMode === 'all' || search || composer || filter !== 'all'
			? []
			: childFolders
	);
	const PAGE_SIZE = 60;
	let libraryPage = $state(0);
	const pageCount = $derived(
		Math.max(
			1,
			Math.ceil((editions.length + displayedFolders.length) / PAGE_SIZE)
		)
	);
	const currentPage = $derived(Math.min(libraryPage, pageCount - 1));
	const visibleFolders = $derived(
		displayedFolders.slice(
			currentPage * PAGE_SIZE,
			(currentPage + 1) * PAGE_SIZE
		)
	);
	const visibleEditions = $derived(
		editions.slice(
			Math.max(0, currentPage * PAGE_SIZE - displayedFolders.length),
			Math.max(0, (currentPage + 1) * PAGE_SIZE - displayedFolders.length)
		)
	);
	$effect(() => {
		search;
		composer;
		filter;
		sort;
		selectedFolderId;
		libraryMode;
		libraryPage = 0;
	});
	const currentTitle = $derived(
		search
			? 'Search results'
			: selectedList
				? selectedList.name
				: selectedFolder
					? selectedFolder.name
					: composer
						? formatComposer(composer, $settings.composerDisplay)
						: filter === 'favorites'
							? 'Favorites'
							: filter === 'recent'
								? 'Recently opened'
								: libraryMode === 'all'
									? 'All Scores'
									: 'Folders'
	);
</script>

<svelte:window
	onpointermove={pointerMove}
	onpointerup={pointerUp}
	onpointercancel={cancelPointerDrag}
	onblur={cancelPointerDrag}
	onclick={() => closeMenu()}
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			if (pointerDrag?.active) {
				cancelPointerDrag();
				return;
			}
			closeMenu();
			if (organizeDialog) {
				if (!folderBusy) organizeDialog = null;
				return;
			}
			if (selectionCount) {
				clearSelection();
				return;
			}
			if (metadata) metadata = null;
			if (imslpOpen) imslpOpen = false;
			else if (selectedFolderId) selectedFolderId = null;
			else if (settingsOpen) settingsOpen = false;
		}
	}} />

<div class="library" class:compact={$settings.compactLibrary}>
	<header class="header">
		<div class="brand">
			<span class="brand-mark" aria-hidden="true"><Music2 size={24} /></span>
			<strong>Sonora</strong>
		</div>
		<SearchField
			bind:value={search}
			placeholder="Search your scores"
			ariaLabel="Search scores" />
		<div class="header-actions">
			<button class="folder-button" onclick={() => (importOpen = true)}>
				<FolderPlus size={17} strokeWidth={2} />
				<span>Import scores</span>
			</button>
			<IconButton
				title="Refresh library"
				ariaLabel="Refresh library"
				onclick={sync}>
				<RefreshCw size={18} class={syncing ? 'spinning' : ''} />
			</IconButton>
			<IconButton
				title="Search IMSLP"
				ariaLabel="Search IMSLP for scores"
				onclick={() => (imslpOpen = true)}>
				<Globe size={18} />
			</IconButton>
			<IconButton
				title="Share library"
				ariaLabel="Share or import library"
				onclick={() => {
					settingsSection = 'sharing';
					settingsOpen = true;
				}}><Share2 size={18} /></IconButton>
			<IconButton
				title="Settings"
				ariaLabel="Open settings"
				onclick={() => {
					settingsSection = null;
					settingsOpen = true;
				}}>
				<Settings size={18} />
			</IconButton>
		</div>
	</header>

	{#if error}
		<Notice variant="error" dismissible ondismiss={() => (error = '')}
			>{error}</Notice>
	{/if}
	{#if notice}
		<Notice variant="success">{notice}</Notice>
	{/if}

	{#if updateBannerVisible && updateInfo}
		<Notice
			variant="info"
			dismissible
			ondismiss={() => {
				if (updateInfo?.tagName) dismissUpdate(updateInfo.tagName);
				updateBannerVisible = false;
			}}>
			<span>
				Sonora {updateInfo.latestVersion} is available (you have {updateInfo.currentVersion}).
				<a
					href={updateInfo.htmlUrl ||
						'https://github.com/Falconbird18/Sonora/releases'}
					target="_blank"
					rel="noopener noreferrer"
					style="color: var(--sonora-accent); font-weight: 600;">
					View release
				</a>
			</span>
		</Notice>
	{/if}

	<div class="body">
		<aside class="sidebar">
			<nav aria-label="Library filters">
				<button
					class:active={!selectedList &&
						filter === 'all' &&
						!composer &&
						libraryMode === 'all'}
					onclick={() => showLibrary('all')}
					><Files size={16} /><span>All Scores</span><b>{scores.length}</b
					></button>
				<button
					class:active={!selectedList &&
						filter === 'all' &&
						!composer &&
						libraryMode === 'folders'}
					class:drop-target={dropTarget === ''}
					data-folder-drop=""
					ondragover={(event) => dragOver(event, '')}
					ondragleave={() => (dropTarget = null)}
					ondrop={(event) => void dropEntries(event, '')}
					onclick={() => showLibrary('folders')}
					><FolderOpen size={16} /><span>Folders</span><b
						>{libraryFolders.length}</b
					></button>
				<button
					class:active={!selectedList && filter === 'recent'}
					onclick={() => {
						selectedFolderId = null;
						selectedListId = null;
						filter = 'recent';
						composer = null;
					}}><Clock3 size={16} /><span>Recently opened</span></button>
				<button
					class:active={!selectedList && filter === 'favorites'}
					onclick={() => {
						selectedFolderId = null;
						selectedListId = null;
						filter = 'favorites';
						composer = null;
					}}><Star size={16} /><span>Favorites</span></button>
			</nav>
			<section class="list-section">
				<div class="list-heading">
					<h2>Lists</h2>
					<IconButton
						title="Create list"
						ariaLabel="Create list"
						size="sm"
						onclick={() => void newList()}><Plus size={16} /></IconButton>
				</div>
				{#each lists as list (list.id)}<button
						class:active={selectedListId === list.id}
						onclick={() => {
							selectedListId = list.id;
							selectedFolderId = null;
						}}
						><ListMusic size={16} /><span>{list.name}</span><b
							>{list.entries.length}</b
						></button
					>{/each}
				{#if !lists.length}<button onclick={() => void newList()}
						><Plus size={16} /><span>Create your first list</span></button
					>{/if}
			</section>

			{#if folder}
				<div class="folder-summary">
					<FolderOpen size={16} />
					<div>
						<strong>{folder.name}</strong>
						<span
							>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span>
					</div>
				</div>
			{/if}
			{#if Object.keys(composers).length}
				<section>
					<h2>Composers</h2>
					{#each Object.entries(composers)
						.sort((a, b) => a[0].localeCompare(b[0]))
						.slice(0, 16) as [name, count]}
						{@const portrait = getComposerPortrait(name)}
						<button
							class:active={!selectedList && composer === name}
							onclick={() => {
								selectedFolderId = null;
								selectedListId = null;
								composer = name;
								filter = 'all';
							}}>
							<ComposerPortrait {name} src={portrait} />
							<span>{formatComposer(name, $settings.composerDisplay)}</span><b
								>{count}</b>
						</button>
					{/each}
				</section>
			{/if}
		</aside>
		<main class="main">
			<div class="toolbar">
				<div>
					{#if selectedFolder}
						<nav class="breadcrumbs" aria-label="Folder path">
							<button
								class:drop-target={dropTarget === ''}
								data-folder-drop=""
								ondragover={(event) => dragOver(event, '')}
								ondragleave={() => (dropTarget = null)}
								ondrop={(event) => void dropEntries(event, '')}
								onclick={() => navigateFolder(null)}
								><House size={15} /><span>Folders</span></button>
							{#each breadcrumbs as crumb (crumb.id)}<ChevronRight
									size={13} /><button
									aria-current={crumb.id === selectedFolderId
										? 'page'
										: undefined}
									class:drop-target={dropTarget === crumb.id}
									data-folder-drop={crumb.id}
									ondragover={(event) => dragOver(event, crumb.id)}
									ondragleave={() => (dropTarget = null)}
									ondrop={(event) => void dropEntries(event, crumb.id)}
									onclick={() => navigateFolder(crumb.id)}>{crumb.name}</button
								>{/each}
						</nav>
					{/if}
					<h1>{currentTitle}</h1>
					<span
						>{selectedList ? selectedList.entries.length : editions.length} scores{!selectedList &&
						displayedFolders.length
							? ` · ${displayedFolders.length} folders`
							: ''}</span>
				</div>
				<div class="toolbar-actions">
					{#if !selectedList}<button
							class="new-folder-button"
							disabled={!folder || folderBusy || syncing || organizing}
							onclick={() => showOrganize('create')}
							><FolderPlus size={16} /><span>New folder</span></button
						>{/if}
					{#if !selectedList}<AppSelect
							bind:value={sort}
							label="Sort scores"
							options={[
								{ value: 'recent', label: 'Recently used' },
								{ value: 'title', label: 'Title' },
								{ value: 'composer', label: 'Composer' }
							]} />{/if}
					<div class="seg">
						<button
							class:active={view === 'grid'}
							onclick={() => (view = 'grid')}
							aria-label="Grid view"><Grid2X2 size={16} /></button>
						<button
							class:active={view === 'list'}
							onclick={() => (view = 'list')}
							aria-label="List view"><List size={16} /></button>
					</div>
				</div>
			</div>
			{#if !selectedList && selectionCount}
				<div
					class="selection-toolbar"
					role="toolbar"
					aria-label="Selection actions">
					<span class="selection-count"
						><span class="selection-dot"><Check size={13} /></span
						>{selectionCount} selected</span>

					{#if selectedFolders.length === 1 && !selectedScores.length}<button
							onclick={() => showOrganize('rename')}
							><Pencil size={15} />Rename</button
						>{/if}
					{#if selectedFolders.length}<button
							class="delete-folders"
							disabled={folderBusy || syncing}
							onclick={() => showOrganize('delete')}
							><Trash2 size={15} />Delete {selectedFolders.length === 1
								? 'folder'
								: 'folders'}</button
						>{/if}
					<button
						class="select-all"
						onclick={() => {
							selectedScores = editions.map((s) => s.id);
							selectedFolders = displayedFolders.map((f) => f.id);
						}}>Select all</button>
					<button
						class="clear-selection"
						aria-label="Clear selection"
						onclick={clearSelection}><X size={17} /></button>
				</div>
			{/if}

			{#if selectedList}
				<ListEditor
					list={selectedList}
					{scores}
					onChanged={refresh}
					onDeleted={() => (selectedListId = null)}
					onOpen={(score, entryId) =>
						void openScore(score, { listId: selectedList.id, entryId })} />
			{:else if !scores.length && !displayedFolders.length}
				<div class="empty">
					<div class="empty-orb" aria-hidden="true"></div>
					<h2>Bring your scores together</h2>
					<p>
						Import individual PDFs, a batch of scores, or connect a synced
						folder.
					</p>
					<button class="folder-button" onclick={() => (importOpen = true)}>
						<FolderPlus size={17} /><span>Import scores</span>
					</button>
				</div>
			{:else if !editions.length && !displayedFolders.length}
				<div class="empty">
					<h2>
						{search || composer || filter !== 'all'
							? 'No scores match'
							: 'No scores in this folder'}
					</h2>
					<p>Move scores here, open a subfolder, or try another search.</p>
				</div>
			{:else}
				<div
					class:score-grid={view === 'grid'}
					class:score-list={view === 'list'}>
					{#each visibleFolders as f (f.id)}
						<LibrarySelection
							label={`Select folder ${f.name}`}
							dropId={f.id}
							onPointerDown={(event) => pointerDown(event, f.id, true)}
							list={view === 'list'}
							selected={selectedFolders.includes(f.id)}
							selecting={!!selectionCount}
							onToggle={() => toggleFolder(f.id)}
							draggable={false}
							onDragStart={(event) => startDrag(event, f.id, true)}
							onDragEnd={endDrag}
							dropActive={dropTarget === f.id}
							onDragOver={(event) => dragOver(event, f.id)}
							onDragLeave={() => (dropTarget = null)}
							onDrop={(event) => void dropEntries(event, f.id)}>
							<LibraryFolderItem
								folder={f}
								draggable={false}
								list={view === 'list'}
								scoreCount={folderCounts.get(f.id)?.scores ?? 0}
								folderCount={folderCounts.get(f.id)?.folders ?? 0}
								onOpen={() =>
									selectionCount ? toggleFolder(f.id) : navigateFolder(f.id)} />
						</LibrarySelection>
					{/each}
					{#each visibleEditions as score (score.id)}
						<LibrarySelection
							label={`Select ${score.title}`}
							onPointerDown={(event) => pointerDown(event, score.id, false)}
							list={view === 'list'}
							selected={selectedScores.includes(score.id)}
							selecting={!!selectionCount}
							onToggle={() => toggleScore(score.id)}
							draggable={!!folder?.nativePath &&
								!!score.sourcePath &&
								!folderBusy}
							onDragStart={(event) => startDrag(event, score.id, false)}
							onDragEnd={endDrag}>
							{#if view === 'list'}<ScoreListItem
									{score}
									previewUrl={thumbnailPreviews[score.id]}
									opening={openingId === score.id}
									menuOpen={menuScoreId === score.id}
									onOpen={(s) =>
										selectionCount ? toggleScore(s.id) : void openScore(s)}
									onToggleFavorite={toggleFavorite}
									onToggleMenu={toggleMenu}
									onEditTags={editMetadata}
									onDownload={downloadScoreFile}
									onPrint={printScoreFile}
									onDelete={deleteScore} />
							{:else}<ScoreCard
									{score}
									previewUrl={thumbnailPreviews[score.id]}
									opening={openingId === score.id}
									menuOpen={menuScoreId === score.id}
									onOpen={(s) =>
										selectionCount ? toggleScore(s.id) : void openScore(s)}
									onToggleFavorite={toggleFavorite}
									onToggleMenu={toggleMenu}
									onEditTags={editMetadata}
									onDownload={downloadScoreFile}
									onPrint={printScoreFile}
									onDelete={deleteScore} />{/if}
						</LibrarySelection>
					{/each}
				</div>
			{/if}
			{#if !selectedList && pageCount > 1}
				<nav class="pagination" aria-label="Library pages">
					<button
						disabled={currentPage === 0}
						onclick={() => (libraryPage = currentPage - 1)}>Previous</button>
					<span aria-live="polite">Page {currentPage + 1} of {pageCount}</span>
					<button
						disabled={currentPage + 1 >= pageCount}
						onclick={() => (libraryPage = currentPage + 1)}>Next</button>
				</nav>
			{/if}
		</main>
	</div>

	{#if pointerDrag?.active}
		<div
			class="drag-preview"
			style:left={`${pointerPosition.x}px`}
			style:top={`${pointerPosition.y}px`}>
			<FolderOpen size={18} />{draggedEntries.length === 1
				? draggedEntries[0].path.split('/').at(-1)
				: `${draggedEntries.length} items`}
		</div>
	{/if}

	{#if organizeDialog}
		<FolderOrganizeDialog
			mode={organizeDialog}
			folders={destinationFolders}
			initialParent={selectedFolderId ?? ''}
			initialName={organizeDialog === 'rename'
				? (folderById.get(selectedFolders[0])?.name ?? '')
				: ''}
			busy={folderBusy}
			error={folderError}
			count={selectionCount}
			deletePaths={selectedFolders
				.map((id) => folderById.get(id)?.sourcePath ?? '')
				.filter(Boolean)}
			deleteScoreCount={scores.filter((score) =>
				selectedFolders.some((id) =>
					score.sourcePath?.startsWith(`${folderById.get(id)?.sourcePath}/`)
				)
			).length}
			onSubmit={submitOrganization}
			onClose={() => {
				if (!folderBusy) organizeDialog = null;
			}} />
	{/if}

	{#if metadata}
		<MetadataDialog
			workTitle={metadata.workTitle}
			edition={metadata.edition}
			publisher={metadata.publisher}
			editor={metadata.editor}
			arranger={metadata.arranger}
			catalogue={metadata.catalogue}
			key={metadata.key}
			compositionDate={metadata.compositionDate}
			movements={metadata.movements}
			title={metadata.title}
			composer={metadata.composer}
			year={metadata.year}
			ensemble={metadata.ensemble}
			instruments={metadata.instruments}
			tags={metadata.tags ?? []}
			onSave={(payload) => void saveMetadata(payload)}
			onClose={() => (metadata = null)} />
	{/if}

	<SettingsPanel
		focusSection={settingsSection}
		libraryRoot={folder?.nativePath ?? null}
		onImported={refresh}
		onOrganize={folder?.nativePath ? organizeExistingFiles : undefined}
		{organizing}
		{organizationStatus}
		scoreCount={scores.length}
		open={settingsOpen}
		onClose={() => (settingsOpen = false)} />

	<ImslpSearchPanel
		bind:open={imslpOpen}
		libraryRoot={folder?.nativePath ?? null}
		onDownloaded={() => {
			void sync();
			notice = 'IMSLP score added — library refreshed';
			setTimeout(() => (notice = ''), 3000);
		}} />
</div>

{#if importOpen}<ScoreImportDialog
		onClose={() => (importOpen = false)}
		onImported={refresh}
		onChooseFolder={chooseFolder} />{/if}

<style>
	.breadcrumbs {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
		margin-bottom: 10px;
		color: var(--sonora-text-muted);
	}
	.breadcrumbs button {
		border: 0;
		background: transparent;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 36px;
		padding: 6px 10px;
		border-radius: 7px;
		font: inherit;
		font-size: 12px;
		color: inherit;
		cursor: pointer;
	}
	.breadcrumbs button:hover,
	.breadcrumbs button[aria-current='page'] {
		color: var(--sonora-text);
	}
	.selection-toolbar {
		position: fixed;
		left: calc(50% + 120px);
		transform: translateX(-50%);
		bottom: 24px;
		z-index: 40;
		max-width: calc(100vw - 48px);
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 9px 12px;
		margin-bottom: 0;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 12px;
		background: var(--sonora-bg-elevated);
		box-shadow: var(--sonora-shadow-sm);
		flex-wrap: wrap;
	}
	.selection-count {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 13px;
		font-weight: 550;
		margin-right: 16px;
	}
	.selection-dot {
		display: grid;
		place-items: center;
		width: 21px;
		height: 21px;
		border-radius: 50%;
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	.selection-toolbar button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		padding: 8px 10px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--sonora-text-secondary);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.selection-toolbar button:hover {
		color: var(--sonora-text);
		background: var(--sonora-bg-hover);
	}
	.selection-toolbar .delete-folders {
		color: var(--sonora-danger);
	}

	.selection-toolbar .select-all {
		margin-left: auto;
		color: var(--sonora-text-muted);
	}
	.selection-toolbar .clear-selection {
		padding: 8px;
	}

	.drop-target {
		outline: 2px solid var(--sonora-accent);
		outline-offset: -2px;
		background: var(--sonora-accent-soft) !important;
	}
	.new-folder-button {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 10px 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 8px;
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text-secondary);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.new-folder-button:hover {
		color: var(--sonora-text);
		background: var(--sonora-bg-hover);
	}
	.new-folder-button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	@media (max-width: 900px) {
		.selection-toolbar {
			left: 50%;
		}
	}

	.drag-preview {
		position: fixed;
		z-index: 300;
		pointer-events: none;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 11px 15px;
		border: 1px solid var(--sonora-accent);
		border-radius: 10px;
		color: var(--sonora-text);
		background: var(--sonora-bg-elevated);
		box-shadow: var(--sonora-shadow-lg);
		font-size: 13px;
	}

	.list-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.sidebar .list-heading h2 {
		margin: 0;
	}
	.sidebar .list-section {
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--sonora-border);
	}
	span.brand-mark {
		display: grid;
		place-items: center;
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
		border: 1px solid var(--sonora-border-focus);
		border-radius: var(--sonora-radius-md);
	}
	.library {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		background: var(--sonora-bg-workspace);
		color: var(--sonora-text);
		overflow: hidden;
	}
	.header {
		height: 68px;
		flex: 0 0 68px;
		display: grid;
		grid-template-columns: 200px minmax(200px, 1fr) auto;
		align-items: center;
		gap: 16px;
		padding: 0 20px;
		border-bottom: 1px solid var(--sonora-border);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 92%, transparent);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.brand-mark {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
	}
	.brand strong {
		font-size: 16px;
		font-weight: 700;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.folder-button {
		height: 36px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		font-weight: 550;
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			border-color var(--sonora-duration) var(--sonora-ease);
	}
	.folder-button:hover {
		background: var(--sonora-bg-hover);
		border-color: color-mix(
			in srgb,
			var(--sonora-accent) 35%,
			var(--sonora-border-strong)
		);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
	}
	.sidebar {
		width: 240px;
		overflow-y: auto;
		padding: 16px 12px 24px;
		border-right: 1px solid var(--sonora-border);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 55%, transparent);
	}
	.sidebar nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 18px;
	}
	.sidebar nav button,
	.sidebar section button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 10px;
		border: 0;
		border-radius: var(--sonora-radius-md);
		background: transparent;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-md);
		text-align: left;
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.sidebar nav button:hover,
	.sidebar section button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.sidebar nav button.active,
	.sidebar section button.active {
		background: var(--sonora-bg-active);
		color: var(--sonora-text);
	}
	.sidebar nav button span,
	.sidebar section button span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sidebar nav button b,
	.sidebar section button b {
		font-weight: 600;
		font-size: var(--sonora-text-sm);
		opacity: 0.7;
	}
	.folder-summary {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 10px;
		margin-bottom: 16px;
		border-radius: var(--sonora-radius-md);
		background: rgba(255, 255, 255, 0.03);
		color: var(--sonora-text-muted);
	}
	.folder-summary strong {
		display: block;
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		font-weight: 600;
	}
	.folder-summary span {
		font-size: var(--sonora-text-sm);
	}
	.sidebar section h2 {
		margin: 0 0 8px 10px;
		font-size: var(--sonora-text-sm);
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sonora-text-faint);
	}
	.main {
		min-width: 0;
		overflow-y: auto;
		padding: 24px 28px 104px;
	}
	.toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	.toolbar h1 {
		margin: 0 0 4px;
		font-size: 22px;
		font-weight: 700;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.toolbar span {
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-md);
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.seg {
		display: flex;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
	}
	.seg button {
		width: 32px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.seg button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.seg button.active {
		background: var(--sonora-bg-active);
		color: var(--sonora-text);
		box-shadow: var(--sonora-shadow-xs);
	}
	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		margin-top: 24px;
	}
	.pagination button {
		padding: 8px 16px;
		cursor: pointer;
	}
	.score-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
		gap: calc(var(--sonora-space) * 2) var(--sonora-space);
	}
	.library.compact .score-grid {
		gap: 18px 12px;
		grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
	}
	.score-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.empty {
		position: relative;
		max-width: 420px;
		margin: 56px auto 0;
		text-align: center;
		color: var(--sonora-text-muted);
	}
	.empty-orb {
		width: 72px;
		height: 72px;
		margin: 0 auto 18px;
		border-radius: 50%;
		background: radial-gradient(
			circle at 30% 30%,
			var(--sonora-accent-soft),
			transparent 70%
		);
		border: 1px solid var(--sonora-border);
		box-shadow: var(--sonora-accent-glow);
	}
	.empty h2 {
		margin: 0 0 8px;
		color: var(--sonora-text);
		font-size: 18px;
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.empty p {
		margin: 0 0 18px;
		font-size: var(--sonora-text-md);
		line-height: 1.45;
	}
	@media (max-width: 900px) {
		.header {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 12px;
			padding: 0 16px;
		}
		.sidebar {
			width: 190px;
		}
		.body {
			grid-template-columns: 190px minmax(0, 1fr);
		}
		.main {
			padding: 20px 18px 104px;
		}
		.folder-button span {
			display: none;
		}
	}
	@media (max-width: 680px) {
		.header {
			height: 60px;
			flex-basis: 60px;
			padding: 0 12px;
		}
		.brand strong {
			display: none;
		}
		.body {
			display: block;
		}
		.sidebar {
			display: none;
		}
		.main {
			padding: 16px 12px 104px;
		}
		.toolbar {
			align-items: center;
			margin-bottom: 16px;
		}
		.score-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 18px 10px;
		}
	}
</style>
