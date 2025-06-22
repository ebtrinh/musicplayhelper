<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	/* --- constants & helpers --- */
	const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
	const BUF_SIZE = 1024, HIST = 5, HOLD_MS = 3000;
	const MIN_FREQ = 80;
	const MAX_FREQ = 1200;
	const f2n = (f:number)=>`${NOTES[Math.round(12*Math.log2(f/440)+69)%12]}${Math.floor((Math.round(12*Math.log2(f/440)+69))/12)-1}`;
	const rms2db = (r:number)=>20*Math.log10(r||1e-10);

	/* --- component state --- */
	let freq = 0, note = '--';
	let loudness = -Infinity, minDb = -35;
	let lastHeard = 0;                     // ms timestamp of last valid pitch
	let line: string[] = [];

	/* --- audio setup --- */
	let ctx:AudioContext, analyser:AnalyserNode;
	const buf = new Float32Array(BUF_SIZE), hist:number[] = [];
	let running = false;
	let notes: StaveNote[] = [];

	let lastGoodFreq = 0;                      // last frequency we trusted

// returns true if cand is ≈ ½× or ¼× of ref (±4 %)
function isSubHarmonic(cand: number, ref: number): boolean {
  const TOL = 0.04;                        // 4 % band
  return (
    Math.abs(cand * 2 - ref) / ref < TOL ||   // ½ ×
    Math.abs(cand * 4 - ref) / ref < TOL      // ¼ ×
  );
}


	function detect(buf: Float32Array, sr: number): number {
  /* 1. loudness gate ---------------------------------------------------- */
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
  const rms = Math.sqrt(energy / buf.length);
  loudness = rms2db(rms);
  if (loudness < minDb) return -1;

  /* 2. search lag window for 80-1200 Hz -------------------------------- */
  const minLag = Math.floor(sr / MAX_FREQ);  // shortest lag (≈ 37)
  const maxLag = Math.floor(sr / MIN_FREQ);  // longest  lag (≈ 551)
  const halfBuf = buf.length >> 1;
  const searchLimit = Math.min(maxLag, halfBuf);

  let bestCorr = 0;
  let bestLag  = -1;

  for (let lag = minLag; lag <= searchLimit; lag++) {
    let corr = 0;
    for (let i = 0; i < halfBuf; i++) corr += buf[i] * buf[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  /* 3. confidence guard ------------------------------------------------- */
  const CONF_THRESH = 0.35;          // relaxed threshold
  const selfCorr = energy;           // correlation at lag 0
  if (bestLag < 0 || bestCorr / selfCorr < CONF_THRESH) return -1;

  /* 4. convert lag → frequency & hard-cap filter ------------------------ */
  const candidate = sr / bestLag;
  if (candidate >= MAX_FREQ) return -1;  // discard 1200 Hz glitches

  return candidate;                      // valid pitch
}



	let raf: number | null = null;   // note the null so "no frame yet" ≠ 0

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
		generateRandomLine();
	});

	onDestroy(() => {
		// cancelAnimationFrame only exists in the browser; guard first
		if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function' && raf !== null) {
			window.cancelAnimationFrame(raf);
		}
		ctx?.close();
	});
	const GREEN = '#16a34a';          // Tailwind “green-600”; tweak if desired

function markNoteGreen(note: StaveNote): void {
  note.setStyle({
    fillStyle:   GREEN,   // note head fill
    strokeStyle: GREEN    // outline, stem, and ledger lines
  });
}


function renderStaff(): void {
  if (!vfDiv) return;                     // safety check
  vfDiv.innerHTML = '';                   // wipe previous SVG

  /* basic VexFlow setup */
  const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
  renderer.resize(600, 140);
  const ctx = renderer.getContext();

  /* single stave in alto clef */
  const stave = new Stave(10, 20, 580)
    .addClef('alto')
    .addTimeSignature('8/4');
  stave.setContext(ctx).draw();

  /* voice: 8 quarter notes */
  const voice = new Voice({ resolution: 4096 } as any);  // no meter
voice.setMode(Voice.Mode.SOFT);                        // ← 1 line
voice.addTickables(notes);

new Formatter().joinVoices([voice]).format([voice], 520);
voice.draw(ctx, stave);

}

function isClearlyDifferent(a: number, b: number): boolean {
  return Math.abs(a - b) / b > 0.10;        // > ±10 %
}


