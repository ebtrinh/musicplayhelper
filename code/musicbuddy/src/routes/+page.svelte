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
  let isLoadingSong = false;
  let selectedSongKey = 'Random'; // Key filter for Random Song Mode
  // Random Song Mode 8-note system
  const SONG_NOTE_CAP = 8;
  let songNotesCollected = 0;         // notes collected for current 8-note segment
  let originalCollectedNotes: StaveNote[] = []; // original notes before octave shifting
  let originalCollectedKeys: string[] = [];     // original keys before octave shifting
  
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

// ========================================
// CLEAN RENDERING SYSTEM - REWRITTEN FROM SCRATCH
// ========================================

interface RenderState {
  originalNotes: StaveNote[];     // Original notes from parsing
  playableNotes: StaveNote[];     // Notes that can be played (no rests)
  renderedNotes: StaveNote[];     // Fresh notes for VexFlow rendering
  currentProgress: number;        // Index in playableNotes
  timeSignature: { beats: number; beatType: number };
  hasBeenPadded: boolean;         // Prevent re-padding
}

let renderState: RenderState | null = null;

function beatsFromNotes(ns: StaveNote[]) {
  const toBeat = (dur: string) => {
    const d = dur.replace('r','');   // rest or not, both count the same for timing
    if (d === 'w') return 4;
    if (d === 'h') return 2;
    if (d === 'q') return 1;
    if (d === '8') return 0.5;
    if (d === '16') return 0.25;
    if (d === '32') return 0.125;
    return 1;
  };
  return ns.reduce((sum, n) => sum + toBeat(n.getDuration()), 0);
}

function isRestNote(note: StaveNote): boolean {
  try {
    const anyNote = note as any;
    const dur: string = typeof note.getDuration === 'function' ? note.getDuration() : '';
    const hasRInDuration = typeof dur === 'string' && dur.includes('r');
    const flagRest = anyNote?.rest === true || anyNote?.noteType === 'r';
    const methodRest = typeof anyNote?.isRest === 'function' ? !!anyNote.isRest() : false;
    return hasRInDuration || flagRest || methodRest;
  } catch {
    return false;
  }
}

function getCenterLineKey(clef: Clef): string {
  // Return the center line key for each clef
  switch (clef) {
    case 'treble': return 'b/4';  // B4 is center line for treble clef
    case 'alto': return 'd/4';    // D4 is center line for alto clef  
    case 'bass': return 'd/3';    // D3 is center line for bass clef
    default: return 'b/4';        // Default to treble
  }
}

function createFreshNote(originalNote: StaveNote, isCompleted: boolean = false): StaveNote {
  try {
    const duration = originalNote.getDuration();
    const keys = originalNote.getKeys();
    
    // Validate required properties
    if (!duration || !keys || keys.length === 0) {
      console.error('❌ Invalid original note properties:', { duration, keys });
      throw new Error(`Invalid note properties: duration=${duration}, keys=${keys}`);
    }
    
    // For rests, we need to ensure they're created properly and remain as rests
    if (isRestNote(originalNote)) {
      const restNote = new StaveNote({
        keys: [getCenterLineKey(selectedClef)], // Always use center line for current clef
        duration: (() => {
          // Ensure rest duration contains 'r' for VexFlow to keep it a rest
          if (typeof duration === 'string' && duration.includes('r')) return duration;
          const base = typeof duration === 'string' ? duration : 'q';
          const allowed = new Set(['w','h','q','8','16','32']);
          const core = allowed.has(base) ? base : 'q';
          return `${core}r`;
        })(),
        clef: selectedClef
      });
      
      // Explicitly set rest properties to ensure VexFlow recognizes it as a rest
      (restNote as any).rest = true;
      (restNote as any).noteType = 'r';
      
      // Set the isRest method to always return true
      (restNote as any).isRest = () => true;
      
      // Copy any additional rest-specific properties from the original
      const originalAny = originalNote as any;
      if (originalAny.glyph) {
        (restNote as any).glyph = originalAny.glyph;
      }
      
      // Ensure the note maintains its rest status through various VexFlow operations
      Object.defineProperty(restNote, 'rest', {
        value: true,
        writable: false,
        enumerable: true,
        configurable: false
      });
      
      return restNote;
    } else {
      // Create a regular note
      const newNote = new StaveNote({
        keys: keys,
        duration: duration,
        clef: selectedClef,
        autoStem: true
      });
      
      // Apply green styling if completed
      if (isCompleted) {
        try {
          newNote.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });
        } catch (styleError) {
          console.warn('❌ Error applying note style:', styleError);
        }
      }
      
      return newNote;
    }
  } catch (error) {
    console.error('❌ Error creating fresh note:', error);
    // Create a simple fallback note
    return new StaveNote({
      keys: ['c/4'],
      duration: 'q',
      clef: selectedClef
    });
  }
}

function initializeRenderState(originalNotes: StaveNote[], timeSignature: { beats: number; beatType: number }) {
  // Extract only playable notes (non-rests)
  const playableNotes = originalNotes.filter(note => !isRestNote(note));
  
  renderState = {
    originalNotes: [...originalNotes],
    playableNotes,
    renderedNotes: [],
    currentProgress: 0,
    timeSignature,
    hasBeenPadded: false
  };
  

}

function prepareNotesForRendering(): { notes: StaveNote[], timeSignature: { beats: number; beatType: number } } {
  if (!renderState) {
    throw new Error('Render state not initialized');
  }

  // Create fresh copies of all original notes with current progress styling
  const freshNotes = renderState.originalNotes.map((originalNote, index) => {
    let isCompleted = false;
    const isRest = isRestNote(originalNote);
    
    if (!isRest) {
      const playableIndex = renderState!.originalNotes
        .slice(0, index)
        .filter(n => !isRestNote(n)).length;
      isCompleted = playableIndex < renderState!.currentProgress;
    }
    
    return createFreshNote(originalNote, isCompleted);
  });

  // Handle measure padding (only once)
  let finalNotes = [...freshNotes];
  let finalTimeSignature = renderState.timeSignature;
  
  if (!renderState.hasBeenPadded) {
    const actualBeats = beatsFromNotes(freshNotes);
    const expectedBeats = renderState.timeSignature.beats;
    
    if (actualBeats < expectedBeats - 0.1) {
      let missingBeats = expectedBeats - actualBeats;
      while (missingBeats >= 1) {
        const quarterRest = new StaveNote({ 
          keys: [getCenterLineKey(selectedClef)], 
          duration: 'qr',
          clef: selectedClef 
        });
        (quarterRest as any).rest = true;
        (quarterRest as any).noteType = 'r';
        (quarterRest as any).isRest = () => true;
        // Make rest property immutable
        Object.defineProperty(quarterRest, 'rest', {
          value: true,
          writable: false,
          enumerable: true,
          configurable: false
        });
        finalNotes.push(quarterRest);
        missingBeats -= 1;
      }
      if (missingBeats >= 0.5) {
        const eighthRest = new StaveNote({ 
          keys: [getCenterLineKey(selectedClef)], 
          duration: '8r',
          clef: selectedClef 
        });
        (eighthRest as any).rest = true;
        (eighthRest as any).noteType = 'r';
        (eighthRest as any).isRest = () => true;
        // Make rest property immutable
        Object.defineProperty(eighthRest, 'rest', {
          value: true,
          writable: false,
          enumerable: true,
          configurable: false
        });
        finalNotes.push(eighthRest);
      }
      
      renderState.hasBeenPadded = true;
      renderState.originalNotes = finalNotes;
    }
  }
  
  return { notes: finalNotes, timeSignature: finalTimeSignature };
}

