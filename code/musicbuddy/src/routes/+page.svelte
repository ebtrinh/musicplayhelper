<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { YIN } from 'pitchfinder';
  import { Renderer, RenderContext, Stave, StaveNote, Voice, Formatter, Accidental, KeyManager, Beam } from 'vexflow';
  import { parseMusicXML, type MeasureData } from './analysisToStave';
	import { render } from 'svelte/server';
  /* --- constants & helpers --- */
  const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const CLEFS = ['bass','alto','treble'] as const;
  type Clef = typeof CLEFS[number];
  let selectedClef: Clef = 'treble';
  let msreCount = -1;
  let totalMsre = 0;
  // Octave ranges roughly centred on each clef
  const CLEF_RANGES: Record<Clef, number[]> = {
    bass:   [2,3],   // C2–B3
    alto:   [3,4],   // G3–F5
    treble: [4,5]    // E4–C6
  };

  const DURATIONS = [
  { dur: 'h', beats: 2,   w: 1 },   // halves  →  ~20 %
  { dur: 'q', beats: 1,   w: 3 },   // quarters →  ~60 %
  { dur: '8', beats: 0.5, w: 1 }    // eighths  →  ~20 %
] as const;

/* weighted-random helper */
function pickWeighted<T extends { w: number }>(arr: T[]): T {
  const total = arr.reduce((s, a) => s + a.w, 0);
  let r = Math.random() * total;
  for (const a of arr) {
    if ((r -= a.w) <= 0) return a;
  }
  return arr[arr.length - 1];        // Fallback (shouldn't hit)
} 
const MEASURE_BEATS = 4;       // 4/4

  const HIST = 5;
  const HOLD_MS = 3000;
  const BUF_SIZE = 4096;              // ≈ 93 ms @ 44.1 kHz

  const TS_OPTIONS = [
  { label: '2/4', beats: 2 },
  { label: '3/4', beats: 3 },
  { label: '4/4', beats: 4 },
  { label: '6/8', beats: 6 }
];

let selectedTS = TS_OPTIONS[2].label;   // default "4/4"

  let km: KeyManager;

  const KEY_SIGS = [
    { value: 'random', label: 'Random' },   // leave the generator unchanged
    { value: 'C',      label: 'C major / A minor (0 ♯/♭)' },
    { value: 'G',      label: 'G major / E minor (1 ♯)'  },
    { value: 'D',      label: 'D major / B minor (2 ♯)'  },
    { value: 'A',      label: 'A major / F♯ minor (3 ♯)' },
    { value: 'E',      label: 'E major / C♯ minor (4 ♯)' },
    { value: 'B',      label: 'B major / G♯ minor (5 ♯)' },
    { value: 'F#',     label: 'F♯ major / D♯ minor (6 ♯)' },
    { value: 'C#',     label: 'C♯ major / A♯ minor (7 ♯)' },
    { value: 'F',      label: 'F major / D minor (1 ♭)'  },
    { value: 'Bb',     label: 'B♭ major / G minor (2 ♭)' },
    { value: 'Eb',     label: 'E♭ major / C minor (3 ♭)' },
    { value: 'Ab',     label: 'A♭ major / F minor (4 ♭)' },
    { value: 'Db',     label: 'D♭ major / B♭ minor (5 ♭)' },
    { value: 'Gb',     label: 'G♭ major / E♭ minor (6 ♭)' },
    { value: 'Cb',     label: 'C♭ major / A♭ minor (7 ♭)' }
  ];

  let selectedKeySig  = 'random';   // what the user picked in the UI
  let currentKeySig   = 'C';        // the actual key used on the staff

/* helper — turn “random” into a real key */
function resolveKey(): string {
  return selectedKeySig === 'random'
    ? KEY_SIGS[Math.floor(Math.random() * (KEY_SIGS.length - 1)) + 1].value
    : selectedKeySig;
}