let matchedFreq = 0;             // freq of the last note we turned green
let gate: 'READY' | 'WAIT_NEXT' | 'WAIT_ATTACK' = 'READY';
let readyToMatch = true;     // true  ⇒ we’re allowed to judge this note
let waitingForSilence = false; // aids “dip-then-rise” detection
let i = 0;
function tick(): void {
  if (!running) return;

  /* -------- 1. Pull audio & estimate pitch -------- */
  analyser.getFloatTimeDomainData(buf);
  const p = detect(buf, ctx.sampleRate);

  if (p > 0) {
  hist.push(p);
  if (hist.length > HIST) hist.shift();

  const mid = [...hist].sort((a, b) => a - b)[Math.floor(hist.length / 2)];

  /* ─── NEW: ignore ½-f and ¼-f blips ─── */
  if (lastGoodFreq && isSubHarmonic(mid, lastGoodFreq)) {
    // do nothing → skip this frame
  } else {
    /* accept and publish the reading */
    freq = Math.round(mid);
    note = f2n(mid);
    lastGoodFreq = mid;          // remember for next test
    lastHeard = Date.now();
  }
}
else if (Date.now() - lastHeard > HOLD_MS) {
    freq = 0;
    note = '--';
  }

  /* -------- 2. 3-state gate driven by loudness -------- */
  switch (gate) {
  case 'READY': {
    /* compare ONLY in READY */
    if (gate === 'READY' && note === line[i]) {
		markNoteGreen(notes[i]);
		matchedFreq = freq;            //  ← remember this exact pitch
		i++;
		renderStaff();
		gate = 'WAIT_NEXT';
		}
    break;
  }

  case 'WAIT_NEXT': {
  /* EITHER silence … */
  if (loudness < minDb) {
    gate = 'WAIT_ATTACK';
  }
  /* … OR a clearly different pitch */
  else if (freq && matchedFreq && isClearlyDifferent(freq, matchedFreq)) {
    gate = 'READY';
  }
  break;
}

  case 'WAIT_ATTACK': {
    if (loudness >= minDb) gate = 'READY';  // loud again
    break;
  }
}

  /* -------- 3. schedule next animation frame -------- */
  raf = requestAnimationFrame(tick);
}

	

  /* ----------  VexFlow setup  ---------- */
	import { Renderer, Stave, StaveNote, Voice, Formatter } from 'vexflow';
	let vfDiv: HTMLDivElement;      // bind local <div> for the score
	

	const NOTE_LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b']; //    lower-case
	const OCTAVES      = [3,4];   // sensible alto-clef range (G3–F5)

	function randomNote() {                  //   returns “d/4”
   const letter = NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)];
   const octave = OCTAVES[Math.floor(Math.random() * OCTAVES.length)];
   line.push(`${letter.toUpperCase()}${octave}`);
   return `${letter}/${octave}`;
 }

	function generateRandomLine() {
		line = [];
		i=0;
		if (!vfDiv) return;

		/* clear any previous rendering */
		vfDiv.innerHTML = '';

		/* basic renderer */
		const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
		renderer.resize(600, 140);
		const context = renderer.getContext();

		/* stave with alto clef */
		const stave = new Stave(10, 20, 580);
		stave.addClef('alto').addTimeSignature('8/4');
		stave.setContext(context).draw();

		/* 8 quarter-notes */
		notes = Array.from({ length: 8 }, () =>
   new StaveNote({
    keys: [randomNote()],                 //    “d/4”  ✔
     duration: 'q',
     clef: 'alto'                         // tell VexFlow we’re on alto
   })
 );

		/* voice = 8 beats of 1/4 each */
		const voice = new Voice({ numBeats: 8, beatValue: 4 });
		voice.addTickables(notes);

		/* format & draw */
		new Formatter().joinVoices([voice]).format([voice], 520);
		voice.draw(context, stave);
		


	}		
</script>

<div class="flex flex-col items-center justify-center h-screen gap-6 text-center">
	<h1 class="text-3xl font-bold">Ethan's Music Buddy</h1>

	<div bind:this={vfDiv}></div>
	<button on:click={generateRandomLine} class="my-4 rounded-md bg-blue-500 px-4 py-2 text-white">
		New Staff
	</button>

	<div class="flex flex-col items-center gap-1">
		<div class="text-6xl font-mono">{freq || '--'} Hz</div>
		<div class="text-5xl">{note}</div>
	</div>

	<label class="flex flex-col items-center gap-1">
		<span class="text-sm">Ignore sounds quieter than {minDb} dBFS</span>
		<input type="range" min="-60" max="-10" step="1" bind:value={minDb} class="w-64 accent-blue-500"/>
	</label>

	<div class="text-xs opacity-70">current loudness: {loudness.toFixed(1)} dBFS</div>
	<footer class="text-xs opacity-60">buncha updates soon for variety soon</footer>
</div>
