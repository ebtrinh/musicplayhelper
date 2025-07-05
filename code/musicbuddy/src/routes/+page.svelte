<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { YIN } from 'pitchfinder';
  import { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, KeyManager } from 'vexflow';

  /* --- constants & helpers --- */
  const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const CLEFS = ['bass','alto','treble'] as const;
  type Clef = typeof CLEFS[number];
  let selectedClef: Clef = 'alto';

  // Octave ranges roughly centred on each clef
  const CLEF_RANGES: Record<Clef, number[]> = {
    bass:   [2,3],   // C2–B3
    alto:   [3,4],   // G3–F5
    treble: [4,5]    // E4–C6
  };

  const HIST = 5;
  const HOLD_MS = 3000;
  const BUF_SIZE = 4096;              // ≈ 93 ms @ 44.1 kHz

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

function calcStaveWidth(noteCount: number, accCount: number): number {
  const BASE   = 120;   // clef + time sig
  const PER_Q  = 70;    // each quarter note
  const PER_ACC = 18;   // each accidental glyph needs ~18 px

  return BASE + PER_Q * noteCount + PER_ACC * accCount;
}

function renderStaff(): void {
  if (!vfDiv) return;

  const accCnt = accidentalCount(currentKeySig);
  const width  = calcStaveWidth(notes.length, accCnt);

  vfDiv.innerHTML = '';
  const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
  renderer.resize(width + 40, 140);
  const ctx = renderer.getContext();

  const stave = new Stave(10, 20, width)
    .addClef(selectedClef)
    .addTimeSignature('8/4')
    .addKeySignature(currentKeySig);
  stave.setContext(ctx).draw();

  const voice = new Voice({ numBeats: 8, beatValue: 4 }).addTickables(notes);
  Accidental.applyAccidentals([voice], currentKeySig);

  new Formatter().joinVoices([voice]).format([voice], width - 60);
  voice.draw(ctx, stave);
}



  const NOTE_LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
  function randomNote(): string {
  const OCTAVES = CLEF_RANGES[selectedClef];

  /* 1. choose diatonic vs chromatic */
  const pick  = Math.random();
  const root  = pick < 0.65
    ? NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)]
    : (() => {
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
  line = [];
  target = [];
  i = 0;

  currentKeySig = resolveKey();
  km = new KeyManager(currentKeySig);

  /* ----- create 8 StaveNotes ---------------------------------------- */
  notes = Array.from({ length: 8 }, () => {
    const key   = randomNote();                 // pushes into line[] / target[]
    const note  = new StaveNote({ keys:[key], duration:'q', clef:selectedClef });

    // attach accidental only if KeyManager says it's new
    const sel = km.getAccidental(key.split('/')[0]);   // helper to peek current accidental
    if (sel?.change && sel.accidental) {
      note.addModifier(new Accidental(sel.accidental), 0);   // correct arg order
    }
    return note;
  });

  const accCnt = accidentalCount(currentKeySig);
  const width  = calcStaveWidth(notes.length, accCnt);

  vfDiv.innerHTML = '';
  const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
  renderer.resize(width + 40, 140);   // 20-px side margins
  const ctx = renderer.getContext();

  const stave = new Stave(10, 20, width)
    .addClef(selectedClef)
    .addTimeSignature('8/4')
    .addKeySignature(currentKeySig);
  stave.setContext(ctx).draw();

  const voice = new Voice({ numBeats: 8, beatValue: 4 }).addTickables(notes);
  Accidental.applyAccidentals([voice], currentKeySig);

  new Formatter().joinVoices([voice]).format([voice], width - 60);
  voice.draw(ctx, stave);
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
        //console.log(note, line[i]);
        //console.log(isRealNote(note), canon(note), target[i])
        if (isRealNote(note) && canon(note) === target[i]) {
          markNoteGreen(notes[i]);
          matchedFreq = freq;
          i++;
          renderStaff();
          if (i === notes.length){
            generateRandomLine();
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

  /* ----------  DOM refs ---------- */
  let vfDiv: HTMLDivElement;
</script>

<div class="flex flex-col items-center justify-center h-screen gap-6 text-center">
  <h1 class="text-3xl font-bold">Ethan's Music Buddy</h1>

  <!-- Clef picker -->
  <label class="flex items-center gap-2">
    <span class="text-sm">Clef:</span>
    <select bind:value={selectedClef} on:change={generateRandomLine} class="rounded border px-2 py-1">
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
</div>