function renderStaffClean() {
  if (!vfDiv || !renderState) {
    console.error('❌ RENDER ERROR: missing vfDiv or renderState');
    vfDiv && (vfDiv.innerHTML = '<div style="padding: 20px; text-align: center; color: red;">Rendering error: Missing required components</div>');
    return;
  }

  try {
    const { notes: notesToRender, timeSignature } = prepareNotesForRendering();
    
    // Normalize rests to guarantee they render as rests on every re-render
    const normalizedNotes: StaveNote[] = notesToRender.map((n, idx) => {
      try {
        if (isRestNote(n)) {
          const dur = n.getDuration?.() ?? 'q';
          const base = typeof dur === 'string' ? dur.replace('r','') : 'q';
          const ensured = (typeof dur === 'string' && dur.includes('r')) ? dur : `${base}r`;
          const restNote = new StaveNote({
            keys: [getCenterLineKey(selectedClef)],
            duration: ensured,
            clef: selectedClef
          });
          (restNote as any).rest = true;
          (restNote as any).noteType = 'r';
          (restNote as any).isRest = () => true;
          Object.defineProperty(restNote, 'rest', {
            value: true,
            writable: false,
            enumerable: true,
            configurable: false
          });
          return restNote;
        }
      } catch {}
      return n;
    });
    
    if (!notesToRender || notesToRender.length === 0) {
      throw new Error('No notes to render');
    }
    
    console.log(`🎼 RENDER: Processing ${notesToRender.length} notes`);
    
    // Create Voice with proper timing
    const voice = new Voice({ 
      numBeats: timeSignature.beats, 
      beatValue: timeSignature.beatType 
    });
    
    if ((voice as any).setStrict) {
      (voice as any).setStrict(false);
    }
    
    // Validate each note before adding to voice
    const validNotes: StaveNote[] = [];
    for (let i = 0; i < normalizedNotes.length; i++) {
      const note = normalizedNotes[i];
      try {
        if (!note.getDuration || !note.getKeys) {
          console.error(`❌ RENDER ERROR: Note ${i} missing methods:`, {
            hasDuration: !!note.getDuration,
            hasGetKeys: !!note.getKeys,
            note: note
          });
          continue;
        }
        
        const duration = note.getDuration();
        const keys = note.getKeys();
        
        if (!duration || !keys || keys.length === 0) {
          console.error(`❌ RENDER ERROR: Note ${i} invalid data:`, { duration, keys });
          continue;
        }
        
        validNotes.push(note);
      } catch (noteError) {
        console.error(`❌ RENDER ERROR: Note ${i} validation failed:`, noteError);
      }
    }
    
    if (validNotes.length === 0) {
      throw new Error('No valid notes to render');
    }
    
    console.log(`🎼 RENDER: ${validNotes.length} valid notes`);
    
    voice.addTickables(validNotes);
    
    // Calculate stave dimensions
    const formatter = new Formatter();
    formatter.joinVoices([voice]).preFormat();
    const minWidth = formatter.getMinTotalWidth();
    const accCount = accidentalCount(currentKeySig);
    const heuristicWidth = calcStaveWidth(validNotes, accCount);
    
    // Create renderer
    vfDiv.innerHTML = '';
    const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
    const width = Math.max(minWidth + 40, heuristicWidth, 300);
    renderer.resize(width, 140);
    
    const ctx = renderer.getContext();
    if (!ctx) {
      throw new Error('Failed to get rendering context');
    }
    
    // Create and draw stave
    const stave = new Stave(10, 20, width - 20)
      .addClef(selectedClef)
      .addTimeSignature(`${timeSignature.beats}/${timeSignature.beatType}`)
      .addKeySignature(currentKeySig);
    
    stave.setContext(ctx).draw();
    
    // Apply accidentals
    if (useKeyOnly) {
      stripAccidentalsFromNotes(validNotes);
    } else if (!allowNaturals) {
      stripAccidentalsFromNotes(validNotes);
      addAccidentalsFromKeys(validNotes);
    } else {
      Accidental.applyAccidentals([voice], currentKeySig);
    }
    
    // Beam generation disabled - eighth notes will show individual flags
    let beams: any[] = [];
    
    // Set context for all notes
    validNotes.forEach((note, index) => {
      try {
        if (!note.getContext()) {
          note.setContext(ctx);
        }
      } catch (contextError) {
        console.error(`❌ RENDER ERROR: Context setting failed for note ${index}:`, contextError);
      }
    });
    
    console.log('🎼 RENDER: Formatting and drawing voice...');
    formatter.formatToStave([voice], stave);
    
    voice.draw(ctx, stave);
    
    // Beam drawing disabled - eighth notes will show individual flags
    
    // Make SVG responsive
    const svgRoot = vfDiv.querySelector('svg');
    if (svgRoot) {
      svgRoot.setAttribute('viewBox', `0 0 ${width} 140`);
      svgRoot.setAttribute('preserveAspectRatio', 'xMinYMin meet');
      (svgRoot as SVGSVGElement).style.width = '100%';
      (svgRoot as SVGSVGElement).style.height = 'auto';
      (svgRoot as SVGSVGElement).style.display = 'block';
    }
    
    notes = validNotes;
    console.log(`✅ RENDER: Complete - ${validNotes.length} notes rendered`);
    
  } catch (error) {
    console.error('❌ RENDER ERROR:', error);
    vfDiv.innerHTML = '<div style="padding: 20px; text-align: center; color: red;">Error rendering staff - please try again</div>';
  }
}

function advanceProgress() {
  if (!renderState) return false;
  
  if (renderState.currentProgress < renderState.playableNotes.length) {
    renderState.currentProgress++;
    console.log(`🎯 Progress: ${renderState.currentProgress}/${renderState.playableNotes.length}`);
    return true;
  }
  return false;
}

function getCurrentPlayableNote(): StaveNote | null {
  if (!renderState || renderState.currentProgress >= renderState.playableNotes.length) {
    return null;
  }
  return renderState.playableNotes[renderState.currentProgress];
}

