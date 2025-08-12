<script lang="ts">
  // Google Analytics
  if (typeof window !== 'undefined') {
    // Load Google Analytics script
    const script = document.createElement('script');
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=G-2BX4N972Z3";
    document.head.appendChild(script);
    
    // Initialize Google Analytics
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).gtag = function(...args: any[]) {
      (window as any).dataLayer.push(args);
    };
    (window as any).gtag('js', new Date());
    (window as any).gtag('config', 'G-2BX4N972Z3');
  }
  import { onMount, onDestroy } from 'svelte';
  import { YIN } from 'pitchfinder';
  import { Renderer, RenderContext, Stave, StaveNote, Voice, Formatter, Accidental, KeyManager, Beam } from 'vexflow';
  import { parseMusicXML, type MeasureData } from './analysisToStave';
  import { supabase } from '$lib/supabaseClient';
  import Metronome from './Metronome.svelte';

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

  let freq = 0, note = '--';
  let loudness = -Infinity, minDb = -35;
  let lastHeard = 0;
  let line: string[] = [];
  let target: number[] = [];
  let enableHalves  = true;
  let enableEighths = true;
  let useKeyOnly = false;
  // sub-toggles (you already have these)
let allowNaturals = true;
let allowSharps   = true;
let allowFlats    = true;

// track the in-bar state for each letter+octave
type AccType = 'nat' | 'sh' | 'fl';
let barLedger: Record<string, AccType> = {};


const accFromKey = (L: string): AccType => {
  const a = km.selectNote(L).accidental as '#'|'b'|undefined;
  return a === '#' ? 'sh' : a === 'b' ? 'fl' : 'nat';
};
const getLedger = (L: string, o: number): AccType =>
  barLedger[`${L}${o}`] ?? accFromKey(L);
