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

<div class="metronome">
	<div class="controls-row">
		<button on:click={toggleMetronome} class="btn">
			{metroOn ? 'Stop' : 'Start'} Metronome
		</button>
		<label class="ctrl">
			<span class="lbl">BPM:</span>
			<input type="number" min="30" max="300" bind:value={bpm} class="num" />
		</label>
		<label class="ctrl">
			<span class="lbl">Beats/Bar:</span>
			<select bind:value={selectedTS} on:change={tsChanged} class="select">
				{#each TS_OPTIONS as o}
					<option value={o.label}>{o.label}</option>
				{/each}
			</select>
		</label>
	</div>
	<div class="status">Metronome is {metroOn ? 'ON' : 'OFF'} | BPM: {bpm} | Beats/Bar: {beatsPerBar}</div>
</div>

<style>
	.metronome {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
	.controls-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		justify-content: center;
		width: 100%;
	}
	.btn {
		border-radius: 0.5rem;
		background: #3b82f6;
		color: #fff;
		padding: 0.5rem 0.9rem;
		border: none;
		cursor: pointer;
		font-weight: 600;
	}
	.ctrl { display: flex; align-items: center; gap: 0.4rem; }
	.lbl { font-size: 0.9rem; color: #374151; }
	.num { width: 4.5rem; padding: 0.3rem 0.4rem; border: 1px solid #d1d5db; border-radius: 0.375rem; }
	.select { padding: 0.35rem 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem; }
	.status { font-size: 0.85rem; opacity: 0.7; text-align: center; }

	@media (max-width: 420px) {
		.btn { width: 100%; }
		.controls-row { align-items: stretch; }
	}
</style>