function isGameComplete(): boolean {
  return renderState ? renderState.currentProgress >= renderState.playableNotes.length : false;
}

// DISABLED: Group consecutive beamable notes for manual beam creation
// function groupConsecutiveBeamableNotes(notes: StaveNote[]): StaveNote[][] {
//   // Function disabled - beaming has been removed
//   return [];
// }

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
    // Skip rest notes - they don't have accidentals
    if (isRestNote(n)) return;
    
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
    // Skip rest notes - they don't have accidentals
    if (isRestNote(n)) return;
    
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
      console.log('🟢 Marking note green:', { note: n?.getKeys?.(), duration: n?.getDuration?.() });
      // Safely set the note style
      if (n && typeof n.setStyle === 'function') {
        n.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });
        console.log('✅ Note marked green successfully');
      } else {
        console.warn('❌ Note does not have setStyle method:', n);
      }
    } catch (error) {
      console.warn('❌ Error marking note green:', error);
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

  // Legacy function - redirects to new clean rendering system
  function renderStaff(beats: number): void {
    renderStaffClean();
  }

  function renderStaffOLD(beats: number): void {
    if (!vfDiv) return;
    if (!notes || notes.length === 0) return;

    try {
      // Calculate actual beats from notes
      const actualBeats = beatsFromNotes(notes);
      const expectedBeats = beats;
      
      // If there's a significant mismatch, pad with rests or adjust beats
      let adjustedBeats = beats;
      // Create fresh copies of notes to avoid context issues
      // Apply green styling to matched notes
      let paddedNotes = notes.map((note, idx) => {
        // Preserve rest information when creating fresh notes
        const isRest = note.getDuration().includes('r');
        const newNote = new StaveNote({
          keys: note.getKeys(),
          duration: note.getDuration(),
          clef: selectedClef,
          autoStem: true
        });
        
        // Mark notes as green if they've been matched (idx < i) and not a rest
        if (idx < i && !isRest) {
          newNote.setStyle({ fillStyle: GREEN, strokeStyle: GREEN });
        }
        
        return newNote;
      });
      
      // Only pad if we don't already have rests (to prevent re-padding on re-renders)
      const hasRests = paddedNotes.some(note => note.getDuration().includes('r'));
      
      if (Math.abs(actualBeats - expectedBeats) > 0.1 && !hasRests) {
        if (actualBeats < expectedBeats) {
          // Pad with rests to fill the measure
          const missingBeats = expectedBeats - actualBeats;
          console.log(`📏 Padding measure: ${actualBeats} beats → ${expectedBeats} beats (adding ${missingBeats} beats of rests)`);
          
          // Add quarter rests to fill the gap
          let remainingBeats = missingBeats;
          while (remainingBeats >= 1) {
            const quarterRest = new StaveNote({ 
              keys: [getCenterLineKey(selectedClef)], 
              duration: 'qr', // quarter rest
              clef: selectedClef 
            });
            (quarterRest as any).rest = true;
            (quarterRest as any).noteType = 'r';
            (quarterRest as any).isRest = () => true;
            // Make rest property immutable
            Object.defineProperty(quarterRest, 'rest', {
              value: true,
              writable: false,
              enumerable: true,
              configurable: false
            });
            paddedNotes.push(quarterRest);
            remainingBeats -= 1;
          }
          
          // Add eighth rest if needed
          if (remainingBeats >= 0.5) {
            const eighthRest = new StaveNote({ 
              keys: [getCenterLineKey(selectedClef)], 
              duration: '8r', // eighth rest
              clef: selectedClef 
            });
            (eighthRest as any).rest = true;
            (eighthRest as any).noteType = 'r';
            (eighthRest as any).isRest = () => true;
            // Make rest property immutable
            Object.defineProperty(eighthRest, 'rest', {
              value: true,
              writable: false,
              enumerable: true,
              configurable: false
            });
            paddedNotes.push(eighthRest);
            remainingBeats -= 0.5;
          }
          
          adjustedBeats = expectedBeats;
        } else {
          // Too many beats - use actual beats
          adjustedBeats = Math.max(1, normalizeBeats(actualBeats));
        }
      }
      
      const voice = new Voice({ numBeats: adjustedBeats, beatValue: 4 });
      // Always use soft mode to handle timing mismatches gracefully
      if ((voice as any).setStrict) {
        (voice as any).setStrict(false);
      } else if ((voice as any).setMode && (Voice as any).Mode) {
        (voice as any).setMode((Voice as any).Mode.SOFT);
      }
      voice.addTickables(paddedNotes);
      
      // Update the global notes array to reference the rendered notes so markNoteGreen works
      notes = paddedNotes;

      const fmt = new Formatter();
      fmt.joinVoices([voice]).preFormat();
      const minNotesWidth = fmt.getMinTotalWidth();

      vfDiv.innerHTML = '';
      const renderer = new Renderer(vfDiv, Renderer.Backends.SVG);
      renderer.resize(10, 140);
      // Calculate dimensions first
      const accCnt = accidentalCount(currentKeySig);
      const heuristic = calcStaveWidth(notes, accCnt);
      
      // Get initial context for measuring
      let ctx = renderer.getContext();
      if (!ctx) {
        console.error('Failed to get initial rendering context');
        return;
      }
      
      const leadIn = measureLead(ctx, beats);
      const width = Math.ceil(Math.max(heuristic, minNotesWidth + leadIn + 20));

      // Resize and get a fresh context
      renderer.resize(width, 140);
      ctx = renderer.getContext();
      
      if (!ctx) {
        console.error('Failed to get rendering context after resize');
        return;
      }
      
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
        .addTimeSignature(`${adjustedBeats}/4`)
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
      
      // Draw voice with error handling
      try {
        voice.draw(ctx, stave);
      } catch (voiceDrawError) {
        console.error('Error drawing voice:', voiceDrawError);
        
        // Completely recreate the renderer and context
        try {
          vfDiv.innerHTML = '';
          const newRenderer = new Renderer(vfDiv, Renderer.Backends.SVG);
          newRenderer.resize(width, 140);
          const newCtx = newRenderer.getContext();
          
          // Make SVG responsive again
          const svgRoot = vfDiv.querySelector('svg');
          if (svgRoot) {
            svgRoot.setAttribute('viewBox', `0 0 ${width} 140`);
            svgRoot.setAttribute('preserveAspectRatio', 'xMinYMin meet');
            (svgRoot as SVGSVGElement).style.width = '100%';
            (svgRoot as SVGSVGElement).style.height = 'auto';
            (svgRoot as SVGSVGElement).style.display = 'block';
          }
          
          // Recreate and draw the stave
          const newStave = new Stave(10, 20, width)
            .addClef(selectedClef)
            .addTimeSignature(`${adjustedBeats}/4`)
            .addKeySignature(currentKeySig);
          
          newStave.setContext(newCtx).draw();
          
          // Re-apply accidentals to notes
          if (useKeyOnly) {
            stripAccidentalsFromNotes(paddedNotes);
          } else if (!allowNaturals) {
            stripAccidentalsFromNotes(paddedNotes);
            addAccidentalsFromKeys(paddedNotes);
          } else {
            Accidental.applyAccidentals([voice], currentKeySig);
          }
          
          // Reset all notes to ensure they don't have stale context references
          paddedNotes.forEach(note => {
            if ((note as any).stave) {
              (note as any).stave = null;
            }
            if ((note as any).context) {
              (note as any).context = null;
            }
          });
          
          // Format and draw with new context
          new Formatter().joinVoices([voice]).formatToStave([voice], newStave);
          voice.draw(newCtx, newStave);
          
          // Update ctx for beam drawing and ensure notes array is updated
          ctx = newCtx;
          notes = paddedNotes; // Ensure markNoteGreen works after recreation too
          
        } catch (retryError) {
          console.error('❌ Renderer recreation failed:', retryError);
          throw retryError;
        }
      }

      // Beam generation disabled - eighth notes will show individual flags instead
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
    console.log('🎲 GENERATING RANDOM LINE CALLED:', {
      randomSongMode,
      msreCount,
      stackTrace: new Error().stack?.split('\n').slice(1, 4)
    });
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
  
  // Initialize new render state with generated notes
  const timeSignature = { beats: MEASURE_BEATS, beatType: 4 };
  initializeRenderState(notes, timeSignature);
  
  // Render using new system
  renderStaffClean();
  
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
        const currentTargetIndex = renderState?.currentProgress || 0;
        if (isRealNote(note) && currentTargetIndex < target.length) {
          const targetLabel = line[currentTargetIndex] || '';
          console.log('🎯 NOTE COMPARISON: Microphone detected:', note, '| Target:', targetLabel);
          
          if (canon(note) === target[currentTargetIndex]) {
            // additionally, block an immediate match if this is the first note and equals previous first target
            if (currentTargetIndex === 0 && prevTargetFirst !== null && prevTargetFirst === target[0] && !haveGoneQuiet) {
              // wait for genuine new attack
              break;
            }
            const matchedLabel = line[renderState?.currentProgress || 0] || '';
            gaEvent('correct_note', {
              index: renderState?.currentProgress || 0,
              label: matchedLabel,
              clef: selectedClef,
              key: currentKeySig
            });
            
            matchedFreq = freq;
            lastNoteTime = Date.now();
            
            // Advance progress in new system
            const hasMoreNotes = advanceProgress();
            
            // Re-render with new progress
            renderStaffClean();
          }
          if (isGameComplete()){
            console.log('🔍 GAME COMPLETE DETECTED:', {
              randomSongMode,
              msreCount,
              autoNext,
              measuresLength: measures?.length || 0,
              totalMsre,
              currentProgress: renderState?.currentProgress,
              playableNotesLength: renderState?.playableNotes?.length
            });
            
            if (randomSongMode) {
              // Random Song Mode: 8-note segment completed
              console.log('🎵 Random Song Mode: 8-note segment completed');
              if (autoNext) {
                console.log('🔄 Auto-next enabled: advancing to next random song');
                // Auto-advance to next random song
                nextRandomSong().then(() => {
                  gate = 'WAIT_ATTACK'; haveGoneQuiet = false; matchedFreq = 0;
                  deferNextFrame = true;
                });
                break;
              }
              console.log('⏸️ Auto-next disabled: stopping and waiting');
              // Auto-next off - just stop and wait for user action
            } else if (msreCount == -1) {
              // Random Note Mode completion
              console.log('🎲 Random Note Mode completion detected');
              if (autoNext) {
                console.log('🔄 Auto-next enabled: generating new random line');
                generateRandomLine();
                gate = 'WAIT_ATTACK'; haveGoneQuiet = false; matchedFreq = 0;
                deferNextFrame = true;
                break;
              }
              console.log('⏸️ Auto-next disabled: stopping and waiting');
              // Auto-next off - just stop and wait for user action
            } else {
              // Regular song mode progression
              console.log('🎼 Regular Song Mode progression');
              if (msreCount == totalMsre-1){
                console.log('📝 Song complete - no auto-advance in regular mode');
                // Song complete - no auto-advance in regular mode
              } else {
                console.log('➡️ Advancing to next measure:', msreCount + 1);
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



  // Manual pitch transposition for songs (in semitones)
  let manualTransposition = 0;

  function generateRandomSongSegment() {
    console.log('🎵 GENERATING RANDOM SONG SEGMENT CALLED:', {
      randomSongMode,
      msreCount,
      measuresLength: measures?.length || 0,
      stackTrace: new Error().stack?.split('\n').slice(1, 4)
    });
    
    if (!measures || measures.length === 0) {
      console.log('❌ No measures available in Random Song Mode - this should not happen');
      return;
    }

    // Pick a random starting measure
    const startMeasureIndex = Math.floor(Math.random() * measures.length);
    console.log(`🎯 Random measure selection: Starting from measure ${startMeasureIndex + 1} of ${measures.length} total measures`);

    const collectedNotes: StaveNote[] = [];
    const collectedKeys: string[] = [];
    let currentMeasureIndex = startMeasureIndex;
    songNotesCollected = 0;

    // Collect exactly 8 notes across measures, starting from random measure
    while (songNotesCollected < SONG_NOTE_CAP && currentMeasureIndex < measures.length) {
      const measure = measures[currentMeasureIndex];
      
      for (const note of measure.notes) {
        if (songNotesCollected >= SONG_NOTE_CAP) break;
        
        if (!isRestNote(note)) {
          const keys = note.getKeys();
          let selectedKey = keys[0];
          
          // Handle chords by selecting the highest note
          if (keys.length > 1) {
            selectedKey = [...keys].sort((a, b) => {
              const pitchA = canon(a.replace('/', ''));
              const pitchB = canon(b.replace('/', ''));
              return pitchB - pitchA; // highest first
            })[0];
            console.log(`🎵 Chord detected, selected highest note: ${selectedKey} from [${keys.join(', ')}]`);
          }
          
          // Create note with current clef (no octave shifting here - do it later)
          const newNote = new StaveNote({
            keys: [selectedKey],
            duration: 'q', // Standardize to quarter notes
            clef: selectedClef,
            autoStem: true
          });
          
          collectedNotes.push(newNote);
          // Keep original case for now, will uppercase for display later
          collectedKeys.push(selectedKey.replace('/', ''));
          songNotesCollected++;
          
          console.log(`📝 Collected note ${songNotesCollected}: ${selectedKey.replace('/', '').toUpperCase()}`);
        }
      }
      
      currentMeasureIndex++;
      
      // Wrap around to beginning if we reach the end and still need more notes
      if (currentMeasureIndex >= measures.length && songNotesCollected < SONG_NOTE_CAP) {
        currentMeasureIndex = 0;
        console.log('🔄 Wrapped around to beginning of song');
        
        // Prevent infinite loop if song has no playable notes
        if (songNotesCollected === 0) {
          console.log('❌ No playable notes found in entire song');
          return;
        }
      }
      
      // Prevent infinite loop if we've gone through entire song again
      if (currentMeasureIndex === startMeasureIndex && songNotesCollected > 0) {
        console.log('🛑 Completed full cycle through song');
        break;
      }
    }

    console.log(`✅ Collected ${songNotesCollected} notes for 8-note segment`);

    // Store the original notes and full keys before any octave shifting
    originalCollectedNotes = [...collectedNotes];
    originalCollectedKeys = collectedNotes.map(note => note.getKeys()[0]); // Store full keys like "f#/4"

    // Apply pitch transposition if needed
    applyTranspositionToCollectedNotes();
    
    // Get key signature from first measure
    const firstMeasure = measures[startMeasureIndex];
    currentKeySig = firstMeasure.key.split(' ')[0];
    km = new KeyManager(currentKeySig);

    // Reset game state
    prevTargetFirst = null;
    gate = 'WAIT_ATTACK';
    lastNoteTime = 0;
    matchedFreq = 0;
    haveGoneQuiet = false;

    // Use simple time signature that accommodates our notes
    const timeSignature = { beats: Math.max(4, Math.min(8, notes.length)), beatType: 4 };
    currentBeats = timeSignature.beats;
    
    // Initialize rendering system
    initializeRenderState(notes, timeSignature);
    renderStaffClean();
    
    console.log(`🎼 Random song segment ready: ${line.join(', ')}`);
  }

  function applyTranspositionToCollectedNotes() {
    if (originalCollectedKeys.length === 0) return;
    
    // Apply semitone transposition to the original collected notes
    const transposedNotes: StaveNote[] = [];
    const transposedKeys: string[] = [];
    
    for (let i = 0; i < originalCollectedKeys.length; i++) {
      const originalFullKey = originalCollectedKeys[i]; // e.g., "f#/4"
      
      // Apply semitone transposition
      let transposedFullKey = originalFullKey;
      if (manualTransposition !== 0) {
        transposedFullKey = transposeBySemitones(originalFullKey, manualTransposition);
      }
      
      // Create new note with transposed pitch
      const transposedNote = new StaveNote({
        keys: [transposedFullKey],
        duration: 'q',
        clef: selectedClef,
        autoStem: true
      });
      
      transposedNotes.push(transposedNote);
      // Keep original case, will uppercase for display later
      transposedKeys.push(transposedFullKey.replace('/', ''));
    }
    
    // Set the transposed notes as current
    notes = transposedNotes;
    line = transposedKeys.map(key => {
      // Uppercase only the first letter for display
      return key.charAt(0).toUpperCase() + key.slice(1);
    });
    target = transposedKeys.map(canon); // Use original case for canon function
    
    console.log(`🎵 Applied ${manualTransposition} semitone transposition to collected notes`);
  }

  function transposeBySemitones(noteKey: string, semitones: number): string {
    // Parse the note key (e.g., "f#/4")
    const parts = noteKey.split('/');
    if (parts.length !== 2) return noteKey;
    
    const notePart = parts[0];
    const octave = parseInt(parts[1]);
    
    // Convert note to semitone number (C = 0, C# = 1, D = 2, etc.)
    const noteToSemitone: Record<string, number> = {
      'c': 0, 'c#': 1, 'db': 1, 'd': 2, 'd#': 3, 'eb': 3, 'e': 4, 'f': 5,
      'f#': 6, 'gb': 6, 'g': 7, 'g#': 8, 'ab': 8, 'a': 9, 'a#': 10, 'bb': 10, 'b': 11
    };
    
    const semitoneToNote: string[] = [
      'c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'
    ];
    
    const currentSemitone = noteToSemitone[notePart.toLowerCase()];
    if (currentSemitone === undefined) return noteKey;
    
    // Calculate new semitone position
    let newSemitone = currentSemitone + semitones;
    let newOctave = octave;
    
    // Handle octave changes
    while (newSemitone >= 12) {
      newSemitone -= 12;
      newOctave++;
    }
    while (newSemitone < 0) {
      newSemitone += 12;
      newOctave--;
    }
    
    // Keep octave in reasonable range
    newOctave = Math.max(1, Math.min(8, newOctave));
    
    return `${semitoneToNote[newSemitone]}/${newOctave}`;
  }

  async function renderAnalysisLine() {
    console.log('📋 RENDER ANALYSIS LINE CALLED:', {
      randomSongMode,
      msreCount,
      measuresLength: measures?.length || 0,
      stackTrace: new Error().stack?.split('\n').slice(1, 4)
    });
    
    if (!vfDiv) return;
    
    if (randomSongMode) {
      // Random Song Mode: Generate 8-note segment from random measure
      console.log('🎵 Random Song Mode detected - calling generateRandomSongSegment');
      generateRandomSongSegment();
      return;
    }
    
    // Check if this should be Random Note Mode instead
    if (msreCount == -1 && (!measures || measures.length === 0)) {
      console.log('🎲 Switching to Random Note Mode');
      generateRandomLine();
      return;
    }
    
    // Regular song mode logic
    if (msreCount == -1 || measures == undefined) {
      msreCount = 0;
      const parseSuccess = getMusicXML();
      if (!parseSuccess) {
        console.log('Parse failed in regular song mode');
        return;
      }
    }
    
    if (!measures.length) {
      console.log('No measures parsed from MusicXML');
      return;
    }

    // Set up measure data
    totalMsre = measures.length;
    const currentMeasure = measures[msreCount];
    notes = currentMeasure.notes;
    currentKeySig = currentMeasure.key.split(' ')[0];
    km = new KeyManager(currentKeySig);

    // Debug: Log original notes before any transposition
    console.log('🎼 Original notes from MusicXML:', notes.map(n => ({ 
      keys: n.getKeys(), 
      duration: n.getDuration(),
      isRest: isRestNote(n),
      rawDuration: n.getDuration(),
      hasRestInDuration: n.getDuration().includes('r')
    })));
    
    // Apply manual octave shifting
    if (manualTransposition !== 0) {
      console.log(`🎵 Applying manual octave shift of ${manualTransposition} octaves`);
      notes = notes.map(note => {
        // Don't transpose rests - they have no pitch, but center them on current clef
        if (isRestNote(note)) {
          const restNote = new StaveNote({
            keys: [getCenterLineKey(selectedClef)], // Always center rests on current clef
            duration: note.getDuration(),
            clef: selectedClef,
            autoStem: true
          });
          // Set rest properties
          (restNote as any).rest = true;
          (restNote as any).noteType = 'r';
          (restNote as any).isRest = () => true;
          Object.defineProperty(restNote, 'rest', {
            value: true,
            writable: false,
            enumerable: true,
            configurable: false
          });
          return restNote;
        }
        
        const originalKeys = note.getKeys();
        const transposedKeys = originalKeys.map(key => 
          transposeNote(key, manualTransposition)
        );
        
        return new StaveNote({
          keys: transposedKeys,
          duration: note.getDuration(),
          clef: selectedClef,
          autoStem: true
        });
      });
    } else {
      // No octave shift - recreate notes with current clef
      notes = notes.map(note => {
        if (isRestNote(note)) {
          const restNote = new StaveNote({
            keys: [getCenterLineKey(selectedClef)], // Always center rests on current clef
            duration: note.getDuration(),
            clef: selectedClef,
            autoStem: true
          });
          // Set rest properties
          (restNote as any).rest = true;
          (restNote as any).noteType = 'r';
          (restNote as any).isRest = () => true;
          Object.defineProperty(restNote, 'rest', {
            value: true,
            writable: false,
            enumerable: true,
            configurable: false
          });
          return restNote;
        }
        
        return new StaveNote({
          keys: note.getKeys(),
          duration: note.getDuration(),
          clef: selectedClef,
          autoStem: true
        });
      });
    }

    // Prepare game state
    prevTargetFirst = target.length ? target[0] : null;
    line = []; 
    target = []; 
    gate = 'WAIT_ATTACK';
    lastNoteTime = 0;
    matchedFreq = 0;
    haveGoneQuiet = false;
    
    // Build target arrays for game logic - only include playable notes (skip rests)
    for (let x = 0; x < notes.length; x++) {
      const note = notes[x];
      if (!isRestNote(note)) {
        const k = typeof note.getKeys === 'function' ? note.getKeys()[0] : (note as any).keys?.[0];
        if (k) {
          line.push(k.replace('/', ''));
          target.push(canon(k.replace('/', '')));
        }
      }
    }
    
    console.log(`🎯 Target arrays built: ${line.length} playable notes out of ${notes.length} total positions`);
    
    // Get time signature
    let timeSignature = { beats: 4, beatType: 4 }; // Default
    if (currentMeasure.timeSignature) {
      timeSignature = currentMeasure.timeSignature;
    } else {
      // Fallback to calculating from note durations
      const beatsFloat = beatsFromNotes(notes);
      timeSignature.beats = normalizeBeats(beatsFloat);
    }
    
    currentBeats = timeSignature.beats;
    
    // Initialize new rendering system
    initializeRenderState(notes, timeSignature);
    
    // Render using new clean system
    renderStaffClean();
    }

  async function clefchanged(){
    if (randomSongMode) {
      // Random Song Mode: regenerate 8-note segment with new clef
      console.log(`🎵 Clef changed to ${selectedClef} in Random Song Mode`);
      generateRandomSongSegment();
    } else if (msreCount == -1){
      // Random Note Mode: generate new random notes
      generateRandomLine();
    } else {
      // Regular Song Mode: reparse current measure
      console.log(`🎵 Clef changed to ${selectedClef}`);
      getMusicXML();
      renderAnalysisLine();
    }
  }

  // Track previous clef for transposition
  let previousClef: Clef = selectedClef;






  
  // Simple octave transposition function (keeps the existing transposeNote function)

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

  // Update previous clef tracking
  $: if (selectedClef !== previousClef) {
    previousClef = selectedClef;
  }

  /* ---------- Metronome ---------- */
  // Remove metronome logic and state:
  // Remove lines 559-605 (all metronome state and functions)
  // ... existing code ...


  /* ---------- Random Song Mode - Database Integration ---------- */
  let xmlText:string = '';
  let measures: any;

  function hasChords(measures: any[]): boolean {
    // Check if any note in any measure is a chord (has multiple keys)
    for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
      const measure = measures[measureIndex];
      for (let noteIndex = 0; noteIndex < measure.notes.length; noteIndex++) {
        const note = measure.notes[noteIndex];
        if (!isRestNote(note)) {
          const keys = note.getKeys();
          if (keys.length > 1) {
            console.log(`🔍 CHORD DETECTED in "${currentSongTitle}": Measure ${measureIndex + 1}, Note ${noteIndex + 1} has ${keys.length} keys:`, keys);
            return true;
          }
        }
      }
    }
    return false;
  }

  function getMusicXML() {
    try {
      console.log(`🎵 ANALYZING SONG: "${currentSongTitle}"`);
      
      measures = parseMusicXML(xmlText, selectedClef);
      if (!measures || measures.length === 0) {
        console.log(`❌ SKIPPED "${currentSongTitle}": No measures parsed from MusicXML`);
        measures = [];
        return false;
      }
      
      // Check if song matches selected key filter (group relative major/minor keys)
      if (selectedSongKey !== 'Random' && measures.length > 0) {
        const songKey = measures[0].key.split(' ')[0]; // Get key from first measure
        
        // Map keys to their key signatures (number of sharps/flats)
        const keyToSignature = (key: string): string => {
          const keyMap: Record<string, string> = {
            // No accidentals (0 sharps/flats)
            'C': '0', 'Am': '0',
            // 1 sharp
            'G': '1#', 'Em': '1#',
            // 2 sharps
            'D': '2#', 'Bm': '2#',
            // 3 sharps
            'A': '3#', 'F#m': '3#',
            // 4 sharps
            'E': '4#', 'C#m': '4#',
            // 5 sharps
            'B': '5#', 'G#m': '5#',
            // 6 sharps
            'F#': '6#', 'D#m': '6#',
            // 7 sharps
            'C#': '7#', 'A#m': '7#',
            // 1 flat
            'F': '1b', 'Dm': '1b',
            // 2 flats
            'Bb': '2b', 'Gm': '2b',
            // 3 flats
            'Eb': '3b', 'Cm': '3b',
            // 4 flats
            'Ab': '4b', 'Fm': '4b',
            // 5 flats
            'Db': '5b', 'Bbm': '5b',
            // 6 flats
            'Gb': '6b', 'Ebm': '6b',
            // 7 flats
            'Cb': '7b', 'Abm': '7b'
          };
          return keyMap[key] || 'unknown';
        };
        
        const songSignature = keyToSignature(songKey);
        const filterSignature = keyToSignature(selectedSongKey);
        
        if (songSignature !== filterSignature || songSignature === 'unknown') {
          console.log(`❌ SKIPPED "${currentSongTitle}": Key ${songKey} (${songSignature}) doesn't match filter ${selectedSongKey} (${filterSignature})`);
          measures = [];
          return false;
        }
        console.log(`✅ KEY MATCH: "${currentSongTitle}" is in ${songKey} (${songSignature}) - matches filter ${selectedSongKey} (${filterSignature})`);
      }
      
      console.log(`📊 Song "${currentSongTitle}" has ${measures.length} measures`);
      
      // Log detailed measure analysis
      measures.forEach((measure: any, index: number) => {
        const noteCount = measure.notes.length;
        const restCount = measure.notes.filter((n: any) => isRestNote(n)).length;
        const actualNotes = noteCount - restCount;
        console.log(`  📏 Measure ${index + 1}: ${noteCount} total positions (${actualNotes} notes, ${restCount} rests)`);
      });
      
      console.log(`✅ ACCEPTED "${currentSongTitle}": All songs are now accepted (chords handled by selecting highest note)`);
      return true;
    } catch (error) {
      console.log(`❌ SKIPPED "${currentSongTitle}": Error parsing MusicXML -`, error);
      measures = [];
      return false;
    }
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
    isLoadingSong = true;

    // Try for 5 seconds to find a song with the selected key
    const startTime = Date.now();
    const timeoutMs = 5000; // 5 seconds
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const row = await fetchRandomXMLFromPool();
        xmlText = row.musicxml;

        const meta = extractMetaFromMusicXML(xmlText);
        const tempTitle = meta.title || '(Untitled)';
        const tempComposer = meta.composer || '';

        manualTransposition = 0;
        songNotesCollected = 0;
        originalCollectedNotes = [];
        originalCollectedKeys = [];

        // Parse the song
        const parseSuccess = getMusicXML();
        if (parseSuccess) {
          currentSongTitle = tempTitle;
          currentSongComposer = tempComposer;
          isLoadingSong = false;
          renderAnalysisLine();
          gaEvent('random_song_mode_started', { source: 'xml_pool' });
          return;
        }
        
        // Parsing failed, try another song
        console.log(`🔄 "${tempTitle}" failed to parse or wrong key, trying another song`);
        
      } catch (error) {
        console.error('Error loading random song:', error);
      }
    }
    
    // If we get here, we couldn't find a suitable song within 5 seconds
    isLoadingSong = false;
    console.log('Could not find a suitable song within 5 seconds.');
    switchToRandomNoteMode();
  }

  async function nextRandomSong() {
    isLoadingSong = true;
    // Clear current song info while loading
    currentSongTitle = '';
    currentSongComposer = '';
    
    // Try for 5 seconds to find a song with the selected key
    const startTime = Date.now();
    const timeoutMs = 5000; // 5 seconds
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const row = await fetchRandomXMLFromPool();
        xmlText = row.musicxml;

        const meta = extractMetaFromMusicXML(xmlText);
        const tempTitle = meta.title || '(Untitled)';
        const tempComposer = meta.composer || '';

        manualTransposition = 0;
        songNotesCollected = 0;
        originalCollectedNotes = [];
        originalCollectedKeys = [];

        // Parse the song
        const parseSuccess = getMusicXML();
        if (parseSuccess) {
          currentSongTitle = tempTitle;
          currentSongComposer = tempComposer;
          isLoadingSong = false;
          renderAnalysisLine();
          gaEvent('next_random_song', { source: 'xml_pool' });
          return;
        }
        
        // Parsing failed, try another song
        console.log(`🔄 "${tempTitle}" failed to parse or wrong key, trying another song`);
        
      } catch (error) {
        console.error('Error loading next random song:', error);
      }
    }
    
    // If we get here, we couldn't find a suitable song within 5 seconds
    isLoadingSong = false;
    console.log('Could not find a suitable song within 5 seconds.');
    // Stay in random song mode but show error state
    currentSongTitle = 'Error loading songs';
    currentSongComposer = 'Try again later';
  }

  function switchToRandomNoteMode() {
    randomSongMode = false;
    showNoteDropdown = true;
    showSongDropdown = false;
    currentSongTitle = '';
    currentSongComposer = '';
    isLoadingSong = false;
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
    manualTransposition = 0;
    songNotesCollected = 0;
    originalCollectedNotes = [];
    originalCollectedKeys = [];
    renderAnalysisLine();
  }

  function transposeUp() {
    console.log('🔺 TRANSPOSE UP CALLED:', {
      randomSongMode,
      msreCount,
      originalCollectedKeysLength: originalCollectedKeys.length,
      manualTransposition
    });
    if (!randomSongMode) return;
    manualTransposition += 1;
    console.log(`🎵 Transposed up by 1 semitone: ${manualTransposition}`);
    // For random song mode, ONLY re-apply transposition to existing notes
    if (originalCollectedKeys.length > 0) {
      applyTranspositionToCollectedNotes();
      initializeRenderState(notes, { beats: Math.max(4, Math.min(8, notes.length)), beatType: 4 });
      renderStaffClean();
    }
    // NO fallback - if no notes collected yet, do nothing
  }

  function transposeDown() {
    console.log('🔻 TRANSPOSE DOWN CALLED:', {
      randomSongMode,
      msreCount,
      originalCollectedKeysLength: originalCollectedKeys.length,
      manualTransposition
    });
    if (!randomSongMode) return;
    manualTransposition -= 1;
    console.log(`🎵 Transposed down by 1 semitone: ${manualTransposition}`);
    // For random song mode, ONLY re-apply transposition to existing notes
    if (originalCollectedKeys.length > 0) {
      applyTranspositionToCollectedNotes();
      initializeRenderState(notes, { beats: Math.max(4, Math.min(8, notes.length)), beatType: 4 });
      renderStaffClean();
    }
    // NO fallback - if no notes collected yet, do nothing
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
  selectedSongKey?: string;
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
    autoNext,
    selectedSongKey
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
  if (typeof p.selectedSongKey === 'string') selectedSongKey = p.selectedSongKey;

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
       bpm, minDb, randomSongMode, autoNext, selectedSongKey;
  schedulePrefsSave();
}

// DISABLED: Hide flags on notes that are part of a beam
// function hideFlagsForBeamedNotes(beams: any[]) {
//   // Function disabled - beaming has been removed
//   return;
// }

// Piano keyboard integration
function handlePianoNote(note: string, frequency: number) {
  console.log('🎹 Piano key clicked:', note);
  
  // Update the display
  freq = Math.round(frequency);
  lastGoodFreq = frequency;
  lastHeard = Date.now();
  lastUpdate = lastHeard;
  
  // Check if we have a current playable note to match
  const currentNote = getCurrentPlayableNote();
  if (!currentNote) {
    console.log('🎹 Piano note played but no playable target note available');
    return;
  }
  
  // Extract the note name from the target
  const targetNoteName = line[renderState?.currentProgress || 0]?.replace(/\d+$/, '') || '';
  console.log('🎯 Target note:', targetNoteName, '→ extracted:', targetNoteName);
  
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
  
  console.log('🎯 NOTE COMPARISON: Piano played:', normalizedPianoNote, '| Target:', normalizedTargetNote);
  
  // Check if the piano note matches the target note name (ignoring octave)
  const isMatch = pianoEquivalents.some(p => targetEquivalents.includes(p));
  if (isMatch) {
    const matchedLabel = targetNoteName;
    gaEvent('correct_note', {
      index: renderState?.currentProgress || 0,
      label: matchedLabel,
      clef: selectedClef,
      key: currentKeySig
    });
    
    // Update state using new system
    matchedFreq = freq;
    lastNoteTime = Date.now();
    
    // Advance progress in new system
    const hasMoreNotes = advanceProgress();
    
    // Re-render with new progress
    renderStaffClean();
    
    if (isGameComplete()) {
      console.log('🎹 Piano completion detected:', {
        randomSongMode,
        msreCount,
        autoNext
      });
      
      if (randomSongMode) {
        // Random Song Mode: 8-note segment completed
        console.log('🎵 Random Song Mode: 8-note segment completed (from piano)');
        if (autoNext) {
          console.log('🔄 Auto-next enabled: advancing to next random song (from piano)');
          nextRandomSong().then(() => {
            gate = 'WAIT_ATTACK';
            haveGoneQuiet = false;
            matchedFreq = 0;
            deferNextFrame = true;
          });
        } else {
          console.log('⏸️ Auto-next disabled: stopping and waiting (from piano)');
        }
      } else if (msreCount == -1) {
        // Random Note Mode completion
        console.log('🎲 Random Note Mode completion (from piano)');
        if (autoNext) {
          generateRandomLine();
          gate = 'WAIT_ATTACK';
          haveGoneQuiet = false;
          matchedFreq = 0;
          deferNextFrame = true;
        }
      } else {
        // Regular song mode progression
        if (msreCount == totalMsre - 1) {
          // Song complete
          console.log('📝 Regular song complete (from piano)');
        } else {
          console.log('➡️ Advancing to next measure (from piano):', msreCount + 1);
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
          Random Song Mode (WIP)
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

            <label class="dropdown-control">
              <span>Key Signature:</span>
              <select bind:value={selectedSongKey} class="dropdown-select">
                <option value="Random">Random</option>
                <optgroup label="No accidentals">
                  <option value="C">C major / A minor (♮)</option>
                </optgroup>
                <optgroup label="Sharps">
                  <option value="G">G major / E minor (1♯)</option>
                  <option value="D">D major / B minor (2♯)</option>
                  <option value="A">A major / F# minor (3♯)</option>
                  <option value="E">E major / C# minor (4♯)</option>
                  <option value="B">B major / G# minor (5♯)</option>
                  <option value="F#">F# major / D# minor (6♯)</option>
                  <option value="C#">C# major / A# minor (7♯)</option>
                </optgroup>
                <optgroup label="Flats">
                  <option value="F">F major / D minor (1♭)</option>
                  <option value="Bb">B♭ major / G minor (2♭)</option>
                  <option value="Eb">E♭ major / C minor (3♭)</option>
                  <option value="Ab">A♭ major / F minor (4♭)</option>
                  <option value="Db">D♭ major / B♭ minor (5♭)</option>
                  <option value="Gb">G♭ major / E♭ minor (6♭)</option>
                  <option value="Cb">C♭ major / A♭ minor (7♭)</option>
                </optgroup>
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
    {#if randomSongMode && currentSongTitle && measures && measures.length > 0}
      <div class="song-info">
        <h3 class="song-title">{currentSongTitle}</h3>
        <p class="song-composer">{currentSongComposer}</p>
        {#if measures && measures.length > 0}
          {@const songKey = measures[0].key.split(' ')[0]}
          {@const keySignature = (() => {
            const keyMap = {
              'C': '♮', 'Am': '♮',
              'G': '1♯', 'Em': '1♯',
              'D': '2♯', 'Bm': '2♯', 
              'A': '3♯', 'F#m': '3♯',
              'E': '4♯', 'C#m': '4♯',
              'B': '5♯', 'G#m': '5♯',
              'F#': '6♯', 'D#m': '6♯',
              'C#': '7♯', 'A#m': '7♯',
              'F': '1♭', 'Dm': '1♭',
              'Bb': '2♭', 'Gm': '2♭',
              'Eb': '3♭', 'Cm': '3♭',
              'Ab': '4♭', 'Fm': '4♭',
              'Db': '5♭', 'Bbm': '5♭',
              'Gb': '6♭', 'Ebm': '6♭',
              'Cb': '7♭', 'Abm': '7♭'
            };
            return keyMap[songKey] || songKey;
          })()}
          <p class="song-key">Key: {songKey} ({keySignature})</p>
        {/if}
      </div>
    {/if}
    
    {#if isLoadingSong}
      <div class="loading-indicator">
        <div class="spinner"></div>
        <p class="loading-text">Searching for song...</p>
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
            <div class="transpose-controls">
              <button on:click={transposeUp} class="transpose-button up">
                <span class="transpose-icon">♯</span>
              </button>
              <button on:click={transposeDown} class="transpose-button down">
                <span class="transpose-icon">♭</span>
              </button>
              <div class="transpose-indicator">
                {#if manualTransposition === 0}
                  <span class="transpose-label">Original pitch</span>
                {:else if manualTransposition > 0}
                  <span class="transpose-label">+{manualTransposition} semitones</span>
                {:else}
                  <span class="transpose-label">{manualTransposition} semitones</span>
                {/if}
              </div>
            </div>
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

  .song-key {
    font-size: 0.875rem;
    font-weight: 600;
    color: #059669;
    margin: 0.25rem 0 0 0;
    background: rgba(5, 150, 105, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    display: inline-block;
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

  /* Octave Controls */
  .transpose-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%);
    border: 2px solid #d1d5db;
    border-radius: 0.75rem;
    padding: 0.75rem;
    min-width: 120px;
  }

  .transpose-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
    border: 2px solid #cbd5e1;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 0.2s ease;
    padding: 0;
    font-size: 1.2rem;
    font-weight: bold;
  }

  .transpose-button:hover {
    background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
    border-color: #94a3b8;
    transform: translateY(-1px);
  }

  .transpose-button:active {
    transform: translateY(0);
  }

  .transpose-button.up {
    color: #059669;
    margin-bottom: 0.125rem;
  }

  .transpose-button.down {
    color: #dc2626;
    margin-top: 0.125rem;
  }

  .transpose-icon {
    font-size: 1rem;
    line-height: 1;
  }

  .transpose-indicator {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    margin-top: 0.25rem;
  }

  .transpose-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: #374151;
    text-align: center;
    background: rgba(255, 255, 255, 0.8);
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid rgba(0, 0, 0, 0.1);
  }

  /* Loading Indicator */
  .loading-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  .spinner {
    width: 3rem;
    height: 3rem;
    border: 4px solid #e5e7eb;
    border-top: 4px solid #667eea;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .loading-text {
    font-size: 1.1rem;
    font-weight: 600;
    color: #667eea;
    margin: 0;
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
