<svelte:head>
	<title>About</title>
	<meta name="description" content="About Music Buddy - Learn music with interactive exercises" />
</svelte:head>

<div class="text-column">
	<h1>About Music Buddy</h1>

	<p>
		Music Buddy is an interactive music learning application designed to help musicians of all levels improve their skills through real-time pitch detection and interactive exercises.
	</p>

	<p>
		<strong>Features:</strong>
	</p>
	<ul>
		<li>Real-time pitch detection using your microphone</li>
		<li>Interactive staff notation with multiple clefs</li>
		<li>Customizable key signatures and time signatures</li>
		<li>Built-in metronome for rhythm practice</li>
		<li>Preset songs and custom MusicXML support</li>
		<li>Progress tracking and personalized exercises</li>
	</ul>

	<p>
		Built with modern web technologies including SvelteKit, this app provides a responsive and accessible way to practice music theory and ear training.
	</p>

	<p>
		You can check out the source code on <a href="https://github.com/ebtrinh/musicplayhelper">GitHub</a> as this is an open-source project.
	</p>

	<p>
		Happy practicing and good luck with your musical journey!
	</p>
</div>

<style>
	.text-column {
		max-width: 65ch;
		margin: 0 auto;
		padding: 2rem;
	}

	h1 {
		color: var(--color-theme-1);
		margin-bottom: 1.5rem;
	}

	p {
		margin-bottom: 1rem;
		line-height: 1.6;
	}

	ul {
		margin: 1rem 0 1rem 2rem;
		line-height: 1.6;
	}

	li {
		margin-bottom: 0.5rem;
	}

	a {
		color: var(--color-theme-1);
		text-decoration: none;
	}

	a:hover {
		text-decoration: underline;
	}
</style>