function accidentalCount(key: string): number {
  // strip any “m” (relative-minor) suffix
  const root = key.replace(/m$/i, '');

  const SHARPS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const FLATS  = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

  const sharpIndex = SHARPS.indexOf(root);
  if (sharpIndex !== -1) return sharpIndex;          // 0-7 sharps

  const flatIndex  = FLATS.indexOf(root);
  if (flatIndex  !== -1) return flatIndex;           // 0-7 flats

  return 0;                                          // fallback (shouldn’t happen)
}

  
  const MIN_FREQ = 40;
  const MAX_FREQ = 1200;
  const THRESH        = 0.07;         // stricter than default 0.10
  const PROB_MIN      = 0.90;         // only accept highly‑confident frames
  const OCT_TOL       = 0.03;         // ±3 % tolerance for 2× glitch test
  let   lastFreq      = 0;

  const f2n = (f:number)=>`${NOTES[Math.round(12*Math.log2(f/440)+69)%12]}${Math.floor((Math.round(12*Math.log2(f/440)+69))/12)-1}`;
  const rms2db = (r:number)=>20*Math.log10(r||1e-10);

  /* --- component state --- */
  let freq = 0, note = '--';
  let loudness = -Infinity, minDb = -35;
  let lastHeard = 0;                     // ms timestamp of last valid pitch
  let line: string[] = [];      // pretty for display (“D♭4”)
  let target: number[] = [];    // canonical MIDI numbers (61)

  /* --- audio setup --- */
  let ctx:AudioContext, analyser:AnalyserNode;
  const buf = new Float32Array(BUF_SIZE), hist:number[] = [];
  let running = false;
  let notes: StaveNote[] = [];

  let lastGoodFreq = 0;

  function isSubHarmonic(cand: number, ref: number): boolean {
    const TOL = 0.04;
    return (
      Math.abs(cand * 2 - ref) / ref < TOL ||
      Math.abs(cand * 4 - ref) / ref < TOL
    );
  }

  let raf: number | null = null;
  let yinDetect: (data: Float32Array) => number | null;
  onMount(async () => {
    if (typeof window === 'undefined') return;   // SSR guard
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = BUF_SIZE;

      yinDetect = YIN({
        sampleRate: ctx.sampleRate,
        threshold: THRESH,
        probabilityThreshold: PROB_MIN,
      });
      ctx.createMediaStreamSource(stream).connect(analyser);

      running = true;
      raf = window.requestAnimationFrame(tick);
    } catch {
      alert('⚠️ Microphone permission denied.');
    }
    generateRandomLine();
  });

  function detect(buf: Float32Array): number {
    // 1 . loudness test + gate
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    loudness = rms2db(Math.sqrt(sum / buf.length));

    const f = yinDetect(buf);
    if (f == null || f < MIN_FREQ || f > MAX_FREQ) return -1;

    // 2 . fold occasional double‑freq glitches
    if (lastFreq && Math.abs(f - 2*lastFreq)/f < OCT_TOL) {
      lastFreq = f / 2;
    } else {
      lastFreq = f;
    }
    return lastFreq;
  }

  onDestroy(() => {
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function' && raf !== null) {
      window.cancelAnimationFrame(raf);
    }
    ctx?.close();
  });

  const GREEN = '#16a34a';
  const markNoteGreen = (n: StaveNote) => n.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });


  function clearStaffContainer() {
  if (!vfDiv) return;
  // This removes **everything**, even if the previous renderer
  // sneaked extra nodes next to the <svg>.
  while (vfDiv.firstChild) vfDiv.removeChild(vfDiv.firstChild);
}


