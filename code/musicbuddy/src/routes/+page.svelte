<!-- Google tag (gtag.js) -->
<!-- <script async src="https://www.googletagmanager.com/gtag/js?id=G-M8YCNKB6FZ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-M8YCNKB6FZ');
</script> -->

<script lang="ts">
  // Google Analytics
  import { onMount, onDestroy } from 'svelte';
  import { YIN } from 'pitchfinder';
  import { Renderer, RenderContext, Stave, StaveNote, Voice, Formatter, Accidental, KeyManager, Beam } from 'vexflow';
  import { parseMusicXML, type MeasureData } from './analysisToStave';
  import { supabase } from '$lib/supabaseClient';
  import Metronome from './Metronome.svelte';
  import PianoKeyboard from './PianoKeyboard.svelte';
  import JSZip from 'jszip';

  const GA_ID = 'G-M8YCNKB6FZ';

// Type helpers (optional, keeps TS happy)
// drop all `declare global` stuff and use this instead

type GAQueued = { action: string; params: Record<string, any> };

function getWin(): (Window & {
  gtag?: (...args: any[]) => void;
  __gaQueue?: GAQueued[];
}) | undefined {
  return typeof window === 'undefined' ? undefined : (window as any);
}

function gaEvent(action: string, params: Record<string, any> = {}) {
  const w = getWin();
  if (!w) return; // SSR guard
  if (typeof w.gtag === 'function') {
    w.gtag('event', action, params);
  } else {
    (w.__gaQueue ||= []).push({ action, params });
  }
}

// flush queued events once mounted (and gtag exists)
onMount(() => {
  const w = getWin();
  if (w?.gtag && w.__gaQueue?.length) {
    for (const e of w.__gaQueue) w.gtag('event', e.action, e.params);
    w.__gaQueue = [];
  }
});



  /* --- constants & helpers --- */
  const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const CLEFS = ['bass','alto','treble'] as const;
  const MIN_FREQ = 40;
  const MAX_FREQ = 1200;
  const THRESH   = 0.07;
  const PROB_MIN = 0.90;
  const OCT_TOL  = 0.03;
  const f2n = (f:number)=>`${NOTES[Math.round(12*Math.log2(f/440)+69)%12]}${Math.floor((Math.round(12*Math.log2(f/440)+69))/12)-1}`;
  const rms2db = (r:number)=>20*Math.log10(r||1e-10);

  let   lastFreq = 0;
  type Clef = typeof CLEFS[number];
  let selectedClef: Clef = 'treble';
  let msreCount = -1;
  let totalMsre = 0;
  
  /* ---------- DOM refs ---------- */
  let vfDiv: HTMLDivElement | undefined;

  let freq = 0, note = '--';
  let loudness = -Infinity, minDb = -35;
  let lastHeard = 0;
  let line: string[] = [];
  let target: number[] = [];
  let enableHalves  = true;
  let enableEighths = true;
  let useKeyOnly = false;
  let bpm = 120;
  // sub-toggles (you already have these)
let allowNaturals = true;
let allowSharps   = true;
let allowFlats    = true;

  // Mode system
  let randomSongMode = false; // false = Random Note Mode, true = Random Song Mode
  let autoNext = false; // Controls auto-advance behavior
  let currentSongTitle = '';
  let currentSongComposer = '';
  
  // Dropdown visibility
  let showSongDropdown = false;
  let showNoteDropdown = false;



// track the in-bar state for each letter+octave
type AccType = 'nat' | 'sh' | 'fl';
let barLedger: Record<string, AccType> = {};


const accFromKey = (L: string): AccType => {
  if (!km) return 'nat'; // Safety guard for uninitialized KeyManager
  const a = km.selectNote(L).accidental as '#'|'b'|undefined;
  return a === '#' ? 'sh' : a === 'b' ? 'fl' : 'nat';
};
const getLedger = (L: string, o: number): AccType =>
  barLedger[`${L}${o}`] ?? accFromKey(L);
const setLedger = (L: string, o: number, t: AccType) => {
  barLedger[`${L}${o}`] = t;
};

function beatsFromNotes(ns: StaveNote[]) {
  // VexFlow durations can be 'q','h','8','qr','8r', etc. Strip the 'r' if present.
  const toBeat = (dur: string) => {
    const d = dur.replace('r','');   // rest or not, both count the same for timing
    if (d === 'w') return 4;
    if (d === 'h') return 2;
    if (d === 'q') return 1;
    if (d === '8') return 0.5;
    if (d === '16') return 0.25;
    if (d === '32') return 0.125;
    // fallback: treat unknown as a quarter
    return 1;
  };
  return ns.reduce((sum, n) => sum + toBeat(n.getDuration()), 0);
}

