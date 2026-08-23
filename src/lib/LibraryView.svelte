<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderPlus, FileText, Search, Trash2, Music, Grid2X2, List, Clock3, Star, X, Settings2, Upload, ChevronRight, BookOpen, Sparkles } from 'lucide-svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem } from './types';

	let { onSelectScore }: { onSelectScore: (score: ScoreItem) => void } = $props();
	let scores = $state<ScoreItem[]>([]);
	let searchQuery = $state('');
	let isProcessing = $state(false);
	let processLabel = $state('');
	let selectedComposerFolder = $state<string | null>(null);
	let viewMode = $state<'grid' | 'list'>('grid');
	let sortMode = $state<'recent' | 'title' | 'composer'>('recent');
	let filter = $state<'all' | 'favorites' | 'recent'>('all');
	let isDragging = $state(false);
	let settingsOpen = $state(false);
	let compact = $state(false);
	let composerImages = $state<Record<string, string>>({});

	const composerImage: Record<string,string> = {
		'Johann Sebastian Bach':'https://upload.wikimedia.org/wikipedia/commons/6/6f/Johann_Sebastian_Bach.jpg',
		'Ludwig van Beethoven':'https://upload.wikimedia.org/wikipedia/commons/6/6f/Beethoven.jpg',
		'Wolfgang Amadeus Mozart':'https://upload.wikimedia.org/wikipedia/commons/1/1e/Wolfgang-amadeus-mozart_1.jpg',
		'Franz Schubert':'https://upload.wikimedia.org/wikipedia/commons/0/0a/Franz_Schubert_by_Wilhelm_August_Rieder_1825.jpg',
		'Frédéric Chopin':'https://upload.wikimedia.org/wikipedia/commons/3/33/Frederic_Chopin_photo.jpeg',
		'Johannes Brahms':'https://upload.wikimedia.org/wikipedia/commons/1/1f/Johannes_Brahms_by_C._F._Schwager_1876.jpg',
		'Pyotr Ilyich Tchaikovsky':'https://upload.wikimedia.org/wikipedia/commons/a/a2/Tchaikovsky_by_Reutlinger.jpg',
		'Felix Mendelssohn':'https://upload.wikimedia.org/wikipedia/commons/4/4e/Felix_Mendelssohn_Bartholdy.jpg',
		'Robert Schumann':'https://upload.wikimedia.org/wikipedia/commons/8/8b/Robert_Schumann.jpg',
		'Antonín Dvořák':'https://upload.wikimedia.org/wikipedia/commons/2/2f/Anton%C3%ADn_Dvo%C5%99%C3%A1k_LOC_3c05828u.jpg',
		'George Frideric Handel':'https://upload.wikimedia.org/wikipedia/commons/8/86/George_Frideric_Handel_by_Balthasar_Denner.jpg'
	};

	onMount(async () => {
		scores = await db.scores.orderBy('addedAt').reverse().toArray();
		composerImages = composerImage;
		const saved = localStorage.getItem('sonora-library-settings');
		if (saved) try { const s=JSON.parse(saved); viewMode=s.viewMode||'grid'; compact=!!s.compact; } catch {}
	});

	async function createThumbnail(file: File) {
		const data = new Uint8Array(await file.arrayBuffer());
		const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
		try {
			const page = await doc.getPage(1); const viewport = page.getViewport({ scale: 0.35 }); const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d')!; const dpr=Math.min(devicePixelRatio||1,2); canvas.width=Math.ceil(viewport.width*dpr); canvas.height=Math.ceil(viewport.height*dpr); ctx.scale(dpr,dpr); await page.render({canvasContext:ctx,viewport}).promise; return {thumbnailUrl:canvas.toDataURL('image/jpeg',0.76),totalPages:doc.numPages};
		} finally { await doc.destroy(); }
	}
	async function processFiles(files: File[]) {
		if (!files.length) return; isProcessing=true; let done=0;
		try { for (const file of files) { done++; processLabel=`Importing ${done}/${files.length}…`; const parts=(file.webkitRelativePath||file.name).split('/'); const composer=parts.length>=2?parts[parts.length-2]:'Unknown Composer'; let thumbnailUrl:string|undefined; let totalPages=1; try { ({thumbnailUrl,totalPages}=await createThumbnail(file)); } catch(err) { console.warn('Thumbnail failed',err); }
			const score:ScoreItem={id:`${file.name}-${file.lastModified}-${crypto.randomUUID()}`,title:file.name.replace(/\.pdf$/i,''),composer,pdfBlob:file,thumbnailUrl,totalPages,addedAt:Date.now(),lastOpenedAt:0,favorite:false,tags:[],collection:composer}; await db.scores.put($state.snapshot(score)); scores=[score,...scores]; } } finally { isProcessing=false; processLabel=''; }
	}
	async function handleFolderSelect(e:Event){const input=e.target as HTMLInputElement;await processFiles(Array.from(input.files||[]).filter(f=>f.name.toLowerCase().endsWith('.pdf')));input.value='';}
	async function handleSingleFiles(e:Event){const input=e.target as HTMLInputElement;await processFiles(Array.from(input.files||[]).filter(f=>f.name.toLowerCase().endsWith('.pdf')));input.value='';}
	async function handleDrop(e:DragEvent){e.preventDefault();isDragging=false;await processFiles(Array.from(e.dataTransfer?.files||[]).filter(f=>f.name.toLowerCase().endsWith('.pdf')));}
	async function updateScore(score:ScoreItem,patch:Partial<ScoreItem>,e?:MouseEvent){e?.stopPropagation();const next={...score,...patch};await db.scores.put($state.snapshot(next));scores=scores.map(s=>s.id===score.id?next:s);}
	async function openScore(score:ScoreItem){const next={...score,lastOpenedAt:Date.now()};await db.scores.put($state.snapshot(next));scores=scores.map(s=>s.id===score.id?next:s);onSelectScore(next);}
	async function toggleFavorite(score:ScoreItem,e:MouseEvent){await updateScore(score,{favorite:!score.favorite},e);}
	async function deleteScore(id:string,e:MouseEvent){e.stopPropagation();if(!confirm('Remove this score from your library? Annotations will be deleted too.'))return;await db.scores.delete(id);await db.annotations.where('scoreId').equals(id).delete();scores=scores.filter(s=>s.id!==id);}
	function saveSettings(){localStorage.setItem('sonora-library-settings',JSON.stringify({viewMode,compact}));settingsOpen=false;}
	function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();}
	const filteredScores=$derived(scores.filter(s=>!selectedComposerFolder||s.composer===selectedComposerFolder).filter(s=>filter==='favorites'?!!s.favorite:filter==='recent'?!!s.lastOpenedAt:true).filter(s=>{const q=searchQuery.toLowerCase().trim();if(!q)return true;return s.title.toLowerCase().includes(q)||s.composer.toLowerCase().includes(q)||(s.tags||[]).join(' ').toLowerCase().includes(q);}).sort((a,b)=>sortMode==='title'?a.title.localeCompare(b.title):sortMode==='composer'?a.composer.localeCompare(b.composer):(b.lastOpenedAt||b.addedAt)-(a.lastOpenedAt||a.addedAt)));
	const composers=$derived.by(()=>{const m:Record<string,ScoreItem[]>={};for(const s of scores)(m[s.composer||'Unknown Composer']||=[]).push(s);return m;});
