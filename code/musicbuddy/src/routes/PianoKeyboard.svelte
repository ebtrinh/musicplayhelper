<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  
  const dispatch = createEventDispatcher<{
    notePlayed: { note: string; frequency: number };
  }>();

  // Piano key configuration - no octave association
  const WHITE_KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const BLACK_KEYS = ['C♯', 'D♯', 'F♯', 'G♯', 'A♯'];
  
  // Use middle C octave (C4) as the base for all notes
  // The system will automatically match to the correct octave
  const NOTE_FREQUENCIES: Record<string, number> = {
    'C': 261.63,   // C4
    'C♯': 277.18,  // C#4
    'D': 293.66,   // D4
    'D♯': 311.13,  // D#4
    'E': 329.63,   // E4
    'F': 349.23,   // F4
    'F♯': 369.99,  // F#4
    'G': 392.00,   // G4
    'A': 440.00,   // A4
    'A♯': 466.16,  // A#4
    'B': 493.88    // B4
  };

  // Props
  export let visible = false;
  export let currentClef: 'treble' | 'bass' | 'alto' = 'treble';
  export let currentKeySig = 'C';

  // State
  let pressedKey: string | null = null;

  function handleKeyClick(note: string) {
    if (!NOTE_FREQUENCIES[note]) return;
    
    pressedKey = note;
    
    // GA event for piano key pressed
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'piano_key_pressed', { note });
    }
    
    dispatch('notePlayed', { 
      note, 
      frequency: NOTE_FREQUENCIES[note] 
    });
    
    // Visual feedback - reset after animation
    setTimeout(() => {
      pressedKey = null;
    }, 150);
  }

  function getKeyClass(note: string, isBlack: boolean): string {
    let classes = 'piano-key';
    if (isBlack) classes += ' black-key';
    if (pressedKey === note) classes += ' pressed';
    return classes;
  }

  function getBlackKeyPosition(index: number): string {
    // Position black keys between white keys - shifted slightly right for better centering
    const positions = [0.7, 1.7, 3.7, 4.7, 5.7];
    return `${positions[index] * 14.28}%`;
  }
</script>

{#if visible}
  <div class="piano-keyboard">
    <div class="piano-container">
      <!-- White keys -->
      <div class="white-keys">
        {#each WHITE_KEYS as note, i}
          <button
            class={getKeyClass(note, false)}
            on:click={() => handleKeyClick(note)}
            style="left: {i * 14.28}%"
          >
            <span class="key-label">{note}</span>
          </button>
        {/each}
      </div>
      
      <!-- Black keys - positioned on top of white keys -->
      <div class="black-keys">
        {#each BLACK_KEYS as note, i}
          <button
            class={getKeyClass(note, true)}
            on:click={() => handleKeyClick(note)}
            style="left: {getBlackKeyPosition(i)}"
          >
            <span class="key-label">{note}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .piano-keyboard {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    background: rgba(0, 0, 0, 0.9);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .piano-container {
    position: relative;
    width: 400px;
    height: 120px;
  }

  .white-keys {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .piano-key {
    position: absolute;
    border: none;
    cursor: pointer;
    transition: all 0.1s ease;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 0.5rem;
    font-weight: 600;
    font-size: 0.9rem;
    color: #333;
    outline: none;
  }

  .piano-key:not(.black-key) {
    width: 14.28%;
    height: 100%;
    background: linear-gradient(180deg, #fff 0%, #f0f0f0 100%);
    border: 1px solid #ccc;
    border-radius: 0 0 0.5rem 0.5rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .piano-key:not(.black-key):hover {
    background: linear-gradient(180deg, #f8f8f8 0%, #e8e8e8 100%);
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
  }

  .piano-key:not(.black-key):active,
  .piano-key:not(.black-key).pressed {
    background: linear-gradient(180deg, #e0e0e0 0%, #d0d0d0 100%);
    transform: translateY(0);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .black-key {
    width: 8%;
    height: 60%;
    background: linear-gradient(180deg, #333 0%, #000 100%);
    border: 1px solid #222;
    border-radius: 0 0 0.25rem 0.25rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    color: white;
    z-index: 2;
    top: 0; /* Position on top of white keys */
  }

  .black-key:hover {
    background: linear-gradient(180deg, #444 0%, #111 100%);
    transform: translateY(-1px);
    box-shadow: 0 3px 6px rgba(0, 0, 0, 0.4);
  }

  .black-key:active,
  .black-key.pressed {
    background: linear-gradient(180deg, #222 0%, #000 100%);
    transform: translateY(0);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  .key-label {
    pointer-events: none;
    user-select: none;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .piano-keyboard {
      bottom: 1rem;
      left: 1rem;
      right: 1rem;
      transform: none;
    }
    
    .piano-container {
      width: 100%;
      height: 100px;
    }
    
    .piano-key:not(.black-key) {
      font-size: 0.8rem;
    }
    
    .black-key {
      font-size: 0.7rem;
    }
  }

  @media (max-width: 480px) {
    .piano-keyboard {
      padding: 1rem;
    }
    
    .piano-container {
      height: 80px;
    }
    
    .piano-key:not(.black-key) {
      font-size: 0.7rem;
    }
    
    .black-key {
      font-size: 0.6rem;
    }
  }
</style>