// choose an integer TS top number to draw (you can refine later)
function normalizeBeats(b: number) {
  // Snap near-integers. If you ever do compound meters, you can draw 6/8 etc.
  const snapped = Math.round(b * 2) / 2;
  return Math.max(1, Math.round(snapped));
}


  let running = false;
  let notes: StaveNote[] = [];

  let lastGoodFreq = 0;


  const CLEF_RANGES: Record<Clef, number[]> = {
    bass:   [2,3],   // C2–B3
    alto:   [3,4],   // G3–F5
    treble: [4,5]    // E4–C6
  };

  const DURATIONS = [
    { dur: 'h', beats: 2,   w: 1 },
    { dur: 'q', beats: 1,   w: 3 },
    { dur: '8', beats: 0.5, w: 1 }
  ] as const;

  function activeDurations(beatsLeft: number) {
    return DURATIONS.filter(d =>
      d.beats <= beatsLeft &&
      (
        d.dur === 'q' ||
        (d.dur === 'h' && enableHalves) ||
        (d.dur === '8' && enableEighths)
      )
    );
  }

  /* ---------- Auth (Supabase) ---------- */
  let userEmail: string = '';
  let emailInput: string = '';

  onMount(async () => {
    const { data } = await supabase.auth.getSession();
    userEmail = data.session?.user?.email ?? '';
    supabase.auth.onAuthStateChange((_event, session) => {
      userEmail = session?.user?.email ?? '';
    });
    if (typeof window === 'undefined') return;
    try {
      if ('fonts' in document) {
        await (document as any).fonts.ready;
      }
    } catch {}
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    generateRandomLine();
  });

  // Close dropdowns when clicking outside
  onMount(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.mode-dropdown')) {
        showSongDropdown = false;
        showNoteDropdown = false;
      }
    };
    document.addEventListener('click', handleClickOutside);
    
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  });

  async function signInWithEmail() {
    gaEvent('sign_in_press', { method: 'email_magic_link' });
    if (!emailInput) return alert('Enter an email first');
    const { error } = await supabase.auth.signInWithOtp({ email: emailInput });
    if (error) alert(error.message);
    else alert('Magic link sent — check your email and click it.');
  }

  async function signOut() {
    await supabase.auth.signOut();
  }



  /* ---------- audio/pitch ---------- */
  const MEASURE_BEATS = 4;       // 4/4
  const HIST = 5;
  const HOLD_MS = 3000;
  const BUF_SIZE = 4096;
  let currentBeats = MEASURE_BEATS; // live beats for the active measure

  const TS_OPTIONS = [
    { label: '2/4', beats: 2 },
    { label: '3/4', beats: 3 },
    { label: '4/4', beats: 4 },
    { label: '6/8', beats: 6 }
  ];
  let selectedTS = TS_OPTIONS[2].label;

  let km: KeyManager;

  const KEY_SIGS = [
    { value: 'random', label: 'Random' },
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

  let selectedKeySig  = 'random';
  let currentKeySig   = 'C';

  function resolveKey(): string {
    return selectedKeySig === 'random'
      ? KEY_SIGS[Math.floor(Math.random() * (KEY_SIGS.length - 1)) + 1].value
      : selectedKeySig;
  }

  function accidentalCount(key: string): number {
    const root = key.replace(/m$/i, '');
    const SHARPS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
    const FLATS  = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
    const si = SHARPS.indexOf(root); if (si !== -1) return si;
    const fi = FLATS.indexOf(root);  if (fi !== -1) return fi;
    return 0;
  }

  // remove any accidental glyphs already attached to notes
  function stripAccidentalsFromNotes(ns: StaveNote[]) {
  (ns as any[]).forEach(n => {
    // remove any accidental-like modifier (covers v3/v4 categories)
    n.modifiers = (n.modifiers ?? []).filter((m: any) => {
      const cat = m?.getCategory?.();
      const ctor = m?.constructor?.name;
      const looksAcc =
        cat === 'accidentals' || cat === 'accidental' ||
        ctor === 'Accidental' ||
        // some builds expose a "code" or "type" field
        m?.code === 'accidental' || m?.type === 'n' || m?.type === '#' || m?.type === 'b';
      return !looksAcc;
    });
    // some builds stash a field directly (belt & suspenders)
    if ('accidental' in (n as any)) (n as any).accidental = undefined;
  });
}


// add only the sharp/flat that is explicitly in the key string (e.g. "f#/4" or "bb/4")
function addAccidentalsFromKeys(ns: StaveNote[]) {
  (ns as any[]).forEach(n => {
    // remove any existing accidental modifiers first
    n.modifiers = (n.modifiers ?? []).filter(
      (m: any) => m?.getCategory?.() !== 'accidentals'
    );

    const raw  = n.getKeys()[0];          // e.g. "f#/4", "eb/4", "b/4"
    const root = raw.split('/')[0];       // "f#", "eb", "b"

    // only match ONE accidental char right after the letter
    const m = root.match(/^[a-g]([#b])$/i);
    const acc = m ? m[1] : null;          // '#', 'b', or null

    if (acc) n.addModifier(new Accidental(acc), 0);
  });
}


function hasNaturalGlyph(ns: StaveNote[]): boolean {
  for (const n of ns as any[]) {
    for (const m of n.modifiers ?? []) {
      // VexFlow Accidental has .type === 'n' for naturals
      if (m?.getCategory?.() === 'accidentals' && (m.type === 'n' || m.accidental === 'n')) {
        return true;
      }
    }
  }
  return false;
}
  
  let ctx:AudioContext, analyser:AnalyserNode;
  const buf = new Float32Array(BUF_SIZE), hist:number[] = [];
  

  
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
    if (typeof window === 'undefined') return;
    generateRandomLine();
  });

  // Microphone permission flow
  let micEnabled = false;
  let micError = '';
  let pianoKeyboardVisible = false;
  async function enableMic() {
    micError = '';
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
      micEnabled = true;
      raf = window.requestAnimationFrame(tick);
    } catch (e) {
      micError = 'Microphone permission denied. Enable mic in your browser settings and try again.';
      micEnabled = false;
      running = false;
    }
  }

  function detect(buf: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    loudness = rms2db(Math.sqrt(sum / buf.length));

    const f = yinDetect(buf);
    if (f == null || f < MIN_FREQ || f > MAX_FREQ) return -1;

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
  const markNoteGreen = (n: StaveNote) => {
    try {
      // Safely set the note style
      if (n && typeof n.setStyle === 'function') {
        n.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });
      }
    } catch (error) {
      console.warn('Error marking note green:', error);
    }
  };

  function calcStaveWidth(ns: StaveNote[], accCount: number): number {
    const BASE = 120;
    const PER_ACC = 18;
    const DUR_W: Record<string, number> = { h: 90, q: 60, "8": 75 };
    const noteW = ns.reduce((px, n) => {
      const key = n.getDuration();
      return px + (DUR_W[key] ?? 60);
    }, 0);
    return BASE + noteW + PER_ACC * accCount + 20;
  }

  const MARGIN = 20;

  function measureLead(ctx: RenderContext, beats: number) {
    const ghost = new Stave(0, 0, 0)
      .addClef(selectedClef)
      .addTimeSignature(`${beats}/4`)
      .addKeySignature(currentKeySig)
      .setContext(ctx);
    return ghost.getNoteStartX() - ghost.getX();
  }

  function renderStaff(beats: number): void {
    if (!vfDiv) return;
    if (!notes || notes.length === 0) return;

    try {
      console.log('renderStaff():', { mode: msreCount === -1 ? 'random' : 'analysis', beatsArg: beats, currentBeats });
      const voice = new Voice({ numBeats: beats, beatValue: 4 });
      // Avoid strict timing errors if rounding creates tiny mismatches
      if ((voice as any).setStrict) {
        (voice as any).setStrict(false);
      } else if ((voice as any).setMode && (Voice as any).Mode) {
        (voice as any).setMode((Voice as any).Mode.SOFT);
      }
      voice.addTickables(notes);

      const fmt = new Formatter();
      fmt.joinVoices([voice]).preFormat();
      const minNotesWidth = fmt.getMinTotalWidth();

      vfDiv.innerHTML = '';
      const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
      renderer.resize(10, 140);
      const ctx = renderer.getContext();

      const leadIn = measureLead(ctx, beats);
      const accCnt = accidentalCount(currentKeySig);
      const heuristic = calcStaveWidth(notes, accCnt);
      const width = Math.ceil(Math.max(heuristic, minNotesWidth + leadIn + 20));

      renderer.resize(width, 140);
      // Make SVG responsive: set viewBox and fluid size
      const svgRoot = vfDiv.querySelector('svg');
      if (svgRoot) {
        svgRoot.setAttribute('viewBox', `0 0 ${width} 140`);
        svgRoot.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        (svgRoot as SVGSVGElement).style.width = '100%';
        (svgRoot as SVGSVGElement).style.height = 'auto';
        (svgRoot as SVGSVGElement).style.display = 'block';
      }
      const stave = new Stave(10, 20, width)
        .addClef(selectedClef)
        .addTimeSignature(`${beats}/4`)
        .addKeySignature(currentKeySig);

      stave.setContext(ctx).draw();
      
      // BEFORE you format/justify the voice
      if (useKeyOnly) {
        // identical to your key-only fix: no glyphs at all
        stripAccidentalsFromNotes(notes);
      } else if (!allowNaturals) {
        // SAME IDEA as key-only: don't let VexFlow auto anything.
        // We add only sharps/flats that are explicitly part of the note text.
        stripAccidentalsFromNotes(notes);
        addAccidentalsFromKeys(notes);
      } else {
        // Normal behavior when naturals are allowed
        Accidental.applyAccidentals([voice], currentKeySig);
      }

      new Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);

      const beams = Beam.generateBeams(notes);
      hideFlagsForBeamedNotes(beams as any);
      beams.forEach(b => b.setContext(ctx).draw());
    } catch (error) {
      console.error('Error rendering staff:', error);
      // Fallback: try to render a simple version
      try {
        vfDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: #666;">Error rendering staff. Please try generating a new one.</div>';
      } catch (fallbackError) {
        console.error('Fallback rendering also failed:', fallbackError);
      }
    }
  }

  const NOTE_LETTERS = ['c','d','e','f','g','a','b'];

  type Alter = 'none' | 'natural' | 'sharp' | 'flat';

  function randomNote(): string {
  const OCTS = CLEF_RANGES[selectedClef];
  const octave = OCTS[Math.floor(Math.random()*OCTS.length)];
  const letter = NOTE_LETTERS[Math.floor(Math.random()*NOTE_LETTERS.length)];

  if (useKeyOnly) {
    const sel = km.selectNote(letter); // for pretty/target only
    const pretty = sel.accidental
      ? `${sel.note[0].toUpperCase()}${sel.accidental === '#' ? '♯' : '♭'}${octave}`
      : `${sel.note.toUpperCase()}${octave}`;
    line.push(pretty); target.push(canon(pretty));
    return `${letter}/${octave}`; // bare, no glyphs; key sig defines pitch
  }

  // Build allowed alterations
  const alts: Array<'none'|'sharp'|'flat'|'natural'> = ['none'];
  if (allowSharps) alts.push('sharp');
  if (allowFlats)  alts.push('flat');
  if (allowNaturals) alts.push('natural');

  // pick one
  const choice = alts[Math.floor(Math.random()*alts.length)];

  // choose root according to choice
  const root =
    choice === 'sharp'   ? `${letter}#` :
    choice === 'flat'    ? `${letter}b` :
    /* 'none' or 'natural' */            letter;

  // for pretty/target
  const sel = km.selectNote(root);
  const pretty = sel.accidental
    ? `${sel.note[0].toUpperCase()}${sel.accidental === '#' ? '♯' : '♭'}${octave}`
    : `${sel.note.toUpperCase()}${octave}`;
  line.push(pretty); target.push(canon(pretty));

  // key string to VexFlow
  return `${root}/${octave}`;
}

  function generateRandomLine() {
    // tiny local helpers
    const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
    const stripAccidentals = (ns: StaveNote[]) => {
      (ns as any[]).forEach(n => {
        n.modifiers = (n.modifiers ?? []).filter((m: any) => m?.getCategory?.() !== 'accidentals');
      });
    };
    const containsNatural = (ns: StaveNote[]) => {
      for (const n of ns as any[]) {
        for (const m of n.modifiers ?? []) {
          const t = m?.type ?? m?.accidental ?? m?.code ?? '';
          if (t === 'n' || t === 'N' || (typeof t === 'string' && t.toLowerCase().includes('natural'))) return true;
        }
      }
      return false;
    };

    // remember previous measure first target to avoid carry-over match
    prevTargetFirst = target.length ? target[0] : null;
    msreCount = -1;
    line = []; target = []; i = 0;
    gate = 'WAIT_ATTACK'; // force a fresh note attack for new measure
    matchedFreq = 0; // avoid carry-over matching across measures
    lastNoteTime = 0;
    haveGoneQuiet = false;

  currentKeySig = resolveKey();
  km = new KeyManager(currentKeySig);

  const OCTS = CLEF_RANGES[selectedClef];
  const keyAcc: Record<string, '#'|'b'|undefined> =
    Object.fromEntries(NOTE_LETTERS.map(L => [L, km.selectNote(L).accidental as any]));

  const MAX_OUTER = 40;                 // whole-bar retries
  for (let attempt = 0; attempt < MAX_OUTER; attempt++) {
    barLedger = {};
    notes = []; line = []; target = []; i = 0;

    let beatsLeft = MEASURE_BEATS;
    while (beatsLeft > 0) {
      const options  = activeDurations(beatsLeft);
      const pickFrom = options.length ? options : DURATIONS.filter(d => d.dur === 'q');
      const choice   = pickWeighted(pickFrom);
      beatsLeft -= choice.beats;

      // choose a note that respects toggles and won't need a ♮ given the ledger
      let keyStr = '';
      let L: string = 'c';
      let o = OCTS[0];
      let resulting: AccType = 'nat';

      const MAX_INNER = 50;
      for (let tries = 0; tries < MAX_INNER; tries++) {
        L = pick(NOTE_LETTERS);
        o = pick(OCTS);

        if (useKeyOnly) {
          const spelled = km.selectNote(L);
          const pretty  = spelled.accidental
            ? `${spelled.note[0].toUpperCase()}${spelled.accidental === '#' ? '♯' : '♭'}${o}`
            : `${spelled.note.toUpperCase()}${o}`;
          line.push(pretty);
          target.push(canon(pretty));
          keyStr    = `${L}/${o}`;            // bare, no glyphs
          resulting = accFromKey(L);
          break;
        }

        // build allowed alteration set
        type Alter = 'none'|'natural'|'sharp'|'flat';
        const allowed: Alter[] = ['none'];
        if (allowNaturals) allowed.push('natural');
        if (allowSharps)   allowed.push('sharp');
        if (allowFlats)    allowed.push('flat');

        const weights: Record<Alter, number> = { none:4, natural:2, sharp:2, flat:2 };
        const pool = allowed.flatMap(t => Array(weights[t]).fill(t));
        const alter = pool[Math.floor(Math.random()*pool.length)] as Alter;

        // letters that actually yield the requested glyph
        let letters = NOTE_LETTERS;
        if (alter === 'natural') {
          letters = NOTE_LETTERS.filter(x => keyAcc[x] === '#' || keyAcc[x] === 'b');
          if (!letters.length) continue; // e.g. C major
          L = pick(letters);
        } else if (alter === 'sharp') {
          letters = NOTE_LETTERS.filter(x => keyAcc[x] !== '#');
          L = pick(letters);
        } else if (alter === 'flat') {
          letters = NOTE_LETTERS.filter(x => keyAcc[x] !== 'b');
          L = pick(letters);
        }

        // what accidental TYPE will this pitch be?
        const desired: AccType =
          alter === 'natural' ? 'nat' :
          alter === 'sharp'   ? 'sh'  :
          alter === 'flat'    ? 'fl'  :
          accFromKey(L);

        // if naturals are OFF, avoid transitions in-bar to NAT on same letter+octave
        const prev = getLedger(L, o);
        if (!allowNaturals && desired === 'nat' && prev !== 'nat') {
          // try another octave (accidentals don't carry across octaves). If none, retry.
          const altO = OCTS.filter(x => x !== o).find(x => getLedger(L, x) === 'nat');
          if (altO) { o = altO; } else { continue; }
        }

        // build keyStr for VexFlow (diatonic → bare letter)
        if (alter === 'none') {
          keyStr = `${L}/${o}`;               // no glyph
        } else if (alter === 'natural') {
          keyStr = `${L}/${o}`;               // will draw ♮ (only if allowed)
        } else if (alter === 'sharp') {
          keyStr = `${L}#/${o}`;
        } else { // flat
          keyStr = `${L}b/${o}`;
        }

        // pretty text & target use the sounding pitch
        const spellRoot = alter === 'sharp' ? `${L}#`
                         : alter === 'flat' ? `${L}b`
                         : L;
        const s2 = km.selectNote(spellRoot);
        const pretty = s2.accidental
          ? `${s2.note[0].toUpperCase()}${s2.accidental === '#' ? '♯' : '♭'}${o}`
          : `${s2.note.toUpperCase()}${o}`;
        line.push(pretty);
        target.push(canon(pretty));

        resulting = desired;
        break;
      }

      // record the in-bar state and add the note
      setLedger(L, o, resulting);
      notes.push(new StaveNote({ keys:[keyStr], duration: choice.dur, clef: selectedClef, autoStem: true }));
    }

    // final guard: simulate accidentals; if naturals appear while disallowed → rebuild
    if (!useKeyOnly && !allowNaturals) {
      const v = new Voice({ numBeats: MEASURE_BEATS, beatValue: 4 }).addTickables(notes);
      Accidental.applyAccidentals([v], currentKeySig);
      const bad = containsNatural(notes);
      stripAccidentals(notes);
      if (bad) continue; // try a new bar
    }

    break; // accept this bar
  }

  currentBeats = MEASURE_BEATS;
  console.log('generateRandomLine(): set currentBeats', currentBeats);
  renderStaff(currentBeats);   
  console.log('📝 Generated random notes:', { line, target, notesCount: notes.length });
  gaEvent('staff_generated', {
  clef: selectedClef,
  key: currentKeySig,
  halves: enableHalves,
  eighths: enableEighths,
  useKeyOnly,
  allowNaturals, allowSharps, allowFlats
});
}




  function pickWeighted<T extends { w: number }>(arr: T[]): T {
    const total = arr.reduce((s, a) => s + a.w, 0);
    let r = Math.random() * total;
    for (const a of arr) {
      if ((r -= a.w) <= 0) return a;
    }
    return arr[arr.length - 1];
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
    return (oct + 1) * 12 + semitone;
  }
  function isRealNote(n: string): boolean {
    return /^[A-G][#♯b♭]?\d$/.test(n);
  }
  function isClearlyDifferent(a: number, b: number) { return Math.abs(a - b) / b > 0.05; }

  let matchedFreq = 0;
  let gate: 'READY' | 'WAIT_NEXT' | 'WAIT_ATTACK' = 'READY';
  let i = 0;
  let lastNoteTime = 0;           // Track when we last matched a note
  const NOTE_TIMEOUT = 2000;      // Force transition after 2 seconds
  let haveGoneQuiet = false;      // Require silence before next attack
  let prevTargetFirst: number | null = null; // first target of previous measure
  let deferNextFrame = false;     // defer evaluation after regenerating measure

  let octRejectStreak = 0;          // how many consecutive subharmonic rejections
const OCT_STREAK_LIMIT = 6;       // accept after ~6 frames (~100–200 ms)
let lastUpdate = 0;               // ms when we last accepted a pitch
const STALE_MS = 1200;            // force accept if display hasn't moved for this long



  function tick(): void {
    if (!running) return;

    analyser.getFloatTimeDomainData(buf);
    const p = detect(buf);

    if (p > 0) {
      hist.push(p);
      if (hist.length > HIST) hist.shift();
      const mid = [...hist].sort((a,b)=>a-b)[Math.floor(hist.length/2)];

      const isSub = lastGoodFreq && isSubHarmonic(mid, lastGoodFreq);
      const stale = Date.now() - lastUpdate > STALE_MS;

      // If it's a subharmonic, allow a few frames of rejection, then accept.
      if (isSub && !stale && octRejectStreak < OCT_STREAK_LIMIT) {
        octRejectStreak++;
        // don't update display, also don't bump lastHeard (so HOLD_MS can still clear)
      } else {
        // accept immediately (either not subharmonic, or we've seen it enough, or UI is stale)
        octRejectStreak = 0;
        freq = Math.round(mid);
        note = f2n(mid);
        lastGoodFreq = mid;
        lastHeard = Date.now();
        lastUpdate = lastHeard;
      }
    } else if (Date.now() - lastHeard > HOLD_MS) {
      freq = 0;
      note = '--';
      octRejectStreak = 0;           // reset the streak on silence
    }

    switch (gate) {
      case 'READY':
        if (isRealNote(note) && canon(note) === target[i]) {
          // additionally, block an immediate match if this is i===0 and equals previous first target
          if (i === 0 && prevTargetFirst !== null && prevTargetFirst === target[0] && !haveGoneQuiet) {
            // wait for genuine new attack
            break;
          }
          const matchedIndex = i;
    const matchedLabel = line[matchedIndex] || '';
          gaEvent('correct_note', {
      index: matchedIndex,
      label: matchedLabel,
      clef: selectedClef,
      key: currentKeySig
    });
          markNoteGreen(notes[i]);
          matchedFreq = freq;
          lastNoteTime = Date.now();
          i++;
          renderStaff(currentBeats);
          if (i === notes.length){
            if (msreCount == -1){
              // Random Note Mode completion
              if (autoNext) {
                generateRandomLine();
                gate = 'WAIT_ATTACK'; haveGoneQuiet = false; matchedFreq = 0; i = 0;
                deferNextFrame = true;
                break;
              }
              // Auto-next off - just stop and wait for user action
            } else {
              if (msreCount == totalMsre-1){
                // Song complete
                if (autoNext && randomSongMode) {
                  // Auto-advance to next song in Random Song Mode with Auto-Next ON
                  nextRandomSong().then(() => {
                    gate = 'WAIT_ATTACK'; haveGoneQuiet = false; matchedFreq = 0; i = 0;
                    deferNextFrame = true;
                  });
                  break;
                }
                // Auto-next off - just stop and wait for user action
              } else {
                msreCount++;
                renderAnalysisLine();
                gate = 'WAIT_ATTACK'; haveGoneQuiet = false; matchedFreq = 0; i = 0;
                deferNextFrame = true;
                break;
              }
            }
          }
          gate = 'WAIT_NEXT';
        } else if (isRealNote(note)) {
          // Note detected but no match
        }
        break;
      case 'WAIT_NEXT':
        // Check for timeout - force transition if we've been waiting too long
        if (Date.now() - lastNoteTime > NOTE_TIMEOUT) {
          gate = 'READY';
          break;
        }
        
        if (loudness < minDb) {
          gate = 'WAIT_ATTACK';
          haveGoneQuiet = true; // already quiet after last match
        } else if (freq && matchedFreq && isClearlyDifferent(freq, matchedFreq)) {
          gate = 'READY';
        } else if (freq && isRealNote(note) && canon(note) !== target[i]) {
          gate = 'READY';
        }
        break;
      case 'WAIT_ATTACK':
        // Require a silence below threshold before allowing the next attack
        if (loudness < minDb - 2) haveGoneQuiet = true; // small hysteresis
        else if (haveGoneQuiet && loudness >= minDb) gate = 'READY';
        break;
    }
    if (deferNextFrame) {
      deferNextFrame = false;
      raf = requestAnimationFrame(tick);
      return;
    }
    raf = requestAnimationFrame(tick);
  }



  // Store the transposition decision for the entire song
  let songTransposition = 0;
  let songTranspositionCalculated = false;

  async function renderAnalysisLine() {
    if (!vfDiv) return;
    if (msreCount == -1 || measures == undefined) {
      msreCount = 0;
      await getMusicXML();
      
      // Calculate transposition for the ENTIRE song when first loading
      if (selectedClef !== 'treble' && !songTranspositionCalculated) {
        // Collect ALL notes from ALL measures to analyze the complete song
        const allSongNotes: StaveNote[] = [];
        for (const measure of measures) {
          allSongNotes.push(...measure.notes);
        }
        
        songTransposition = determineOptimalTransposition(allSongNotes, 'treble', selectedClef);
        songTranspositionCalculated = true;
        console.log(`Analyzing ENTIRE song for ${selectedClef} clef: optimal transposition ${songTransposition} octaves (based on ${allSongNotes.length} total notes)`);
      }
    }
    if (!measures.length) return alert('Nothing parsed');

    totalMsre   = measures.length;
    notes       = measures[msreCount].notes;
    currentKeySig = measures[msreCount].key.split(' ')[0];
    km          = new KeyManager(currentKeySig);

    // Apply the song-wide transposition to this measure
    if (songTransposition !== 0) {
      notes = notes.map(note => {
        const originalKeys = note.getKeys();
        const transposedKeys = originalKeys.map(key => 
          transposeNote(key, songTransposition)
        );
        
        return new StaveNote({
          keys: transposedKeys,
          duration: note.getDuration(),
          clef: selectedClef,
          autoStem: true
        });
      });
    }

    // remember previous measure first target
    prevTargetFirst = target.length ? target[0] : null;
    line = []; target = []; i = 0;
    gate = 'WAIT_ATTACK'; // force a fresh note attack when switching measures
    lastNoteTime = 0;
    matchedFreq = 0; // avoid carry-over matching across measures
    haveGoneQuiet = false;
    
    for (let x = 0; x < notes.length; x++) {
      const k = notes[x].keys[0];
      line.push(k.replace('/', ''));
      target.push(canon(k.replace('/', '')));
    }

    // --- ADAPT THE VOICE & STAVE TO TRUE DURATION ---
    // Use time signature from MusicXML if available, otherwise calculate from notes
    const currentMeasure = measures[msreCount];
    let beats: number;
    let beatValue: number;
    
    if (currentMeasure.timeSignature) {
      beats = currentMeasure.timeSignature.beats;
      beatValue = currentMeasure.timeSignature.beatType;
      console.log('renderAnalysisLine(): using time signature from MusicXML', { beats, beatValue, msreCount });
    } else {
      // Fallback to calculating from note durations
      const beatsFloat = beatsFromNotes(notes);
      beats = normalizeBeats(beatsFloat);
      beatValue = 4;
      console.log('renderAnalysisLine(): calculated beats from note durations', { beats, beatValue, msreCount });
    }
    
    currentBeats = beats;

// Build the voice to match what will actually be drawn
const voice = new Voice({ numBeats: beats, beatValue });
if ((voice as any).setStrict) { (voice as any).setStrict(false); }
else if ((voice as any).setMode && (Voice as any).Mode) { (voice as any).setMode((Voice as any).Mode.SOFT); }
voice.addTickables(notes);

// --- compute safe width (no cutoffs / no huge gaps) ---
const fmt = new Formatter();
fmt.joinVoices([voice]).preFormat();
const minNotesWidth = fmt.getMinTotalWidth();

vfDiv.innerHTML = '';
const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
renderer.resize(10, 140);
const ctx = renderer.getContext();

const leadIn    = measureLead(ctx, beats);
const accCnt    = accidentalCount(currentKeySig);
const heuristic = calcStaveWidth(notes, accCnt);
const width     = Math.ceil(Math.max(heuristic,  leadIn + 20));

renderer.resize(width, 140);
// Make SVG responsive: set viewBox and fluid size
const svgRoot = vfDiv.querySelector('svg');
if (svgRoot) {
  svgRoot.setAttribute('viewBox', `0 0 ${width} 140`);
  svgRoot.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  (svgRoot as SVGSVGElement).style.width = '100%';
  (svgRoot as SVGSVGElement).style.height = 'auto';
  (svgRoot as SVGSVGElement).style.display = 'block';
}
const stave = new Stave(10, 20, width)
  .addClef(selectedClef)
  .addTimeSignature(`${beats}/4`)
  .addKeySignature(currentKeySig);

stave.setContext(ctx).draw();

// 🔽 keep your accidental policy exactly as you implemented
if (useKeyOnly) {
  stripAccidentalsFromNotes(notes);
} else if (!allowNaturals) {
  stripAccidentalsFromNotes(notes);
  addAccidentalsFromKeys(notes);
} else {
  Accidental.applyAccidentals([voice], currentKeySig);
}

new Formatter().joinVoices([voice]).formatToStave([voice], stave);
voice.draw(ctx, stave);

const beams = Beam.generateBeams(notes);
hideFlagsForBeamedNotes(beams as any);
beams.forEach(b => b.setContext(ctx).draw());
// After drawing, make SVG responsive
const svgRoot2 = vfDiv.querySelector('svg') as SVGSVGElement | null;
if (svgRoot2) {
  svgRoot2.setAttribute('viewBox', `0 0 ${width} 140`);
  svgRoot2.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svgRoot2.style.width = '100%';
  svgRoot2.style.height = 'auto';
  svgRoot2.style.display = 'block';
}
  }

  async function clefchanged(){
    if (msreCount == -1){
      generateRandomLine();
    } else {
      await getMusicXML();
      renderAnalysisLine();
    }
  }

  // Track previous clef for transposition
  let previousClef: Clef = selectedClef;
  
  // Auto-transpose function with smart octave detection
  function analyzeNoteRange(notes: StaveNote[]): { minOctave: number, maxOctave: number, avgOctave: number } {
    const octaves = notes.map(note => {
      const key = note.getKeys()[0];
      const octave = parseInt(key.split('/')[1]);
      return octave;
    }).filter(oct => !isNaN(oct));
    
    if (octaves.length === 0) return { minOctave: 4, maxOctave: 4, avgOctave: 4 };
    
    const minOctave = Math.min(...octaves);
    const maxOctave = Math.max(...octaves);
    const avgOctave = octaves.reduce((sum, oct) => sum + oct, 0) / octaves.length;
    
    return { minOctave, maxOctave, avgOctave };
  }

  function determineOptimalTransposition(notes: StaveNote[], fromClef: Clef, toClef: Clef): number {
    if (fromClef === toClef) return 0;
    
    // Define the center line for each clef (in terms of note + octave)
    const CLEF_CENTERS = {
      treble: { note: 'B', octave: 4 }, // B4 is center line of treble staff
      bass: { note: 'D', octave: 3 },   // D3 is center line of bass staff  
      alto: { note: 'C', octave: 4 }    // C4 is center line of alto staff
    };
    
    // Convert note+octave to a numerical value for distance calculation
    function noteToNumber(noteKey: string): number {
      const parts = noteKey.split('/');
      if (parts.length !== 2) return 0;
      
      const notePart = parts[0].toLowerCase();
      const octave = parseInt(parts[1]);
      
      // Convert note letter to semitone (C=0, D=2, E=4, F=5, G=7, A=9, B=11)
      const NOTE_SEMITONES: Record<string, number> = {
        'c': 0, 'c#': 1, 'db': 1,
        'd': 2, 'd#': 3, 'eb': 3, 
        'e': 4, 'fb': 4,
        'f': 5, 'f#': 6, 'gb': 6,
        'g': 7, 'g#': 8, 'ab': 8,
        'a': 9, 'a#': 10, 'bb': 10,
        'b': 11, 'cb': 11
      };
      
      const semitone = NOTE_SEMITONES[notePart] || 0;
      return octave * 12 + semitone;
    }
    
    // Calculate center position for target clef
    const center = CLEF_CENTERS[toClef];
    const centerValue = noteToNumber(`${center.note.toLowerCase()}/${center.octave}`);
    
    // Test different transposition options (-2, -1, 0, +1, +2 octaves)
    const transpositionOptions = [-2, -1, 0, 1, 2];
    let bestTransposition = 0;
    let bestAverageDistance = Infinity;
    
    for (const octaveShift of transpositionOptions) {
      let totalDistance = 0;
      let validNotes = 0;
      
      for (const note of notes) {
        const originalKey = note.getKeys()[0];
        const transposedKey = transposeNote(originalKey, octaveShift);
        const noteValue = noteToNumber(transposedKey);
        
        if (noteValue > 0) { // Valid note
          const distance = Math.abs(noteValue - centerValue);
          totalDistance += distance;
          validNotes++;
        }
      }
      
      if (validNotes > 0) {
        const averageDistance = totalDistance / validNotes;
        
        if (averageDistance < bestAverageDistance) {
          bestAverageDistance = averageDistance;
          bestTransposition = octaveShift;
        }
      }
    }
    
    return bestTransposition;
  }

  function transposeNote(noteKey: string, octaveShift: number): string {
    const parts = noteKey.split('/');
    if (parts.length === 2) {
      const notePart = parts[0];
      let octave = parseInt(parts[1]);
      octave = Math.max(1, Math.min(8, octave + octaveShift));
      return `${notePart}/${octave}`;
    }
    return noteKey;
  }

  // Watch for clef changes and auto-transpose if in song mode
  $: if (selectedClef !== previousClef && randomSongMode && notes.length > 0 && measures?.length > 0) {
    // Reset transposition calculation and recalculate for entire song
    songTranspositionCalculated = false;
    
    // Collect ALL notes from ALL measures to analyze the complete song
    const allSongNotes: StaveNote[] = [];
    for (const measure of measures) {
      allSongNotes.push(...measure.notes);
    }
    
    const octaveShift = determineOptimalTransposition(allSongNotes, 'treble', selectedClef);
    songTransposition = octaveShift;
    songTranspositionCalculated = true;
    
    console.log(`Clef changed from ${previousClef} to ${selectedClef}, analyzing ENTIRE song: optimal transposition ${octaveShift} octaves (based on ${allSongNotes.length} total notes)`);
    
    // Re-render current measure with new transposition
    renderAnalysisLine();
    
    previousClef = selectedClef;
  } else {
    previousClef = selectedClef;
  }

  /* ---------- Metronome ---------- */
  // Remove metronome logic and state:
  // Remove lines 559-605 (all metronome state and functions)
  // ... existing code ...


  /* ---------- Random Song Mode - Database Integration ---------- */
  let xmlText:string = '';
  let measures: any;

  function getMusicXML() {
    measures = parseMusicXML(xmlText, selectedClef);
  }

  // Extract title and composer from MusicXML
  function extractMetaFromMusicXML(xml: string): { title: string; composer: string } {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');

    // If the XML failed to parse, bail gracefully
    if (doc.getElementsByTagName('parsererror').length) {
      return { title: '(Untitled)', composer: '' };
    }

    // Helper: first node text by XPath, ignoring namespaces via local-name()
    const xp = (expr: string): string | null => {
      const r = doc.evaluate(
        expr,
        doc,
        null,
        XPathResult.STRING_TYPE,
        null
      ) as XPathResult;
      const s = (r.stringValue || '').trim();
      return s.length ? s : null;
    };

    // Title candidates (order of preference)
    const title =
      xp("normalize-space(//*[local-name()='score-partwise']/*[local-name()='work']/*[local-name()='work-title'])") ||
      xp("normalize-space(//*[local-name()='score-timewise']/*[local-name()='work']/*[local-name()='work-title'])") ||
      xp("normalize-space(//*[local-name()='score-partwise']/*[local-name()='movement-title'])") ||
      xp("normalize-space(//*[local-name()='score-timewise']/*[local-name()='movement-title'])") ||
      // Credits block: credit[credit-type='title']/credit-words
      xp("normalize-space(//*[local-name()='credit'][*[local-name()='credit-type' and translate(text(),'TITLE','title')='title']]/*[local-name()='credit-words'][1])") ||
      // Fallback: pick the longest credit-words string
      (() => {
        const iter = doc.evaluate(
          "//*[local-name()='credit-words']",
          doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null
        );
        let node: Node | null, best = '';
        while ((node = iter.iterateNext())) {
          const t = (node.textContent || '').trim();
          if (t.length > best.length) best = t;
        }
        return best || null;
      })() ||
      '(Untitled)';

    // Composer candidates
    const composer =
      // identification -> creator[type='composer']
      xp("normalize-space(//*[local-name()='identification']/*[local-name()='creator'][translate(@type,'COMPOSER','composer')='composer'])") ||
      // any creator if only one present
      xp("normalize-space((//*[local-name()='identification']/*[local-name()='creator'])[1])") ||
      // credits: credit[credit-type='composer']/credit-words
      xp("normalize-space(//*[local-name()='credit'][*[local-name()='credit-type' and translate(text(),'COMPOSER','composer')='composer']]/*[local-name()='credit-words'][1])") ||
      '';

    return { title, composer };
  }

  // helper: get one random row from xml_pool
  async function fetchRandomXMLFromPool() {
    // 1) ask only for the count (no data yet)
    const { count, error: countErr } = await supabase
      .from('xml_pool')
      .select('*', { count: 'exact', head: true });
    if (countErr) throw countErr;
    if (!count || count <= 0) throw new Error('No MusicXML in xml_pool yet');

    // 2) pick a random offset
    const offset = Math.floor(Math.random() * count);

    // 3) fetch exactly that row
    const { data, error } = await supabase
      .from('xml_pool')
      .select('musicxml')
      .range(offset, offset); // 1 row at the offset
    if (error) throw error;

    return data![0]; // { musicxml }
  }

  async function startRandomSongMode() {
    randomSongMode = true;
    showSongDropdown = true;
    showNoteDropdown = false;

    const row = await fetchRandomXMLFromPool();
    xmlText = row.musicxml;

    // ⬇️ NEW: derive title/composer from the XML itself
    const meta = extractMetaFromMusicXML(xmlText);
    currentSongTitle = meta.title || '(Untitled)';
    currentSongComposer = meta.composer || '';

    msreCount = -1;
    songTransposition = 0;
    songTranspositionCalculated = false;

    renderAnalysisLine();
    gaEvent('random_song_mode_started', { source: 'xml_pool' });
  }

  async function nextRandomSong() {
    const row = await fetchRandomXMLFromPool();
    xmlText = row.musicxml;

    const meta = extractMetaFromMusicXML(xmlText);
    currentSongTitle = meta.title || '(Untitled)';
    currentSongComposer = meta.composer || '';

    msreCount = -1;
    songTransposition = 0;
    songTranspositionCalculated = false;

    renderAnalysisLine();
    gaEvent('next_random_song', { source: 'xml_pool' });
  }

  function switchToRandomNoteMode() {
    randomSongMode = false;
    showNoteDropdown = true;
    showSongDropdown = false;
    currentSongTitle = '';
    currentSongComposer = '';
    gaEvent('random_note_mode');
    generateRandomLine();
  }

  function toggleSongDropdown() {
    if (randomSongMode) {
      // Already in song mode, just toggle dropdown
      showSongDropdown = !showSongDropdown;
    } else {
      // Switch to song mode and show dropdown
      startRandomSongMode();
    }
  }

  function toggleNoteDropdown() {
    if (!randomSongMode) {
      // Already in note mode, just toggle dropdown
      showNoteDropdown = !showNoteDropdown;
    } else {
      // Switch to note mode and show dropdown
      switchToRandomNoteMode();
    }
  }

  async function resetCurrentSong() {
    if (!randomSongMode) return;
    gaEvent('reset_song', { song: currentSongTitle });
    
    // Reset the current song by restarting from the beginning
    msreCount = -1;
    songTransposition = 0;
    songTranspositionCalculated = false;
    renderAnalysisLine();
  }



  // ===== Preferences: shape + defaults =====
type Prefs = {
  selectedClef?: Clef;
  selectedKeySig?: string;
  selectedTS?: string;
  enableHalves?: boolean;
  enableEighths?: boolean;
  useKeyOnly?: boolean;
  allowNaturals?: boolean;
  allowSharps?: boolean;
  allowFlats?: boolean;
  bpm?: number;
  minDb?: number;
  randomSongMode?: boolean;
  autoNext?: boolean;
};

function getCurrentPrefs(): Prefs {
  return {
    selectedClef,
    selectedKeySig,
    selectedTS,
    enableHalves,
    enableEighths,
    useKeyOnly,
    allowNaturals,
    allowSharps,
    allowFlats,
    bpm,
    minDb,
    randomSongMode,
    autoNext
  };
}

function applyPrefs(p: Prefs) {
  if (!p) return;
  if (p.selectedClef) selectedClef = p.selectedClef;
  if (typeof p.selectedKeySig === 'string') selectedKeySig = p.selectedKeySig;
  if (typeof p.selectedTS === 'string') selectedTS = p.selectedTS;

  if (typeof p.enableHalves === 'boolean')  enableHalves  = p.enableHalves;
  if (typeof p.enableEighths === 'boolean') enableEighths = p.enableEighths;

  if (typeof p.useKeyOnly === 'boolean')    useKeyOnly    = p.useKeyOnly;
  if (typeof p.allowNaturals === 'boolean') allowNaturals = p.allowNaturals;
  if (typeof p.allowSharps === 'boolean')   allowSharps   = p.allowSharps;
  if (typeof p.allowFlats === 'boolean')    allowFlats    = p.allowFlats;

  if (typeof p.bpm === 'number')  bpm  = p.bpm;
  if (typeof p.minDb === 'number') minDb = p.minDb;
  if (typeof p.randomSongMode === 'boolean') randomSongMode = p.randomSongMode;
  if (typeof p.autoNext === 'boolean') autoNext = p.autoNext;

  // after applying prefs, regenerate the random staff so UI reflects them
  generateRandomLine();
}

// ===== Load / Save helpers =====
let prefsLoaded = false;
let saveTimer: number | null = null;

async function loadPrefsFromDb() {
  const { data: u } = await supabase.auth.getUser();
  const user = u?.user;
  if (!user) { prefsLoaded = false; return; }

  const { data, error } = await supabase
    .from('user_prefs')
    .select('prefs')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('loadPrefs error', error.message);
    return;
  }

  if (data?.prefs) applyPrefs(data.prefs as Prefs);
  prefsLoaded = true;
}