function calcStaveWidth(ns: StaveNote[], accCount: number): number {
  const BASE = 120;               // clef + key sig + time sig block
  const PER_ACC = 18;             // each accidental

  /* width “price-list” per duration -------------------------- */
  const DUR_W: Record<string, number> = {
    h: 90,        // half-note (big oval + stem)
    q: 60,        // quarter
    "8": 75       // eighth (flag needs extra space)
  };

  const noteW = ns.reduce((px, n) => {
    const key = n.getDuration();          // 'h' | 'q' | '8'
    return px + (DUR_W[key] ?? 60);       // fall-back = quarter width
  }, 0);

  return BASE + noteW + PER_ACC * accCount + 20;  // +20 px right-hand pad
}

const MARGIN = 20;             // px on each side of the bar

/* ------------------------------------------------------------ */
/* renderStaff()  (do the identical tweak in renderAnalysisLine)*/
/* ------------------------------------------------------------ */
function measureLead(ctx: RenderContext, beats: number) {
  // A scratch stave that we never draw – just to ask VexFlow for metrics
  const ghost = new Stave(0, 0, 0)
                  .addClef(selectedClef)
                  .addTimeSignature(`${beats}/4`)
                  .addKeySignature(currentKeySig)
                  .setContext(ctx);
  return ghost.getNoteStartX() - ghost.getX();     // px
}

/* ------------------------------------------------------------ */
/* inside renderStaff()   (identical logic in renderAnalysisLine)*/
/* ------------------------------------------------------------ */
function renderStaff(beats: number): void {
  if (!vfDiv) return;

  /* Build the Voice first ------------------------------------ */
  const voice = new Voice({ numBeats: beats, beatValue: 4 })
                  .addTickables(notes);

  /* 1️⃣  ask VexFlow for the true minimum width --------------- */
  const fmt = new Formatter();
  fmt.joinVoices([voice])              // (or fmt.preCalculateMinTotalWidth)
     .format([voice], 0);              // 0 ⇒ no justification yet
  const minWidth = fmt.getMinTotalWidth();   // px

  /* 2️⃣  keep your heuristic as a floor ----------------------- */
  const width = calcStaveWidth(
    notes,
    accidentalCount(currentKeySig)
  );


  /* 3️⃣  draw exactly as before ------------------------------- */
  vfDiv.innerHTML = '';
  const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
  renderer.resize(width, 140);
  const ctx   = renderer.getContext();

  const stave = new Stave(10, 20, width)
                  .addClef(selectedClef)
                  .addTimeSignature(`${beats}/4`)
                  .addKeySignature(currentKeySig);
  stave.setContext(ctx).draw();

  Accidental.applyAccidentals([voice], currentKeySig);
  new Formatter().joinVoices([voice]).format([voice], width - 60);
  voice.draw(ctx, stave);

  Beam.generateBeams(notes).forEach(b => b.setContext(ctx).draw());
}



  const NOTE_LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
  function randomNote(): string {
  const OCTAVES = CLEF_RANGES[selectedClef];

  /* 1. choose diatonic vs chromatic ------------------------ */
  const ACC_P = 0.15;               // ← 15 % chance of an accidental
  const root  = Math.random() > ACC_P          /* diatonic 85 % */
    ? NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)]
    : (() => {                                  /* chromatic 15 % */
        const letter = NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)];
        const acc    = Math.random() < 0.5 ? '#' : 'b';
        return `${letter}${acc}`;
      })();

  const octave  = OCTAVES[Math.floor(Math.random() * OCTAVES.length)];

  /* 2. spell for the key */
  const sel     = km.selectNote(root);          // { note:'d#', accidental:'#', change:true }
  const keyStr  = `${sel.note}/${octave}`;      // "d#/4"

  /* pretty text used for comparison */
  const pretty  = sel.accidental
      ? `${sel.note[0].toUpperCase()}${sel.accidental === '#' ? '♯' : '♭'}${octave}`
      : `${sel.note.toUpperCase()}${octave}`;

  line.push(pretty);
  target.push(canon(pretty));
  return keyStr;                                // defer StaveNote construction
}



