<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import { db } from './db';

	if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
		pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
	}
	import type {
		ScoreItem,
		Stroke,
		Point,
		SymbolStamp,
		TextNote
	} from './types';
</script>
