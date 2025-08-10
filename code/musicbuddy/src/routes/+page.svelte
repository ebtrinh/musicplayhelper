<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { YIN } from 'pitchfinder';
  import { Renderer, RenderContext, Stave, StaveNote, Voice, Formatter, Accidental, KeyManager, Beam } from 'vexflow';
  import { parseMusicXML, type MeasureData } from './analysisToStave';
  import { supabase } from '$lib/supabaseClient';

  /* --- constants & helpers --- */
  const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const CLEFS = ['bass','alto','treble'] as const;
  type Clef = typeof CLEFS[number];
  let selectedClef: Clef = 'treble';
  let msreCount = -1;
  let totalMsre = 0;

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

  const MIN_FREQ = 40;
  const MAX_FREQ = 1200;
  const THRESH   = 0.07;
  const PROB_MIN = 0.90;
  const OCT_TOL  = 0.03;
  let   lastFreq = 0;

  const f2n = (f:number)=>`${NOTES[Math.round(12*Math.log2(f/440)+69)%12]}${Math.floor((Math.round(12*Math.log2(f/440)+69))/12)-1}`;
  const rms2db = (r:number)=>20*Math.log10(r||1e-10);

  let freq = 0, note = '--';
  let loudness = -Infinity, minDb = -35;
  let lastHeard = 0;
  let line: string[] = [];
  let target: number[] = [];
  let enableHalves  = true;
  let enableEighths = true;

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
    Accidental.applyAccidentals([voice], currentKeySig);

    new Formatter().joinVoices([voice]).formatToStave([voice], stave);
    voice.draw(ctx, stave);

    Beam.generateBeams(notes).forEach(b => b.setContext(ctx).draw());
  }

  const NOTE_LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
  function randomNote(): string {
    const OCTAVES = CLEF_RANGES[selectedClef];
    const ACC_P = 0.25; // tweak as you like
    const root  = Math.random() > ACC_P
      ? NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)]
      : (() => {
          const letter = NOTE_LETTERS[Math.floor(Math.random() * NOTE_LETTERS.length)];
          const acc    = Math.random() < 0.5 ? '#' : 'b';
          return `${letter}${acc}`;
        })();
    const octave  = OCTAVES[Math.floor(Math.random() * OCTAVES.length)];

    const sel     = km.selectNote(root);
    const keyStr  = `${sel.note}/${octave}`;

    const pretty  = sel.accidental
        ? `${sel.note[0].toUpperCase()}${sel.accidental === '#' ? '♯' : '♭'}${octave}`
        : `${sel.note.toUpperCase()}${octave}`;

    line.push(pretty);
    target.push(canon(pretty));
    return keyStr;
  }

  function generateRandomLine() {
    msreCount = -1;
    line = []; target = []; i = 0;

    currentKeySig = resolveKey();
    km = new KeyManager(currentKeySig);

    notes = [];
    let beatsLeft = MEASURE_BEATS;

    while (beatsLeft > 0) {
      const options = activeDurations(beatsLeft);
      const pickFrom = options.length ? options : DURATIONS.filter(d => d.dur === 'q');
      const choice = pickWeighted(pickFrom);

      beatsLeft -= choice.beats;

      const keyStr = randomNote();
      const note = new StaveNote({
        keys: [keyStr],
        duration: choice.dur,
        clef: selectedClef
      });

      notes.push(note);
    }

    renderStaff(MEASURE_BEATS);
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
            } else {
              if (msreCount == totalMsre-1){
                console.log("done")
              } else {
                msreCount++;
                renderAnalysisLine();
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

  /* ─── analysis / XML rendering ───────────────────── */
  let userInput = '';
  let analysisTxt = `
Composer: Traditional
Title: Hot Cross Buns – melody line
Analyst: ChatGPT demo

Time Signature: 4/4

m1 C: C4 D4 E4
m2 C: E4 D4 C4
`;
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
    for (let x = 0; x < notes.length; x++) {
      const k = notes[x].keys[0];
      line.push(k.replace('/', ''));
      target.push(canon(k.replace('/', '')));
    }

    const beats = notes.length;
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

    renderer.resize(width, 140);
    const stave = new Stave(10, 20, width)
      .addClef(selectedClef)
      .addTimeSignature(`${beats}/4`)
      .addKeySignature(currentKeySig);

    stave.setContext(ctx).draw();
    Accidental.applyAccidentals([voice], currentKeySig);

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
  let bpm = 120;
  let metroOn = false;
  let tickInterval: number | null = null;

  let beatsPerBar = 4;
  let metroIdx = 0;

  function playClick(accent = false) {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.value     = accent ? 0.35  : 0.20;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  }
  function metronomeTick() {
    playClick(metroIdx === 0);
    metroIdx = (metroIdx + 1) % beatsPerBar;
  }
  function startMetronome() {
    stopMetronome();
    metroIdx = 0;
    metronomeTick();
    tickInterval = window.setInterval(metronomeTick, 60000 / bpm);
    metroOn = true;
  }
  function stopMetronome() {
    if (tickInterval !== null) clearInterval(tickInterval);
    tickInterval = null;
    metroOn = false;
  }
  function toggleMetronome() {
    metroOn ? stopMetronome() : startMetronome();
  }
  $: if (metroOn) {
    stopMetronome();
    startMetronome();
  }
  onDestroy(() => { stopMetronome(); });

  function tsChanged() {
    const opt = TS_OPTIONS.find(o => o.label === selectedTS);
    if (opt) { beatsPerBar = opt.beats; metroIdx = 0; }
  }

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
    />
    <button on:click={signInWithEmail} class="rounded px-3 py-2 border" aria-label="Send magic link">
      Sign in (Email)
    </button>
  {/if}
</div>

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
      </button>
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
      </button>
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
  </div>

  <label class="flex flex-col items-center gap-1">
    <span class="text-sm">Ignore sounds quieter than {minDb} dBFS</span>
    <input type="range" min="-60" max="-10" step="1" bind:value={minDb} class="w-64 accent-blue-500" />
  </label>

  <div class="text-xs opacity-70">current loudness: {loudness.toFixed(1)} dBFS</div>
  <footer class="text-xs opacity-60">buncha updates soon for variety soon</footer>

  <!-- Lower panel -->
  <div class="w-full mt-8 border-t bg-gray-50 p-4 flex gap-4">
    <!-- ◀ Left: free-form input + render + save -->
    <div class="flex-1 flex flex-col">
      <textarea
        bind:value={userInput}
        rows="6"
        class="flex-1 w-full rounded border p-2 text-xs resize-none"
        placeholder="Paste MusicXML here…"
      ></textarea>

      <div class="mt-2 flex items-center gap-2 justify-end">
        <input
          class="rounded border px-2 py-1 text-sm"
          placeholder="name (letters/numbers/-/_)"
          bind:value={customName}
          aria-label="Custom song name"
        />
        <button
          on:click={() => setSong('', false)}
          class="rounded bg-slate-500 px-3 py-1 text-white"
        >
          Render Input
        </button>
        <button
          on:click={saveCustom}
          class="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
          disabled={!userEmail}
          aria-disabled={!userEmail}
          aria-label="Save custom song"
        >
          {userEmail ? 'Save to My Account' : 'Sign in to Save'}
        </button>
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
    </div>
  </div>
</div>