function generateRandomLine() {
   msreCount = -1;
   line = []; target = []; i = 0;

   currentKeySig = resolveKey();
   km = new KeyManager(currentKeySig);
  /* ----- create a single 4/4 measure with mixed values --------------- */
  notes = [];
  let beatsLeft = MEASURE_BEATS;

  while (beatsLeft > 0) {
    // only choose values that still fit
    const choice = pickWeighted(
      DURATIONS.filter(d => d.beats <= beatsLeft)
    );
    beatsLeft -= choice.beats;

    const keyStr  = randomNote();                       // pushes to line[] / target[]
    const note    = new StaveNote({                     // e.g. dur: '8', 'q', 'h'
      keys: [keyStr],
      duration: choice.dur,
     clef: selectedClef
   });

    const sel = km.getAccidental(keyStr.split('/')[0]);
    if (sel?.change && sel.accidental) {
      note.addModifier(new Accidental(sel.accidental), 0);
    }
    notes.push(note);
  }

  renderStaff(MEASURE_BEATS);    // ‹── pass real beat count
 }




function canon(s: string): number {
  const m = s.match(/^([A-Ga-g])([#♯b♭]?)(\d)$/);
  if (!m) throw new Error(`Bad note: ${s}`);

  const letter = m[1].toUpperCase();
  const acc    = m[2];
  const oct    = +m[3];

  const BASE: Record<string, number> = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  let semitone = BASE[letter];

  if (acc === '#' || acc === '♯') semitone += 1;
  else if (acc === 'b' || acc === '♭') semitone -= 1;

  return (oct + 1) * 12 + semitone;   // standard MIDI numbering
}
function isRealNote(n: string): boolean {
  return /^[A-G][#♯b♭]?\d$/.test(n);
}

  function isClearlyDifferent(a: number, b: number) { return Math.abs(a - b) / b > 0.10; }

  let matchedFreq = 0;
  let gate: 'READY' | 'WAIT_NEXT' | 'WAIT_ATTACK' = 'READY';
  let i = 0;
  function tick(): void {
    if (!running) return;

    analyser.getFloatTimeDomainData(buf);
    const p = detect(buf);

    if (p > 0) {
      hist.push(p);
      if (hist.length > HIST) hist.shift();
      const mid = [...hist].sort((a,b)=>a-b)[Math.floor(hist.length/2)];
      if (!(lastGoodFreq && isSubHarmonic(mid, lastGoodFreq))) {
        freq = Math.round(mid);
        note = f2n(mid);
        lastGoodFreq = mid;
        lastHeard = Date.now();
      }
    } else if (Date.now() - lastHeard > HOLD_MS) {
      freq = 0;
      note = '--';
    }

    switch (gate) {
      case 'READY':
  
        if (isRealNote(note) && canon(note) === target[i]) {
          markNoteGreen(notes[i]);
          matchedFreq = freq;
          i++;
          renderStaff(notes.length);
          if (i === notes.length){
            if (msreCount == -1){
              generateRandomLine();
            }
            else {
              if (msreCount == totalMsre-1){
                console.log("done")
              }
              else{
                msreCount++
                renderAnalysisLine()
              }
            }
          }
          gate = 'WAIT_NEXT';
        }

        break;
      case 'WAIT_NEXT':
        if (loudness < minDb) gate = 'WAIT_ATTACK';
        else if (freq && matchedFreq && isClearlyDifferent(freq, matchedFreq)) gate = 'READY';
        break;
      case 'WAIT_ATTACK':
        if (loudness >= minDb) gate = 'READY';
        break;
    }
    raf = requestAnimationFrame(tick);
  }

  /* ─── helper: draw each measure on its own staff ────────────────────────── */


  let userInput = ''
  let analysisTxt = `

Composer: Traditional
Title: Hot Cross Buns – melody line
Analyst: ChatGPT demo

Time Signature: 4/4

m1 C: C4 D4 E4
m2 C: E4 D4 C4

`
  let xmlText:string = ""
  let measures: any
  function getMusicXML() {   
    console.log(selectedClef)
    measures = parseMusicXML(xmlText, selectedClef);
    console.log(measures)
  }

  async function setSong(song:string, preset:boolean){
    if (preset){
      const filed = '/scores/' + song + '.musicxml'
      analysisTxt = filed
      xmlText  = await fetch(analysisTxt).then(r => r.text());
    }
    else {
      xmlText = userInput
    }
    
    msreCount = -1
    renderAnalysisLine()
  }


  /* 3 ─── render the first staff described in the parsed data */
  async function renderAnalysisLine() {
  if (msreCount == -1 || measures == undefined){
    msreCount = 0;
    await getMusicXML()
  }
    if (!measures.length) return alert('Nothing parsed');
  
  // grab every chord from the FIRST measure
  
  
  totalMsre = measures.length;
  notes         = measures[msreCount].notes;          // could be 1, 2, … chords
  currentKeySig = measures[msreCount].key.split(' ')[0];
  km            = new KeyManager(currentKeySig);
  line = []
  target = []
  console.log(notes)
  console.log(notes[0].keys[0])
  for (let x = 0; x < notes.length; x++) {
    line.push(notes[x].keys[0].replace('/', ''))
    target.push(canon(notes[x].keys[0].replace('/', '')))
  }
  i = 0
  console.log(line)
  // ─── ADAPT THE VOICE & STAVE TO NOTE COUNT ───
  const beats   = notes.length;               // 1 chord → 1 beat
  const voice   = new Voice({ numBeats: beats, beatValue: 4 })
                    .addTickables(notes);

  // rebuild stave with matching time-signature
  const accCnt  = accidentalCount(currentKeySig);
  const width   = calcStaveWidth(notes, accCnt);

  vfDiv.innerHTML = '';
  const renderer  = new Renderer(vfDiv, Renderer.Backends.SVG);
  renderer.resize(width + 40, 140);
  const ctx       = renderer.getContext();

  const stave = new Stave(10, 20, width)
                 .addClef(selectedClef)
                 .addTimeSignature(`${beats}/4`)   // ← dynamic
                 .addKeySignature(currentKeySig);

  stave.setContext(ctx).draw();
  Accidental.applyAccidentals([voice], currentKeySig);

  new Formatter().joinVoices([voice]).format([voice], width - 60);
  voice.draw(ctx, stave);
}

async function clefchanged(){
  if (msreCount == -1){
    console.log("renderedstaff")
    generateRandomLine()
  }
  else {
    console.log("changeanalysisline")
    await getMusicXML()
    renderAnalysisLine()
  }
}

  /* ----------  DOM refs ---------- */
  let vfDiv: HTMLDivElement;


  let bpm = 120;              // user-adjustable tempo
let metroOn = false;        // is the metronome running?
let tickInterval: number | null = null;

let beatsPerBar = 4;                   // used by metronome
let metroIdx = 0;   

/* single click “beep” */
function playClick(accent = false) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;   // higher pitch on beat-1
  gain.gain.value     = accent ? 0.35  : 0.20;  // louder on beat-1
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.05);
}

function metronomeTick() {
  playClick(metroIdx === 0);           // accent the first beat
  metroIdx = (metroIdx + 1) % beatsPerBar;
}

/* start / stop helpers */
function startMetronome() {
  stopMetronome();          // clear any old interval
  metroIdx = 0;             // restart the bar
  metronomeTick();          // immediate first click
  tickInterval = window.setInterval(metronomeTick, 60000 / bpm);
  metroOn = true;
}

function stopMetronome() {
  if (tickInterval !== null) clearInterval(tickInterval);
  tickInterval = null;
  metroOn = false;
}
function toggleMetronome() {            // button handler
  metroOn ? stopMetronome() : startMetronome();
}

/* if BPM changes while it’s running, reschedule automatically */
$: if (metroOn) {
  stopMetronome();
  startMetronome();
}

/* DON’T FORGET: clean up onDestroy */
onDestroy(() => {
  stopMetronome();                      // silence clicks when leaving
});

function tsChanged() {
  const opt = TS_OPTIONS.find(o => o.label === selectedTS);
  if (opt) {
    beatsPerBar = opt.beats;  // tells metronome how many clicks per bar
    metroIdx = 0;             // restart bar so accent lands correctly
  }
}

</script>

<div class="flex flex-col items-center justify-center h-screen gap-6 text-center">
  <h1 class="text-3xl font-bold">Ethan's Music Buddy</h1>

  <!-- Clef picker -->
  <label class="flex items-center gap-2">
    <span class="text-sm">Clef:</span>
    <select bind:value={selectedClef} on:change={clefchanged} class="rounded border px-2 py-1">
      {#each CLEFS as c}
        <option value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
      {/each}
    </select>
  </label>

  <label class="flex items-center gap-2">
    <span class="text-sm">Key&nbsp;Sig:</span>
    <select
      bind:value={selectedKeySig}
      on:change={generateRandomLine}
      class="rounded border px-2 py-1"
    >
      {#each KEY_SIGS as ks}
        <option value={ks.value}>{ks.label}</option>
      {/each}
    </select>
  </label>

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
    <input type="range" min="-60" max="-10" step="1" bind:value={minDb} class="w-64 accent-blue-500" />
  </label>

  <div class="text-xs opacity-70">current loudness: {loudness.toFixed(1)} dBFS</div>
  <footer class="text-xs opacity-60">buncha updates soon for variety soon</footer>
  <!-- textarea + new button -->

  <div class="flex items-center gap-3 mt-3">

    <!-- BPM -->
    <label class="flex items-center gap-1 text-sm">
      BPM:
      <input
        type="number"
        min="40" max="240" step="1"
        bind:value={bpm}
        class="w-20 rounded border px-1 text-center"
      />
    </label>
  
    <!-- Start / Stop -->
    <button
      on:click={toggleMetronome}
      class="rounded-md bg-green-600 px-4 py-2 text-white"
    >
      {metroOn ? 'Stop' : 'Start'} Metronome
    </button>
  
    <!-- Time-Signature -->
    <label class="flex items-center gap-1 text-sm">
      Time Sig:
      <select bind:value={selectedTS} on:change={tsChanged}
              class="rounded border px-2 py-1">
        {#each TS_OPTIONS as o}
          <option value={o.label}>{o.label}</option>
        {/each}
      </select>
    </label>
  </div>



<div class="w-full mt-8 border-t bg-gray-50 p-4 flex gap-4">

  <!-- ◀ Left side: free-form input -->
  <div class="flex-1 flex flex-col">
    <textarea
      bind:value={userInput}
      rows="4"
      class="flex-1 w-full rounded border p-2 text-xs resize-none"
      placeholder="Paste AugmentedNet or MusicXML here…">
    </textarea>
    <button
      on:click={() => setSong("", false)}
      class="mt-2 self-end rounded bg-blue-600 px-4 py-1 text-white">
      Render Input
    </button>
  </div>

  <!-- ▶ Right side: presets (no handlers yet) -->
  <div class="flex-1 flex flex-col justify-start gap-2">
    <button 
      on:click={() => setSong('hot-cross-buns', true)}
      class="w-full rounded bg-purple-500 px-4 py-2 text-white">
      Hot Cross Buns
    </button>
    <button 
      on:click={() => setSong('twinkle-twinkle-little-star', true)}
      class="w-full rounded bg-purple-500 px-4 py-2 text-white">
      Twinkle Twinkle
    </button>
    <button 
      on:click={() => setSong('mary-had-a-little-lamb', true)}
      class="w-full rounded bg-purple-500 px-4 py-2 text-white">
      Mary Had a Little Lamb
    </button>
  </div>

</div>
</div>