async function savePrefsToDb(p: Prefs) {
  const { data: u } = await supabase.auth.getUser();
  const user = u?.user;
  if (!user) return;

  const { error } = await supabase
    .from('user_prefs')
    .upsert(
      { user_id: user.id, prefs: p },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) console.error('savePrefs error', error.message);
}

function schedulePrefsSave() {
  if (!prefsLoaded) return;               // don't save until initial load finished
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    savePrefsToDb(getCurrentPrefs());
  }, 600); // debounce ~0.6s
}

// ===== Hook into auth + initial mount =====
onMount(async () => {
  await loadPrefsFromDb();
});

supabase.auth.onAuthStateChange((_e, s) => {
  if (s?.user) loadPrefsFromDb();
});

// ===== Autosave when relevant state changes =====
$: if (prefsLoaded) {
  // Any of these changing will schedule a save
  void selectedClef, selectedKeySig, selectedTS,
       enableHalves, enableEighths,
       useKeyOnly, allowNaturals, allowSharps, allowFlats,
       bpm, minDb, randomSongMode, autoNext;
  schedulePrefsSave();
}

// Hide flags on notes that are part of a beam (VexFlow normally does this,
// but some builds can still render flags; force-disable for beamed notes)
function hideFlagsForBeamedNotes(beams: any[]) {
  (beams || []).forEach((b: any) => {
    const ns: any[] = b?.notes || b?.getNotes?.() || [];
    ns.forEach((n: any) => {
      try {
        n.render_flag = false;
        if (n.flag) n.flag = undefined;
        // force-disable flag drawing on this note instance
        if (typeof n.drawFlag === 'function') {
          n.drawFlag = () => {};
        }
        console.log('hideFlagsForBeamedNotes(): disabled flag for', n.getDuration?.());
      } catch {}
    });
  });
  // Fallback: if any beam exists, disable flags on all 8th/16th notes in the measure
  if ((beams || []).length > 0) {
    (notes as any[]).forEach((n: any) => {
      const dur = n.getDuration?.() || n.getDuration?.();
      if (typeof dur === 'string' && (/^(8|16)/.test(dur))) {
        try {
          n.render_flag = false;
          if (n.flag) n.flag = undefined;
          if (typeof n.drawFlag === 'function') n.drawFlag = () => {};
          console.log('fallback flag disable on', dur);
        } catch {}
      }
    });
  }
}

