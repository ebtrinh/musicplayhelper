<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	/* --- constants & helpers --- */
	const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
	const BUF_SIZE = 1024, HIST = 5, HOLD_MS = 3000;
	const f2n = (f:number)=>`${NOTES[Math.round(12*Math.log2(f/440)+69)%12]}${Math.floor((Math.round(12*Math.log2(f/440)+69))/12)-1}`;
	const rms2db = (r:number)=>20*Math.log10(r||1e-10);

	/* --- component state --- */
	let freq = 0, note = '--';
	let loudness = -Infinity, minDb = -35;
	let lastHeard = 0;                     // ms timestamp of last valid pitch

	/* --- audio setup --- */
	let ctx:AudioContext, analyser:AnalyserNode;
	const buf = new Float32Array(BUF_SIZE), hist:number[] = [];
	let running = false;

	function detect(b:Float32Array,sr:number){
		let sum=0;
		for(let i=0;i<b.length;i++) sum += b[i]*b[i];
		const rms = Math.sqrt(sum/b.length);
		loudness = rms2db(rms);
		if(loudness < minDb) return -1;

		let best=-1, bestLag=-1, max=b.length/2;
		for(let lag=16;lag<max;lag++){
			let c=0; for(let i=0;i<max;i++) c += b[i]*b[i+lag];
			if(c>best){ best=c; bestLag=lag; }
		}
		return bestLag>0 ? sr/bestLag : -1;
	}

	let raf: number | null = null;   // note the null so “no frame yet” ≠ 0

	onMount(async () => {
		if (typeof window === 'undefined') return;   // SSR guard
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			ctx = new AudioContext();
			analyser = ctx.createAnalyser();
			analyser.fftSize = BUF_SIZE * 2;
			ctx.createMediaStreamSource(stream).connect(analyser);

			running = true;
			raf = window.requestAnimationFrame(tick);  // explicit window.*
		} catch {
			alert('⚠️ Microphone permission denied.');
		}
	});

	onDestroy(() => {
		// cancelAnimationFrame only exists in the browser; guard first
		if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function' && raf !== null) {
			window.cancelAnimationFrame(raf);
		}
		ctx?.close();
	});

	function tick(){
		if(!running) return;
		analyser.getFloatTimeDomainData(buf);
		const f = detect(buf, ctx.sampleRate);

		if(f>0){                         // got a pitch
			hist.push(f); if(hist.length>HIST) hist.shift();
			const stable = Math.max(...hist);
			freq = Math.round(stable);
			note = f2n(stable);
			lastHeard = Date.now();
		}else{                          // silence / gated
			if(Date.now() - lastHeard > HOLD_MS){
				freq = 0; note = '--';
			}
		}
		raf = requestAnimationFrame(tick);
	}
</script>

<div class="flex flex-col items-center justify-center h-screen gap-6 text-center">
	<h1 class="text-3xl font-bold">Mic Pitch Detector</h1>

	<div class="flex flex-col items-center gap-1">
		<div class="text-6xl font-mono">{freq || '--'} Hz</div>
		<div class="text-5xl">{note}</div>
	</div>

	<label class="flex flex-col items-center gap-1">
		<span class="text-sm">Ignore sounds quieter than {minDb} dBFS</span>
		<input type="range" min="-60" max="-10" step="1" bind:value={minDb} class="w-64 accent-blue-500"/>
	</label>

	<div class="text-xs opacity-70">current loudness: {loudness.toFixed(1)} dBFS</div>
	<footer class="text-xs opacity-60">holds last pitch for 3 s • SvelteKit</footer>
</div>
