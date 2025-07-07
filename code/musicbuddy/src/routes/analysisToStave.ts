// analysisToStave.ts — AugmentedNet & MusicXML → VexFlow (finalized v7.2)
// ------------------------------------------------------------------
//  ✦ parseAugmentedNet(raw, clef='treble') : MeasureData[]
//  ✦ parseMusicXML(xml, clef='treble')     : MeasureData[]
//    → both return the same structure so your Svelte code can call either
//      and keep working.
//  ✦ Each StaveNote is created with the clef you pass in.
//  ✦ Accidentals are *not* manually attached; call
//      Accidental.applyAccidentals([voice], keyRoot) at render time.
// ------------------------------------------------------------------

import { StaveNote } from 'vexflow';

export type Clef = 'treble' | 'alto' | 'bass' | 'tenor' | 'perc' | 'none';

export interface MeasureData {
  num: number;      // bar number (may be float if duplicates resolved)
  key: string;      // e.g. "C major"
  roman: string;    // Roman numeral or "melody"
  notes: StaveNote[]; // VexFlow tickables inside that bar
}

/*──────────────────── constants ────────────────────*/
const NOTE_ORDER = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;

const KEY_OFFSETS: Record<string, number[]> = {
  'C major':[0,2,4,5,7,9,11], 'A minor':[9,11,0,2,4,5,7],
  'G major':[7,9,11,0,2,4,6], 'E minor':[4,6,7,9,11,0,2],
  'D major':[2,4,6,7,9,11,1], 'B minor':[11,1,2,4,6,7,9],
  'A major':[9,11,1,2,4,6,8], 'F# minor':[6,8,9,11,1,2,4],
  'E major':[4,6,8,9,11,1,3], 'C# minor':[1,3,4,6,8,9,11]
};

/*──────────── Roman‑numeral helpers ───────────*/
interface RomanInfo {
  degree: number;
  quality: 'maj'|'min'|'dim'|'hdim';
  seventh: boolean;
  inv: number;
}
const ROMAN_RE = /^(viio|viiø|vii|iii|ii|iv|vi|v|i|I|V|IV|VI|II|III|VII)(?:o|ø)?(64|65|43|42|2|6)?/;
const DEG: Record<string, number> = { i:1, ii:2, iii:3, iv:4, v:5, vi:6, vii:7 };
function parseRoman(tok: string): RomanInfo | null {
  const m = tok.match(ROMAN_RE);
  if (!m) return null;

  const [, base, invS] = m;
  const invMap: Record<string, number> = { '6': 1, '64': 2, '65': 1, '43': 2, '42': 3, '2': 3 };
  const inv = invS ? invMap[invS] : 0;

  let q: 'maj' | 'min' | 'dim' | 'hdim' = /^[A-Z]/.test(base) ? 'maj' : 'min';
  if (/o/.test(tok)) q = 'dim';
  if (/ø/.test(tok)) q = 'hdim';

  const degIdx = DEG[base.toLowerCase().replace(/o|ø/g, '')];
  if (degIdx === undefined) throw new Error(`Unknown Roman numeral: ${base}`);

  return { degree: degIdx, quality: q, seventh: /7/.test(tok), inv };
}
function romanToMidis(key:string,info:RomanInfo){
  const scale=KEY_OFFSETS[key]; if(!scale) throw `Key ${key} not mapped`;
  const root=60+scale[info.degree-1];
  const tri=[0,4,7]; if(info.quality!=='maj')tri[1]=3; if(info.quality.match(/dim/))tri[2]=6;
  let pcs=[root+tri[0],root+tri[1],root+tri[2]];
  if(info.seventh) pcs.push(root+(info.quality==='maj'?11:10));
  for(let i=0;i<info.inv;i++) pcs.push(pcs.shift()!+12);
  return pcs;
}

/*──────────── pitch token helper ───────────*/
const NOTE_RE=/^([A-Ga-g])([#b♯♭]?)(\d)$/;
function tokenToStave(tok:string,clef:string){
  const m=NOTE_RE.exec(tok); if(!m) throw`Bad note token ${tok}`;
  const [ ,lt,acc,oc]=m; const key=lt.toUpperCase()+acc.replace('♯','#').replace('♭','b')+'/'+oc;
  return new StaveNote({ clef, duration:'q', keys:[key] });
}

/*──────────── parseAugmentedNet ───────────*/
export function parseAugmentedNet(raw:string, clef:string):MeasureData[]{
  let key='C major'; const out:MeasureData[]=[];
  raw.split(/\n+/).forEach(line=>{
    const parts=line.trim().split(/\s+/); if(!parts[0])return;
    const m= /^m?(\d+)/.exec(parts[0]); if(!m)return; const num=+m[1]; const toks=parts.slice(1);
    toks.forEach(t=>{ if(/^[a-gA-G]:$/.test(t)){const r=t[0]; key=r===r.toUpperCase()?`${r} major`:`${r.toUpperCase()} minor`;}});
    const rom=toks.find(t=>ROMAN_RE.test(t));
    if(rom){
      const midis=romanToMidis(key,parseRoman(rom)!);
      const keys=midis.map(m=>`${NOTE_ORDER[m%12].replace('#','')}/${Math.floor(m/12)-1}`);
      out.push({num,key,roman:rom,notes:[new StaveNote({clef,duration:'q',keys})]});
      return;
    }
    const noteToks=toks.filter(t=>NOTE_RE.test(t));
    if(noteToks.length) out.push({num,key,roman:'melody',notes:noteToks.map(t=>tokenToStave(t,clef))});
  });
  return out;
}

/*──────────── parseMusicXML ───────────*/
export function parseMusicXML(xml:string, clef:string):MeasureData[]{
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  const out:MeasureData[]=[]; let key='C major';
  doc.querySelectorAll('measure').forEach((meas,i)=>{
    const num=parseInt(meas.getAttribute('number')||String(i+1));
    const f=meas.querySelector('key > fifths');
    if(f){const n=+f.textContent!; const SH=['C','G','D','A','E','B','F#','C#']; const FL=['C','F','Bb','Eb','Ab','Db','Gb','Cb']; key=n>=0?`${SH[n]} major`:`${FL[-n]} major`;}
    const notes:Array<StaveNote>=[];
    meas.querySelectorAll('note').forEach(n=>{
      if(n.querySelector('rest')) return;
      const step=n.querySelector('pitch > step')?.textContent||'C';
      const oct =n.querySelector('pitch > octave')?.textContent||'4';
      const alt =n.querySelector('pitch > alter')?.textContent;
      const acc =alt?(alt==='1'?'#':'b'):'';
      notes.push(new StaveNote({clef,duration:'q',keys:[`${step}${acc}/${oct}`]}));
    });
    if(notes.length) out.push({num,key,roman:'melody',notes});
  });
  return out;
}