</script>

<div class="h-full flex flex-col bg-[#11110f] text-neutral-100 overflow-hidden" ondragover={(e)=>{e.preventDefault();isDragging=true;}} ondragleave={()=>isDragging=false} ondrop={handleDrop}>
	<header class="shrink-0 border-b border-white/7 bg-[#171714]/95 backdrop-blur-xl px-4 sm:px-6 py-4">
		<div class="max-w-[1600px] mx-auto flex flex-wrap items-center gap-3">
			<div class="flex items-center gap-3 min-w-0 mr-2"><div class="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-900/30"><Music size={21}/></div><div class="min-w-0"><h1 class="text-lg font-semibold tracking-tight">Sonora</h1><p class="text-xs text-neutral-500">Your music library</p></div></div>
			<div class="relative flex-1 min-w-[200px] max-w-2xl"><Search size={17} class="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500"/><input bind:value={searchQuery} placeholder="Search scores, composers, tags…" class="w-full h-11 rounded-2xl bg-[#0d0d0b] border border-white/8 pl-10 pr-10 outline-none focus:border-violet-500/60 transition"/>{#if searchQuery}<button class="absolute right-2 top-2 p-1.5 text-neutral-400 hover:text-white" onclick={()=>searchQuery=''}><X size={15}/></button>{/if}</div>
			<div class="flex items-center gap-1.5 ml-auto"><label class="h-11 px-4 rounded-2xl bg-white/5 border border-white/8 hover:bg-white/8 flex items-center gap-2 cursor-pointer text-sm"><Upload size={16}/><span class="hidden sm:inline">Import folder</span><input type="file" webkitdirectory directory multiple class="hidden" onchange={handleFolderSelect}/></label><label class="h-11 px-4 rounded-2xl bg-violet-600 hover:bg-violet-500 flex items-center gap-2 cursor-pointer text-sm font-medium shadow-lg shadow-violet-900/20"><FolderPlus size={16}/><span class="hidden sm:inline">Add scores</span><input type="file" accept=".pdf" multiple class="hidden" onchange={handleSingleFiles}/></label><button class="h-11 w-11 rounded-2xl hover:bg-white/8 flex items-center justify-center" onclick={()=>settingsOpen=!settingsOpen}><Settings2 size={18}/></button></div>
		</div>
	</header>
	{#if isProcessing}<div class="shrink-0 py-2.5 bg-violet-500/10 border-b border-violet-500/20 text-violet-200 text-sm text-center">{processLabel}</div>{/if}
	<div class="flex-1 min-h-0 flex overflow-hidden">
		<aside class="hidden lg:flex w-64 shrink-0 border-r border-white/7 bg-[#141411] p-4 flex-col gap-5 overflow-y-auto">
			<div class="space-y-1"><p class="px-3 mb-2 text-[11px] uppercase tracking-widest text-neutral-600">Library</p>{#each [['all','All scores',Grid2X2],['recent','Recently opened',Clock3],['favorites','Favorites',Star]] as item}<button class="w-full h-10 px-3 rounded-xl flex items-center gap-3 text-sm {filter===item[0]&&!selectedComposerFolder?'bg-white/8 text-white':'text-neutral-400 hover:bg-white/5 hover:text-white'}" onclick={()=>{filter=item[0] as any;selectedComposerFolder=null;}}><svelte:component this={item[2]} size={17}/><span>{item[1]}</span></button>{/each}</div>
			<div><p class="px-3 mb-2 text-[11px] uppercase tracking-widest text-neutral-600">Composers</p><div class="space-y-1">{#each Object.entries(composers).sort((a,b)=>a[0].localeCompare(b[0])) as [comp,list]}<button class="w-full h-11 px-2 rounded-xl flex items-center gap-2 text-left {selectedComposerFolder===comp?'bg-violet-500/12 text-violet-200':'text-neutral-400 hover:bg-white/5 hover:text-white'}" onclick={()=>{selectedComposerFolder=comp;filter='all';}}><div class="w-8 h-8 rounded-lg overflow-hidden bg-neutral-800 shrink-0">{#if composerImages[comp]}<img src={composerImages[comp]} alt="" class="w-full h-full object-cover" loading="lazy"/>{:else}<div class="w-full h-full flex items-center justify-center text-[10px] font-bold text-neutral-500">{initials(comp)}</div>{/if}</div><span class="truncate flex-1 text-sm">{comp}</span><span class="text-[11px] text-neutral-600">{list.length}</span></button>{/each}</div></div>
		</aside>
		<main class="flex-1 min-w-0 overflow-auto bg-[radial-gradient(circle_at_top,#24241f_0%,#11110f_52%)] p-4 sm:p-6 lg:p-8">
			<div class="max-w-[1500px] mx-auto">
				<div class="flex items-end justify-between gap-4 mb-7"><div><p class="text-xs text-violet-300 mb-1">{selectedComposerFolder?'Composer collection':'Your library'}</p><h2 class="text-2xl sm:text-3xl font-semibold tracking-tight">{selectedComposerFolder||filter==='favorites'?'Favorites':filter==='recent'?'Recently opened':'All scores'}</h2><p class="text-sm text-neutral-500 mt-1">{filteredScores.length} {filteredScores.length===1?'score':'scores'}</p></div><div class="flex items-center gap-2"><select bind:value={sortMode} class="h-10 rounded-xl bg-black/20 border border-white/8 px-3 text-sm outline-none"><option value="recent">Recently used</option><option value="title">Title</option><option value="composer">Composer</option></select><div class="flex rounded-xl bg-black/20 border border-white/8 p-1"><button class="h-8 w-8 rounded-lg {viewMode==='grid'?'bg-white/10 text-white':'text-neutral-500'}" onclick={()=>viewMode='grid'}><Grid2X2 size={15}/></button><button class="h-8 w-8 rounded-lg {viewMode==='list'?'bg-white/10 text-white':'text-neutral-500'}" onclick={()=>viewMode='list'}><List size={15}/></button></div></div></div>
				{#if selectedComposerFolder}<div class="mb-7 rounded-3xl overflow-hidden border border-white/8 bg-white/4 relative h-36 sm:h-44"><img src={composerImages[selectedComposerFolder]||''} alt="" class="absolute inset-0 w-full h-full object-cover opacity-35 blur-[1px]"/><div class="absolute inset-0 bg-gradient-to-r from-[#11110f] via-[#11110f]/80 to-transparent"></div><div class="absolute inset-0 flex items-center gap-4 p-6"><div class="w-20 h-20 rounded-2xl overflow-hidden border border-white/15 shadow-xl bg-neutral-800">{#if composerImages[selectedComposerFolder]}<img src={composerImages[selectedComposerFolder]} alt="" class="w-full h-full object-cover"/>{:else}<div class="w-full h-full flex items-center justify-center font-semibold text-neutral-400">{initials(selectedComposerFolder)}</div>{/if}</div><div><p class="text-xs uppercase tracking-widest text-violet-300">Composer</p><h3 class="text-2xl font-semibold">{selectedComposerFolder}</h3><p class="text-sm text-neutral-400">{composers[selectedComposerFolder]?.length||0} works in your library</p></div></div></div>{/if}
				{#if filteredScores.length===0}<div class="min-h-[45vh] rounded-3xl border border-dashed border-white/10 flex flex-col items-center justify-center text-center p-8"><div class="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-4"><BookOpen size={25} class="text-neutral-500"/></div><h3 class="text-lg font-medium">Nothing here yet</h3><p class="text-sm text-neutral-500 mt-1 max-w-sm">Add PDF scores or drag them anywhere into Sonora. Composer folders will be created automatically from imported folders.</p></div>{:else}<div class={viewMode==='grid'?'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-5':'flex flex-col gap-2'}>{#each filteredScores as score (score.id)}<button onclick={()=>openScore(score)} class="group relative text-left overflow-hidden {viewMode==='grid'?'rounded-2xl bg-[#181815] border border-white/7 hover:border-violet-500/45 hover:-translate-y-1 hover:shadow-2xl hover:shadow-black/30 transition-all':'rounded-2xl bg-[#181815] border border-white/7 hover:bg-white/5 transition p-3 flex items-center gap-4'}">
						<div class={viewMode==='grid'?'aspect-[.707] bg-[#0c0c0a] relative overflow-hidden':'w-14 h-20 rounded-xl bg-[#0c0c0a] overflow-hidden shrink-0'}>{#if score.thumbnailUrl}<img src={score.thumbnailUrl} alt="" class="w-full h-full object-cover transition duration-500 group-hover:scale-[1.03]" loading="lazy"/>{:else}<div class="w-full h-full flex flex-col items-center justify-center text-neutral-600"><FileText size={22}/><span class="text-[10px] mt-2">{initials(score.composer)}</span></div>{/if}<div class="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent"></div>{#if score.favorite}<div class="absolute top-3 right-3 w-8 h-8 rounded-xl bg-black/45 backdrop-blur flex items-center justify-center text-amber-400"><Star size={14} fill="currentColor"/></div>{/if}</div>
						<div class={viewMode==='grid'?'p-3.5 min-w-0':'min-w-0 flex-1'}><h3 class="font-medium text-sm truncate group-hover:text-violet-200 transition">{score.title}</h3><p class="text-xs text-neutral-500 truncate mt-1">{score.composer}</p><div class="flex items-center justify-between mt-3 text-[11px] text-neutral-600"><span>{score.totalPages} {score.totalPages===1?'page':'pages'}</span>{#if score.lastOpenedAt}<span>Opened</span>{/if}</div></div>
						<div class="absolute {viewMode==='grid'?'top-3 left-3':'right-3'} opacity-0 group-hover:opacity-100 transition flex gap-1"><span role="button" class="w-8 h-8 rounded-xl bg-black/60 backdrop-blur flex items-center justify-center text-neutral-300 hover:text-amber-400" onclick={(e)=>toggleFavorite(score,e)}><Star size={14} fill={score.favorite?'currentColor':'none'}/></span><span role="button" class="w-8 h-8 rounded-xl bg-black/60 backdrop-blur flex items-center justify-center text-neutral-300 hover:text-red-400" onclick={(e)=>deleteScore(score.id,e)}><Trash2 size={14}/></span></div>
					</button>{/each}</div>{/if}
			</div>
		</main>
	</div>
	{#if isDragging}<div class="absolute inset-0 z-50 bg-violet-950/40 backdrop-blur-sm flex items-center justify-center pointer-events-none"><div class="rounded-3xl border-2 border-dashed border-violet-300/60 bg-[#171714]/95 px-10 py-12 text-center shadow-2xl"><Sparkles size={28} class="mx-auto text-violet-300 mb-3"/><h3 class="text-xl font-semibold">Drop scores to import</h3><p class="text-sm text-neutral-400 mt-1">PDFs will be added to your library</p></div></div>{/if}
	{#if settingsOpen}<div class="absolute top-20 right-4 z-40 w-80 rounded-3xl border border-white/10 bg-[#1a1a17]/98 backdrop-blur-xl shadow-2xl p-5"><div class="flex items-center justify-between mb-5"><div><h3 class="font-semibold">Library settings</h3><p class="text-xs text-neutral-500">Customize your library.</p></div><button class="p-2 rounded-xl hover:bg-white/8" onclick={()=>settingsOpen=false}><X size={17}/></button></div><div class="space-y-4 text-sm"><label class="flex items-center justify-between"><span>Compact cards</span><input type="checkbox" bind:checked={compact}/></label><div><p class="text-xs text-neutral-500 mb-2">Default view</p><div class="grid grid-cols-2 gap-2"><button class="py-2.5 rounded-xl border {viewMode==='grid'?'border-violet-500 bg-violet-500/15':'border-white/8 bg-white/5'}" onclick={()=>viewMode='grid'}>Grid</button><button class="py-2.5 rounded-xl border {viewMode==='list'?'border-violet-500 bg-violet-500/15':'border-white/8 bg-white/5'}" onclick={()=>viewMode='list'}>List</button></div></div><button class="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500" onclick={saveSettings}>Save settings</button></div></div>{/if}
</div>
