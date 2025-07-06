// analysisToStave.ts  — AugmentedNet → VexFlow (v5 – no explicit addAccidental)
// ------------------------------------------------------------------
//  parseAugmentedNet(rawString) → MeasureData[]
//  • Harmony bars → one StaveNote chord (accidentals left to
//    Accidental.applyAccidentals when you draw the Voice).
//  • Melody bars → one StaveNote per pitch token, likewise without
//    manual accidental injection.
// ------------------------------------------------------------------

import { StaveNote } from "vexflow";

export interface MeasureData {
  num: number;
  key: string;
  roman: string;
  notes: StaveNote[];
}

/*— static tables (unchanged) —*/
const NOTE_ORDER = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;
const KEY_OFFSETS: Record<string, number[]> = {
  "C major": [0,2,4,5,7,9,11],  "A minor": [9,11,0,2,4,5,7],
  "G major": [7,9,11,0,2,4,6], "E minor": [4,6,7,9,11,0,2],
  "D major": [2,4,6,7,9,11,1], "B minor": [11,1,2,4,6,7,9],
  "A major": [9,11,1,2,4,6,8], "F# minor": [6,8,9,11,1,2,4],
  "E major": [4,6,8,9,11,1,3], "C# minor": [1,3,4,6,8,9,11],
};

/*──────────── Roman‑numeral parsing ────────────*/

type Quality = "maj"|"min"|"dim"|"hdim";
interface RomanInfo{degree:number;quality:Quality;seventh:boolean;inv:number;}
const ROMAN_RE = /^(viio|viiø|vii|iii|ii|iv|vi|v|i|I|V|IV|VI|II|III|VII)(?:o|ø)?(64|65|43|42|2|6)?/;
const DEGREE_MAP:Record<string,number>={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7};

function parseRoman(tok:string):RomanInfo|null{
  const m = tok.match(ROMAN_RE); if(!m) return null;
  const [,base,invStr]=m;
  const inv = invStr ? {"6":1,"64":2,"65":1,"43":2,"42":3,"2":3}[invStr]! : 0;
  let quality:Quality = /^[A-Z]/.test(base)?"maj":"min";
  if(/o/.test(tok)) quality="dim"; if(/ø/.test(tok)) quality="hdim";
  const degree = DEGREE_MAP[base.toLowerCase().replace(/o|ø/g,"")];
  const seventh = /7/.test(tok);
  return { degree, quality, seventh, inv };
}

function romanToMidis(key:string,info:RomanInfo):number[]{
  const scale = KEY_OFFSETS[key]; if(!scale) throw `Key ${key} not mapped`;
  const root  = 60 + scale[info.degree-1];
  const tri   = [0,4,7]; if(info.quality!=="maj") tri[1]=3; if(info.quality.match(/dim/)) tri[2]=6;
  let pcs = [root+tri[0], root+tri[1], root+tri[2]];
  if(info.seventh) pcs.push(root + (info.quality==="maj"?11:10));
  for(let i=0;i<info.inv;i++) pcs.push(pcs.shift()!+12);
  return pcs;
}

/*──────────── note-token helper ────────────*/

const NOTE_RE = /^([A-Ga-g])([#b♯♭]?)(\d)$/;
function tokenToStave(noteTok:string){
  const m = NOTE_RE.exec(noteTok); if(!m) throw `Bad note token ${noteTok}`;
  const [,ltr,acc,oct]=m;
  const keyStr = ltr.toUpperCase() + acc.replace('♯','#').replace('♭','b') + '/' + oct;
  return new StaveNote({ clef:"treble", duration:"q", keys:[keyStr] });
}

/*──────────── main export ────────────*/

export function parseAugmentedNet(raw:string):MeasureData[]{
  let currentKey = "C major";
  const out:MeasureData[] = [];

  raw.split(/\n+/).forEach(line=>{
    const parts = line.trim().split(/\s+/); if(!parts[0]) return;
    const mMatch = /^m?(\d+)/.exec(parts[0]); if(!mMatch) return;
    const num = +mMatch[1]; const tokens = parts.slice(1);

    // key change?
    tokens.forEach(t=>{ if(/^[a-gA-G]:$/.test(t)){ const r=t.replace(":",""); currentKey = r.toUpperCase()===r?`${r} major`:`${r.toUpperCase()} minor`; }});

    // harmony path
    const romanTok = tokens.find(t=>ROMAN_RE.test(t));
    if(romanTok){
      const info  = parseRoman(romanTok)!;
      const midis = romanToMidis(currentKey, info);
      const keys  = midis.map(m=>{
        const pc = m%12, oct=Math.floor(m/12)-1, name=NOTE_ORDER[pc];
        return name.replace('#','') + '/' + oct; });
      const chord = new StaveNote({ clef:"treble", duration:"q", keys });
      out.push({ num, key: currentKey, roman: romanTok, notes:[chord] });
      return;
    }

    // melody path
    const noteToks = tokens.filter(t=>NOTE_RE.test(t));
    if(noteToks.length){
      const notes = noteToks.map(tokenToStave);
      out.push({ num, key: currentKey, roman: "melody", notes });
    }
  });
  return out;
}