const setLedger = (L: string, o: number, t: AccType) => {
  barLedger[`${L}${o}`] = t;
};



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
  });

  async function signInWithEmail() {
    if (!emailInput) return alert('Enter an email first');
    const { error } = await supabase.auth.signInWithOtp({ email: emailInput });
    if (error) alert(error.message);
    else alert('Magic link sent — check your email and click it.');
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  /* ---------- Custom Songs (Supabase) ---------- */
  type SongRow = { name: string; created_at: string };
  let customSongs: SongRow[] = [];
  let customName = '';

  function sanitizeName(s: string) {
    return (s || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  export async function loadCustomSongs() {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { customSongs = []; return; }
    const { data, error } = await supabase
      .from('songs')
      .select('name, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('loadCustomSongs error:', error.message);
      return;
    }
    customSongs = data ?? [];
  }

  async function saveCustom() {
    if (!userEmail) return alert('Sign in first.');
    const name = sanitizeName(customName);
    const xml = (userInput || '').trim();
    if (!name || !xml) return alert('Name and XML required.');

    const { data: usr } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('songs')
      .upsert(
        { user_id: usr.user?.id, name, xml },
        { onConflict: 'user_id,name' }
      );

    if (error) return alert(error.message);
    customName = '';
    await loadCustomSongs();
  }

  async function openCustom(name: string) {
    const { data, error } = await supabase
      .from('songs')
      .select('xml')
      .eq('name', name)
      .single();
    if (error) return alert('Not found');
    userInput = data!.xml;
    await setSong('', false); // render via your existing path
  }

  async function deleteCustom(name: string) {
    const { error } = await supabase.from('songs').delete().eq('name', name);
    if (error) return alert(error.message);
    await loadCustomSongs();
  }

  // keep the list in sync with auth
  onMount(() => loadCustomSongs());
  supabase.auth.onAuthStateChange((_e, s) => {
    if (s?.user) loadCustomSongs(); else customSongs = [];
  });

  /* ---------- audio/pitch ---------- */
  const MEASURE_BEATS = 4;       // 4/4
  const HIST = 5;
  const HOLD_MS = 3000;
  const BUF_SIZE = 4096;

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
  const markNoteGreen = (n: StaveNote) => n.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });

  function clearStaffContainer() {
    if (!vfDiv) return;
    while (vfDiv.firstChild) vfDiv.removeChild(vfDiv.firstChild);
  }

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

    const voice = new Voice({ numBeats: beats, beatValue: 4 }).addTickables(notes);

    const fmt = new Formatter();
    fmt.joinVoices([voice]).format([voice], 0);
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

    Beam.generateBeams(notes).forEach(b => b.setContext(ctx).draw());
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

    msreCount = -1;
    line = []; target = []; i = 0;
    gate = 'READY'; // Reset state machine
    lastNoteTime = 0;
    matchedFreq = 0;

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

      // choose a note that respects toggles and won’t need a ♮ given the ledger
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
      notes.push(new StaveNote({ keys:[keyStr], duration: choice.dur, clef: selectedClef }));
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

  renderStaff(MEASURE_BEATS);   
  console.log('📝 Generated random notes:', { line, target, notesCount: notes.length });
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
          markNoteGreen(notes[i]);
          matchedFreq = freq;
          lastNoteTime = Date.now();
          i++;
          renderStaff(MEASURE_BEATS);
          if (i === notes.length){
            if (msreCount == -1){
              generateRandomLine();
            } else {
              if (msreCount == totalMsre-1){
                // Song complete
              } else {
                msreCount++;
                renderAnalysisLine();
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
        } else if (freq && matchedFreq && isClearlyDifferent(freq, matchedFreq)) {
          gate = 'READY';
        } else if (freq && isRealNote(note) && canon(note) !== target[i]) {
          gate = 'READY';
        }
        break;
      case 'WAIT_ATTACK':
        if (loudness >= minDb) {
          gate = 'READY';
        }
        break;
    }
    raf = requestAnimationFrame(tick);
  }

  /* ─── analysis / XML rendering ───────────────────── */
  let userInput = '';
  let analysisTxt = ``;
  let xmlText:string = '';
  let measures: any;

  function getMusicXML() {
    measures = parseMusicXML(xmlText, selectedClef);
  }

  async function setSong(song:string, preset:boolean){
    if (preset){
      const filed = '/scores/' + song + '.musicxml';
      analysisTxt = filed;
      xmlText  = await fetch(analysisTxt).then(r => r.text());
    } else {
      xmlText = userInput;
    }
    msreCount = -1;
    renderAnalysisLine();
  }

  async function renderAnalysisLine() {
    if (msreCount == -1 || measures == undefined) {
      msreCount = 0;
      await getMusicXML();
    }
    if (!measures.length) return alert('Nothing parsed');

    totalMsre   = measures.length;
    notes       = measures[msreCount].notes;
    currentKeySig = measures[msreCount].key.split(' ')[0];
    km          = new KeyManager(currentKeySig);

    line = []; target = []; i = 0;
    gate = 'READY'; // Reset state machine
    lastNoteTime = 0;
    matchedFreq = 0;
    
    for (let x = 0; x < notes.length; x++) {
      const k = notes[x].keys[0];
      line.push(k.replace('/', ''));
      target.push(canon(k.replace('/', '')));
    }

    const beats = measures[msreCount].timeSignature.beats;
    const voice = new Voice({ numBeats: beats, beatValue: 4 }).addTickables(notes);

    const fmt = new Formatter();
    fmt.joinVoices([voice]).format([voice], 0);
    const minNotesWidth = fmt.getMinTotalWidth();

    vfDiv.innerHTML = '';
    const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
    renderer.resize(10, 140);
    const ctx = renderer.getContext();

    const leadIn   = measureLead(ctx, beats);
    const accCnt   = accidentalCount(currentKeySig);
    const heuristic = calcStaveWidth(notes, accCnt);
    const width    = Math.ceil(Math.max(heuristic, minNotesWidth + leadIn + 20));

    let octRejectStreak = 0;          // how many consecutive subharmonic rejections
const OCT_STREAK_LIMIT = 6;       // accept after ~6 frames (~100–200 ms)
let lastUpdate = 0;               // ms when we last accepted a pitch
const STALE_MS = 1200;            // force accept if display hasn't moved for this long


    renderer.resize(width, 140);
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

    Beam.generateBeams(notes).forEach(b => b.setContext(ctx).draw());
  }

  async function clefchanged(){
    if (msreCount == -1){
      generateRandomLine();
    } else {
      await getMusicXML();
      renderAnalysisLine();
    }
  }

  /* ---------- DOM refs ---------- */
  let vfDiv: HTMLDivElement;

  /* ---------- Metronome ---------- */
  // Remove metronome logic and state:
  // Remove lines 559-605 (all metronome state and functions)
  // ... existing code ...


  /* ---------- Preset songs ---------- */
  const songs = [
    "Ode to Joy",
    "Mary Had a Little Lamb",
    "Twinkle Twinkle Little Star",
    "Baa Baa Black Sheep",
    "Row, Row, Row Your Boat",
    "London Bridge is Falling Down",
    "Frère Jacques",
    "Jingle Bells",
    "Yankee Doodle",
    "Für Elise",
    "Minuet in G",
    "Canon in D",
    "Eine kleine Nachtmusik",
    "The Blue Danube",
    "In the Hall of the Mountain King",
    "Spring",
    "Happy Birthday",
    "Scarborough Fair",
    "Amazing Grace",
    "Oh! Susanna",
    "Aura Lee",
    "She’ll Be Comin’ Round the Mountain",
    "Home on the Range",
    "Auld Lang Syne",
    "Danny Boy",
    "Silent Night",
    "Deck the Halls",
    "We Wish You a Merry Christmas",
    "The First Noel",
    "O Christmas Tree",
    "Up on the Housetop"
  ];
  function setSongFromName(name:string) {
    setSong(name.toLowerCase().replace(/ /g, "-"), true);
  }
</script>

<!-- Auth UI -->
<div class="flex items-center gap-2 my-3">
  {#if userEmail}
    <div class="text-sm opacity-70">Signed in as {userEmail}</div>
    <button on:click={signOut} class="rounded px-3 py-2 border" aria-label="Sign out">Sign out</button>
  {:else}
    <input
      class="rounded border px-2 py-1"
      type="email"
      bind:value={emailInput}
      placeholder="you@example.com"
      aria-label="Email address"
    /> <!-- email input -->
    <button on:click={signInWithEmail} class="rounded px-3 py-2 border" aria-label="Send magic link">
      Sign in (Email)
    </button> <!-- sign in (email) -->
  {/if}
</div> <!-- auth ui -->

<div class="flex flex-col items-center justify-center h-screen gap-6 text-center">
  <h1 class="text-3xl font-bold">Music buddy</h1>

  <!-- Clef picker -->
  <label class="flex items-center gap-2">
    <span class="text-sm">Clef:</span>
    <select bind:value={selectedClef} on:change={clefchanged} class="rounded border px-2 py-1">
      {#each CLEFS as c}
        <option value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
      {/each}
    </select>
  </label>

  <!-- Key picker -->
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

  <!-- Duration toggles -->
  <div class="mt-3 flex items-center gap-6">
    <!-- Half notes toggle -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Half notes</span>
      <button
        type="button"
        aria-label="Toggle half notes on or off"
        class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition duration-200 ease-in-out"
        class:bg-green-500={enableHalves}
        class:bg-gray-300={!enableHalves}
        on:click={() => { enableHalves = !enableHalves; generateRandomLine(); }}
        aria-pressed={enableHalves}
      >
        <span
          class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
          class:translate-x-5={enableHalves}
          class:translate-x-0={!enableHalves}
        ></span>
      </button> <!-- half notes toggle -->
    </label>

    <!-- Eighth notes toggle -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Eighth notes</span>
      <button
        type="button"
        aria-label="Toggle eighth notes on or off"
        class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition duration-200 ease-in-out"
        class:bg-green-500={enableEighths}
        class:bg-gray-300={!enableEighths}
        on:click={() => { enableEighths = !enableEighths; generateRandomLine(); }}
        aria-pressed={enableEighths}
      >
        <span
          class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
          class:translate-x-5={enableEighths}
          class:translate-x-0={!enableEighths}
        ></span>
      </button> <!-- eighth notes toggle -->
    </label>

    <!-- Key-only notes toggle -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Key-only notes</span>
      <button
        type="button"
        aria-label="Toggle key-only notes on or off"
        class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition duration-200 ease-in-out"
        class:bg-green-500={useKeyOnly}
        class:bg-gray-300={!useKeyOnly}
        on:click={() => { useKeyOnly = !useKeyOnly; generateRandomLine(); }}
        aria-pressed={useKeyOnly}
      >
        <span
          class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
          class:translate-x-5={useKeyOnly}
          class:translate-x-0={!useKeyOnly}
        ></span>
      </button>
      {#if !useKeyOnly}
  <div class="flex items-center gap-6">
    <!-- Naturals -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Naturals</span>
      <button
        type="button"
        aria-label="Toggle natural accidentals"
        class="relative inline-flex h-6 w-11 rounded-full border-2 transition"
        class:bg-green-500={allowNaturals}
        class:bg-gray-300={!allowNaturals}
        on:click={() => { allowNaturals = !allowNaturals; generateRandomLine(); }}
        aria-pressed={allowNaturals}
      >
        <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition"
              class:translate-x-5={allowNaturals}
              class:translate-x-0={!allowNaturals}></span>
      </button>
    </label>

    <!-- Sharps -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Sharps</span>
      <button
        type="button"
        aria-label="Toggle sharp accidentals"
        class="relative inline-flex h-6 w-11 rounded-full border-2 transition"
        class:bg-green-500={allowSharps}
        class:bg-gray-300={!allowSharps}
        on:click={() => { allowSharps = !allowSharps; generateRandomLine(); }}
        aria-pressed={allowSharps}
      >
        <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition"
              class:translate-x-5={allowSharps}
              class:translate-x-0={!allowSharps}></span>
      </button>
    </label>

    <!-- Flats -->
    <label class="flex items-center gap-2 text-sm cursor-pointer">
      <span>Flats</span>
      <button
        type="button"
        aria-label="Toggle flat accidentals"
        class="relative inline-flex h-6 w-11 rounded-full border-2 transition"
        class:bg-green-500={allowFlats}
        class:bg-gray-300={!allowFlats}
        on:click={() => { allowFlats = !allowFlats; generateRandomLine(); }}
        aria-pressed={allowFlats}
      >
        <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition"
              class:translate-x-5={allowFlats}
              class:translate-x-0={!allowFlats}></span>
      </button>
    </label>
  </div>
{/if}
    </label>

  </div>

  <!-- Staff + controls -->
  <div bind:this={vfDiv}></div>
  <button on:click={generateRandomLine} class="my-4 rounded-md bg-blue-500 px-4 py-2 text-white">
    New Staff
  </button>

  <div class="flex flex-col items-center gap-1">
    <div class="text-6xl font-mono">{freq || '--'} Hz</div>
    <div class="text-5xl">{note}</div>
    <div class="text-sm opacity-60">State: {gate}</div>
  </div>

  <label class="flex flex-col items-center gap-1">
    <span class="text-sm">Ignore sounds quieter than {minDb} dBFS</span>
    <input type="range" min="-60" max="-10" step="1" bind:value={minDb} class="w-64 accent-blue-500" />
  </label>

  <div class="text-xs opacity-70">current loudness: {loudness.toFixed(1)} dBFS</div>
  <footer class="text-xs opacity-60">buncha updates soon for variety soon</footer>
  <Metronome {ctx} />
  <!-- Lower panel -->
  <div class="w-full mt-8 border-t bg-gray-50 p-4 flex gap-4">
    <!-- ◀ Left: free-form input + render + save -->
    <div class="flex-1 flex flex-col">
      <textarea
        bind:value={userInput}
        rows="6"
        class="flex-1 w-full rounded border p-2 text-xs resize-none"
        placeholder="Paste MusicXML here…"
      ></textarea> <!-- custom input -->

      <div class="mt-2 flex items-center gap-2 justify-end">
        <input
          class="rounded border px-2 py-1 text-sm"
          placeholder="name (letters/numbers/-/_)"
          bind:value={customName}
          aria-label="Custom song name"
        /> <!-- custom name -->
         <button
          on:click={() => setSong('', false)}
          class="rounded bg-slate-500 px-3 py-1 text-white"
        >
          Render Input
        </button> <!-- render input -->
        <button
          on:click={saveCustom}
          class="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
          disabled={!userEmail}
          aria-disabled={!userEmail}
          aria-label="Save custom song"
        >
          {userEmail ? 'Save to My Account' : 'Sign in to Save'}
        </button> <!-- save custom -->
      </div>
    </div>
    
    <!-- ▶ Right: presets + custom list (scrollable) -->
    <div class="flex-1 flex flex-col gap-4">
      <!-- Presets -->
      <div>
        <div class="mb-2 text-sm font-semibold">Presets</div>
        <div class="flex flex-col gap-2 border rounded p-2" style="max-height: 12rem; overflow-y: auto;">
          {#each songs as song}
            <button
              on:click={() => setSongFromName(song)}
              class="w-full rounded bg-purple-500 px-4 py-2 text-white text-left"
              aria-label={`Load preset ${song}`}
            >
              {song}
            </button>
          {/each}
        </div>
      </div>

      <!-- Custom songs -->
      <div>
        <div class="mb-2 text-sm font-semibold">My Custom Songs</div>
        <div class="flex flex-col gap-2 border rounded p-2" style="max-height: 12rem; overflow-y: auto;">
          {#if !userEmail}
            <div class="text-xs opacity-70">Sign in to see your songs.</div>
          {:else if customSongs.length === 0}
            <div class="text-xs opacity-70">No songs yet. Save one!</div>
          {:else}
            {#each customSongs as s}
              <div class="flex items-center gap-2">
                <button
                  class="flex-1 rounded bg-purple-500 px-3 py-1 text-white text-left"
                  on:click={() => openCustom(s.name)}
                  aria-label={`Open custom song ${s.name}`}
                >
                  {s.name}
                </button>
                <button
                  class="rounded px-2 py-1 border"
                  on:click={() => deleteCustom(s.name)}
                  aria-label={`Delete custom song ${s.name}`}
                >
                  Delete
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div> <!-- custom songs -->
  </div>
  
</div>