// Piano keyboard integration
function handlePianoNote(note: string, frequency: number) {
  console.log('🎹 Piano key clicked:', note);
  
  // The piano sends just the note name (C, D#, etc.) without octave
  // We need to match this against the target note regardless of octave
  //gaEvent('piano key pressed', {note});
  // Update the display to show the piano note was played
  freq = Math.round(frequency);
  lastGoodFreq = frequency;
  lastHeard = Date.now();
  lastUpdate = lastHeard;
  
  // Extract the note name from the target (e.g., "C4" -> "C", "D#5" -> "D#")
  if (i >= line.length || !line[i]) {
    console.log('🎹 Piano note played but no target note available');
    return;
  }
  const targetNoteName = line[i].replace(/\d+$/, '') || '';
  console.log('🎯 Target note:', line[i], '→ extracted:', targetNoteName);
  
  // Normalize note names for comparison (handle both # and ♯ symbols)
  const normalizeNote = (noteStr: string) => noteStr.replace(/♯/g, '#').replace(/♭/g, 'b');
  
  // Handle enharmonic equivalents (A# = Bb, C# = Db, E# = F, B# = C, etc.)
  const getEnharmonicEquivalents = (noteStr: string) => {
    const equivalents: Record<string, string[]> = {
      'A#': ['Bb', 'A#'],
      'Bb': ['Bb', 'A#'],
      'C#': ['C#', 'Db'],
      'Db': ['C#', 'Db'],
      'D#': ['D#', 'Eb'],
      'Eb': ['D#', 'Eb'],
      'F#': ['F#', 'Gb'],
      'Gb': ['F#', 'Gb'],
      'G#': ['G#', 'Ab'],
      'Ab': ['G#', 'Ab'],
      // White key enharmonics
      'E#': ['F', 'E#'],
      'F': ['F', 'E#'],
      'B#': ['C', 'B#'],
      'C': ['C', 'B#'],
      'Cb': ['B', 'Cb'],
      'B': ['B', 'Cb'],
      'Fb': ['E', 'Fb'],
      'E': ['E', 'Fb'],
      // Double accidentals (rare but possible)
      'C##': ['D', 'C##'],
      'F##': ['G', 'F##'],
      'G##': ['A', 'G##'],
      'Dbb': ['C', 'Dbb'],
      'Gbb': ['F', 'Gbb'],
      'Abb': ['G', 'Abb']
    };
    return equivalents[noteStr] || [noteStr];
  };
  
  const normalizedPianoNote = normalizeNote(note);
  const normalizedTargetNote = normalizeNote(targetNoteName);
  const pianoEquivalents = getEnharmonicEquivalents(normalizedPianoNote);
  const targetEquivalents = getEnharmonicEquivalents(normalizedTargetNote);
  
  console.log('🔄 Comparing:', normalizedPianoNote, 'vs', normalizedTargetNote);
  console.log('🎵 Piano equivalents:', pianoEquivalents, 'Target equivalents:', targetEquivalents);
  
  // Check if the piano note matches the target note name (ignoring octave)
  // Also check enharmonic equivalents
  const isMatch = pianoEquivalents.some(p => targetEquivalents.includes(p));
  if (isMatch) {
    const matchedIndex = i;
    const matchedLabel = line[matchedIndex] || '';
    gaEvent('correct_note', {
      index: matchedIndex,
      label: matchedLabel,
      clef: selectedClef,
      key: currentKeySig
    });
    
    // Mark the note as green
    markNoteGreen(notes[i]);
    
    // Update state
    matchedFreq = freq;
    lastNoteTime = Date.now();
    i++;
    
    // Re-render the staff to show the green note
    // Use a fresh copy of notes to avoid VexFlow conflicts
    const notesCopy = notes.map((note, idx) => {
      if (idx === matchedIndex) {
        // Create a new note object with green styling
        const newNote = new StaveNote({
          keys: note.getKeys(),
          duration: note.getDuration(),
          clef: selectedClef,
          autoStem: true
        });
        newNote.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });
        return newNote;
      }
      return note;
    });
    
    // Temporarily replace notes array and re-render
    const originalNotes = notes;
    notes = notesCopy;
    renderStaff(currentBeats);
    notes = originalNotes;
    
    if (i === notes.length) {
      if (msreCount == -1) {
        generateRandomLine();
        gate = 'WAIT_ATTACK';
        haveGoneQuiet = false;
        matchedFreq = 0;
        i = 0;
        deferNextFrame = true;
      } else {
        if (msreCount == totalMsre - 1) {
          // Song complete
          if (autoNext && randomSongMode) {
            // Auto-advance to next song in Random Song Mode with Auto-Next ON
            nextRandomSong().then(() => {
              gate = 'WAIT_ATTACK';
              haveGoneQuiet = false;
              matchedFreq = 0;
              i = 0;
              deferNextFrame = true;
            });
          }
          // Flow mode off - just stop and wait for user action
        } else {
          msreCount++;
          renderAnalysisLine();
          gate = 'WAIT_ATTACK';
          haveGoneQuiet = false;
          matchedFreq = 0;
          i = 0;
          deferNextFrame = true;
        }
      }
    }
    
    // Set proper gate state to sync with microphone detection logic
    gate = 'WAIT_NEXT';
    lastNoteTime = Date.now();
  }
}

