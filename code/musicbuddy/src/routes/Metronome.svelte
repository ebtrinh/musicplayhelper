<script lang="ts">
  import { onDestroy, createEventDispatcher } from 'svelte';
  export let ctx: AudioContext | undefined = undefined;
  export let bpm = 120;
  let metroOn = false;
  let tickInterval: number | null = null;
  let beatsPerBar = 4;
  let metroIdx = 0;

  const dispatch = createEventDispatcher();

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
    dispatch('start');
  }
  function stopMetronome() {
    if (tickInterval !== null) clearInterval(tickInterval);
    tickInterval = null;
    metroOn = false;
    dispatch('stop');
  }
  function toggleMetronome() {
    metroOn ? stopMetronome() : startMetronome();
  }
  $: if (metroOn) {
    stopMetronome();
    startMetronome();
  }
  onDestroy(() => { stopMetronome(); });

  const TS_OPTIONS = [
    { label: '2/4', beats: 2 },
    { label: '3/4', beats: 3 },
    { label: '4/4', beats: 4 },
    { label: '6/8', beats: 6 }
  ];
  let selectedTS = TS_OPTIONS[2].label;
  function tsChanged() {
    const opt = TS_OPTIONS.find(o => o.label === selectedTS);
    if (opt) { beatsPerBar = opt.beats; metroIdx = 0; }
  }
</script>

<div class="flex flex-col items-center gap-2 my-4 p-4 border rounded bg-gray-50">
  <div class="flex items-center gap-4">
    <button on:click={toggleMetronome} class="rounded bg-blue-500 px-4 py-2 text-white">
      {metroOn ? 'Stop' : 'Start'} Metronome
    </button>
    <label class="flex items-center gap-2">
      <span class="text-sm">BPM:</span>
      <input type="number" min="30" max="300" bind:value={bpm} class="w-16 rounded border px-2 py-1" />
    </label>
    <label class="flex items-center gap-2">
      <span class="text-sm">Beats/Bar:</span>
      <select bind:value={selectedTS} on:change={tsChanged} class="rounded border px-2 py-1">
        {#each TS_OPTIONS as o}
          <option value={o.label}>{o.label}</option>
        {/each}
      </select>
    </label>
  </div>
  <div class="text-xs opacity-70 mt-2">Metronome is {metroOn ? 'ON' : 'OFF'} | BPM: {bpm} | Beats/Bar: {beatsPerBar}</div>
</div>