</script>

<div class="main-container">
  <!-- Header Section -->
  <header class="app-header">
    <h1 class="app-title">Music Buddy</h1>
    <p class="app-subtitle">Interactive music learning with real-time pitch detection</p>
  </header>

  <!-- Auth UI -->
  <section class="auth-section">
    {#if userEmail}
      <div class="auth-info">
        <span class="auth-label">Signed in as:</span>
        <span class="auth-email">{userEmail}</span>
        <button on:click={signOut} class="auth-button signout">Sign out</button>
      </div>
    {:else}
      <div class="auth-form">
        <input
          class="auth-input"
          type="email"
          bind:value={emailInput}
          placeholder="you@example.com"
          aria-label="Email address"
        />
        <button on:click={signInWithEmail} class="auth-button signin">
          Sign in (Email)
        </button>
      </div>
    {/if}
  </section>

  <!-- Mode Selection -->
  <section class="mode-selection">
    <div class="mode-buttons">
      <!-- Random Song Mode Button -->
      <div class="mode-dropdown" class:active={randomSongMode && showSongDropdown}>
        <button 
          class="mode-button" 
          class:active={randomSongMode}
          on:click={toggleSongDropdown}
        >
          <span class="mode-icon">🎵</span>
          Random Song Mode
          <span class="dropdown-arrow">▼</span>
        </button>
        
        {#if randomSongMode && showSongDropdown}
          <div class="dropdown-content">
            <label class="dropdown-control">
              <span>Clef:</span>
              <select bind:value={selectedClef} on:change={clefchanged} class="dropdown-select">
                {#each CLEFS as c}
                  <option value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                {/each}
              </select>
            </label>
            
            <label class="dropdown-toggle">
              <span>Auto-Next</span>
              <button
                type="button"
                class="toggle-switch"
                class:active={autoNext}
                on:click={() => { autoNext = !autoNext; }}
                aria-pressed={autoNext}
                aria-label="Toggle auto-next mode"
              >
                <span class="toggle-slider"></span>
              </button>
            </label>
          </div>
        {/if}
      </div>

      <!-- Random Note Mode Button -->
      <div class="mode-dropdown" class:active={!randomSongMode && showNoteDropdown}>
        <button 
          class="mode-button" 
          class:active={!randomSongMode}
          on:click={toggleNoteDropdown}
        >
          <span class="mode-icon">🎼</span>
          Random Note Mode
          <span class="dropdown-arrow">▼</span>
        </button>
        
        {#if !randomSongMode && showNoteDropdown}
          <div class="dropdown-content">
            <label class="dropdown-control">
              <span>Clef:</span>
              <select bind:value={selectedClef} on:change={clefchanged} class="dropdown-select">
                {#each CLEFS as c}
                  <option value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                {/each}
              </select>
            </label>
            
            <label class="dropdown-control">
              <span>Key Signature:</span>
              <select
                bind:value={selectedKeySig}
                on:change={generateRandomLine}
                class="dropdown-select"
              >
                {#each KEY_SIGS as ks}
                  <option value={ks.value}>{ks.label}</option>
                {/each}
              </select>
            </label>

            <div class="toggle-group">
              <label class="dropdown-toggle">
                <span>Half notes</span>
                <button
                  type="button"
                  class="toggle-switch"
                  class:active={enableHalves}
                  on:click={() => { enableHalves = !enableHalves; generateRandomLine(); }}
                  aria-pressed={enableHalves}
                  aria-label="Toggle half notes"
                >
                  <span class="toggle-slider"></span>
                </button>
              </label>

              <label class="dropdown-toggle">
                <span>Eighth notes</span>
                <button
                  type="button"
                  class="toggle-switch"
                  class:active={enableEighths}
                  on:click={() => { enableEighths = !enableEighths; generateRandomLine(); }}
                  aria-pressed={enableEighths}
                  aria-label="Toggle eighth notes"
                >
                  <span class="toggle-slider"></span>
                </button>
              </label>

              <label class="dropdown-toggle">
                <span>Key-only notes</span>
                <button
                  type="button"
                  class="toggle-switch"
                  class:active={useKeyOnly}
                  on:click={() => { useKeyOnly = !useKeyOnly; generateRandomLine(); }}
                  aria-pressed={useKeyOnly}
                  aria-label="Toggle key-only notes"
                >
                  <span class="toggle-slider"></span>
                </button>
              </label>


            </div>

            {#if !useKeyOnly}
              <div class="accidental-toggles">
                <div class="accidental-toggle-item">
                  <span class="accidental-label">Naturals</span>
                  <button
                    type="button"
                    class="toggle-switch small"
                    class:active={allowNaturals}
                    on:click={() => { allowNaturals = !allowNaturals; generateRandomLine(); }}
                    aria-pressed={allowNaturals}
                    aria-label="Toggle natural accidentals"
                  >
                    <span class="toggle-slider"></span>
                  </button>
                </div>

                <div class="accidental-toggle-item">
                  <span class="accidental-label">Sharps</span>
                  <button
                    type="button"
                    class="toggle-switch small"
                    class:active={allowSharps}
                    on:click={() => { allowSharps = !allowSharps; generateRandomLine(); }}
                    aria-pressed={allowSharps}
                    aria-label="Toggle sharp accidentals"
                  >
                    <span class="toggle-slider"></span>
                  </button>
                </div>

                <div class="accidental-toggle-item">
                  <span class="accidental-label">Flats</span>
                  <button
                    type="button"
                    class="toggle-switch small"
                    class:active={allowFlats}
                    on:click={() => { allowFlats = !allowFlats; generateRandomLine(); }}
                    aria-pressed={allowFlats}
                    aria-label="Toggle flat accidentals"
                  >
                    <span class="toggle-slider"></span>
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </section>

  <!-- Staff Section -->
  <section class="staff-section">
    {#if randomSongMode && currentSongTitle}
      <div class="song-info">
        <h3 class="song-title">{currentSongTitle}</h3>
        <p class="song-composer">{currentSongComposer}</p>
      </div>
    {/if}
    
    <div class="staff-container">
      <div bind:this={vfDiv} class="staff-display"></div>
        
        <div class="staff-buttons">
          <button on:click={
            () => {
              gaEvent('new_staff_click', { clef: selectedClef, key: selectedKeySig, halves: enableHalves, eighths: enableEighths, useKeyOnly, allowNaturals, allowSharps, allowFlats, randomSongMode, autoNext });
              if (randomSongMode) {
                nextRandomSong();
              } else {
                generateRandomLine();
              }
            }
          } class="staff-button primary">
            <span class="button-icon">🎵</span>
            {randomSongMode ? 'Next Song' : 'New Staff'}
          </button>

          {#if randomSongMode && currentSongTitle}
            <button on:click={resetCurrentSong} class="staff-button secondary">
              <span class="button-icon">🔄</span>
              Reset Song
            </button>
          {/if}
        </div>
    </div>
  </section>

  <!-- Pitch Detection Display -->
  <section class="pitch-display">
    <div class="pitch-controls">
      {#if !micEnabled}
        <div class="mic-permission">
          <button class="mic-button" on:click={enableMic}>Enable Microphone</button>
          {#if micError}
            <div class="mic-error">{micError}</div>
          {/if}
        </div>
      {/if}
      
      <div class="piano-toggle">
        <button 
          class="piano-toggle-button"
          class:active={pianoKeyboardVisible}
          on:click={() => pianoKeyboardVisible = !pianoKeyboardVisible}
        >
          <span class="piano-icon">🎹</span>
          {pianoKeyboardVisible ? 'Hide Piano' : 'Show Piano'}
        </button>
      </div>
    </div>
    
    <div class="pitch-info">
      <div class="frequency-display">
        <span class="frequency-value">{freq || '--'}</span>
        <span class="frequency-unit">Hz</span>
      </div>
      <div class="note-display">{note}</div>
    </div>

    <div class="audio-controls">
      <label class="volume-control">
        <span class="control-text">Sensitivity: {minDb} dBFS</span>
        <input 
          type="range" 
          min="-60" 
          max="-10" 
          step="1" 
          bind:value={minDb} 
          class="volume-slider" 
        />
      </label>
      <div class="loudness-display">
        Current: {loudness.toFixed(1)} dBFS
      </div>
    </div>
  </section>

  <!-- Metronome Section -->
  <section class="metronome-section">
    <Metronome {ctx} bind:bpm />
  </section>



  <!-- Piano Keyboard -->
  <PianoKeyboard 
    bind:visible={pianoKeyboardVisible}
    currentClef={selectedClef}
    {currentKeySig}
    on:notePlayed={({ detail }) => handlePianoNote(detail.note, detail.frequency)}
  />
</div>

<style>
  /* Auth Section */
  .auth-section {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    padding: 1rem 2rem;
    margin-bottom: 2rem;
    border-radius: 1rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .auth-info, .auth-form {
    display: flex;
    align-items: center;
    gap: 1rem;
    justify-content: center;
    color: white;
    flex-wrap: wrap;
    width: 100%;
  }

  .auth-label {
    font-size: 0.9rem;
    opacity: 0.9;
  }

  .auth-email {
    font-weight: 600;
    background: rgba(255, 255, 255, 0.2);
    padding: 0.25rem 0.75rem;
    border-radius: 1rem;
  }

  .auth-input {
    padding: 0.5rem 1rem;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-radius: 0.5rem;
    font-size: 0.9rem;
    min-width: 0;
    width: min(420px, 100%);
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease;
  }

  .auth-input::placeholder {
    color: rgba(255, 255, 255, 0.85);
  }

  .auth-input:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.95);
    background: rgba(255, 255, 255, 0.18);
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
  }

  .auth-button {
    padding: 0.5rem 1.5rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    max-width: 100%;
  }

  .auth-button:hover {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.5);
  }

  /* Main Container */
  .main-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 2rem;
  }

  /* Header */
  .app-header {
    text-align: center;
    margin-bottom: 3rem;
    padding: 2rem 0;
  }

  .app-title {
    font-size: 3.5rem;
    font-weight: 800;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }

  .app-subtitle {
    font-size: 1.2rem;
    color: #6b7280;
    font-weight: 500;
  }

  /* Mode Selection */
  .mode-selection {
    background: white;
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    border: 1px solid #e5e7eb;
  }

  .mode-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .mode-dropdown {
    position: relative;
    min-width: 250px;
  }

  .mode-button {
    width: 100%;
    padding: 1rem 1.5rem;
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
    border: 2px solid #cbd5e1;
    border-radius: 0.75rem;
    font-size: 1.1rem;
    font-weight: 600;
    color: #1e293b;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .mode-button:hover {
    background: linear-gradient(135deg, #f1f5f9 0%, #d6e2ea 100%);
    border-color: #94a3b8;
  }

  .mode-button.active {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-color: #667eea;
    color: white;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  }

  .mode-icon {
    font-size: 1.2rem;
  }

  .dropdown-arrow {
    font-size: 0.8rem;
    transition: transform 0.2s ease;
  }

  .mode-dropdown.active .dropdown-arrow {
    transform: rotate(180deg);
  }

  .dropdown-content {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: white;
    border: 2px solid #e5e7eb;
    border-radius: 0.75rem;
    padding: 1.5rem;
    margin-top: 0.5rem;
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .dropdown-control {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-weight: 600;
    color: #374151;
  }

  .dropdown-select {
    padding: 0.75rem;
    border: 2px solid #e5e7eb;
    border-radius: 0.5rem;
    font-size: 1rem;
    background: white;
    transition: border-color 0.2s ease;
    width: 100%;
  }

  .dropdown-select:focus {
    outline: none;
    border-color: #667eea;
  }

  .dropdown-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    color: #374151;
    cursor: pointer;
    padding: 0.5rem 0;
  }



  .toggle-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .accidental-toggles {
    display: flex;
    gap: 1.5rem;
    justify-content: space-around;
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .accidental-toggle-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
  }

  .accidental-label {
    font-weight: 600;
    color: #374151;
    font-size: 0.9rem;
    text-align: center;
  }

  .toggle-switch {
    position: relative;
    width: 3rem;
    height: 1.5rem;
    background: #d1d5db;
    border: none;
    border-radius: 1rem;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .toggle-switch.small {
    width: 2.5rem;
    height: 1.25rem;
  }

  .toggle-switch.active {
    background: #10b981;
  }

  .toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: calc(1.5rem - 4px);
    height: calc(1.5rem - 4px);
    background: white;
    border-radius: 50%;
    transition: transform 0.2s ease;
  }

  .toggle-switch.small .toggle-slider {
    width: calc(1.25rem - 4px);
    height: calc(1.25rem - 4px);
  }

  .toggle-switch.active .toggle-slider {
    transform: translateX(1.5rem);
  }

  .toggle-switch.small.active .toggle-slider {
    transform: translateX(1.25rem);
  }

  /* Staff Section */
  .staff-section {
    background: white;
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    border: 1px solid #e5e7eb;
    overflow-x: auto;
  }

  .song-info {
    text-align: center;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
    border-radius: 0.75rem;
    border: 1px solid #cbd5e1;
  }

  .song-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #1e293b;
    margin: 0 0 0.25rem 0;
  }

  .song-composer {
    font-size: 1rem;
    font-weight: 500;
    color: #64748b;
    margin: 0;
    font-style: italic;
  }

  .staff-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .staff-display {
    min-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f9fafb;
    border-radius: 0.5rem;
    padding: 1rem;
    border: 2px dashed #d1d5db;
    width: 100%;
    overflow: hidden;
  }

  .staff-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .staff-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 2rem;
    border: none;
    border-radius: 0.75rem;
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .staff-button.primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .staff-button.primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
  }

  .staff-button.secondary {
    background: linear-gradient(135deg, #64748b 0%, #475569 100%);
    color: white;
  }

  .staff-button.secondary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(100, 116, 139, 0.3);
  }

  .button-icon {
    font-size: 1.2rem;
  }

  /* Pitch Display */
  .pitch-display {
    background: white;
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    border: 1px solid #e5e7eb;
  }

  .mic-permission {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .mic-button {
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 0.75rem;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .mic-button:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(102,126,234,0.3); }
  .mic-error { color: #b91c1c; font-size: 0.9rem; }

  .pitch-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .piano-toggle {
    display: flex;
    align-items: center;
  }

  .piano-toggle-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    color: white;
    border: none;
    border-radius: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .piano-toggle-button:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
  }

  .piano-toggle-button.active {
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  }

  .piano-toggle-button.active:hover {
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
  }

  .piano-icon {
    font-size: 1.2rem;
  }

  .pitch-info {
    text-align: center;
    margin-bottom: 2rem;
  }

  .frequency-display {
    margin-bottom: 1rem;
  }

  .frequency-value {
    font-size: 4rem;
    font-weight: 700;
    font-family: 'Courier New', monospace;
    color: #667eea;
  }

  .frequency-unit {
    font-size: 1.5rem;
    color: #6b7280;
    margin-left: 0.5rem;
  }

  .note-display {
    font-size: 3rem;
    font-weight: 700;
    color: #374151;
    margin-bottom: 1rem;
  }

  .audio-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .volume-control {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .control-text {
    font-size: 0.9rem;
    color: #6b7280;
    font-weight: 500;
  }

  .volume-slider {
    width: min(100%, 300px);
    height: 6px;
    background: #e5e7eb;
    border-radius: 3px;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
  }

  .volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 20px;
    height: 20px;
    background: #667eea;
    border-radius: 50%;
    cursor: pointer;
  }

  .loudness-display {
    font-size: 0.9rem;
    color: #6b7280;
    background: #f3f4f6;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
  }

  /* Metronome Section */
  .metronome-section {
    background: white;
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    border: 1px solid #e5e7eb;
  }

  /* Responsive Design */
  @media (max-width: 1024px) {
    
    .mode-buttons {
      flex-direction: column;
      align-items: center;
    }
    
    .mode-dropdown {
      width: 100%;
      max-width: 400px;
    }
  }

  @media (max-width: 768px) {
    .main-container {
      padding: 0 1rem;
    }
    
    .app-title {
      font-size: 2.5rem;
    }
    
    .mode-selection,
    .staff-section,
    .pitch-display,
    .metronome-section {
      padding: 1.5rem;
    }
    
    .accidental-toggles {
      gap: 1rem;
    }
    
    .accidental-toggle-item {
      gap: 0.25rem;
    }
    
    .frequency-value {
      font-size: 3rem;
    }
    
    .note-display {
      font-size: 2.5rem;
    }
    
    .volume-slider {
      width: 250px;
    }
    
    .pitch-controls {
      flex-direction: column;
      align-items: stretch;
      gap: 1rem;
    }
    
    .piano-toggle {
      justify-content: center;
    }
  }

  /* Ultra-narrow phones */
  @media (max-width: 420px) {
    .main-container { padding: 0 0.5rem; }
    .app-title { font-size: clamp(1.8rem, 9vw, 2.3rem); }
    .app-subtitle { font-size: 0.95rem; }
    .mode-selection,
    .staff-section,
    .pitch-display,
    .metronome-section { padding: 1rem; }
    .toggle-group { gap: 0.75rem; }
    .auth-form { flex-direction: column; align-items: stretch; }
    .auth-button { width: 100%; }
    .volume-slider { width: 100%; }
  }
  @media (max-width: 340px) {
    .app-title { font-size: clamp(1.6rem, 10vw, 2rem); }
  }
</style>
