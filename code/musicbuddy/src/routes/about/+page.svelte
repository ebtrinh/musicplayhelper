<svelte:head>
	<title>About</title>
	<meta name="description" content="About Music Buddy - Learn music with interactive exercises" />
</svelte:head>

<div class="main-container">
	<!-- Header Section -->
	<header class="app-header">
		<h1 class="app-title">About Music Buddy</h1>
		<p class="app-subtitle">Interactive music learning with real-time pitch detection</p>
	</header>

	<!-- About Content Section -->
	<section class="about-section">
		<div class="about-content">
			<div class="content-card">
				<h2 class="section-title">What is Music Buddy?</h2>
				<p class="content-text">
					Music Buddy is an interactive music learning application designed to help musicians of all levels improve their skills through real-time pitch detection and interactive exercises.
				</p>
			</div>

			<div class="content-card">
				<h2 class="section-title">Features</h2>
				<ul class="feature-list">
					<li>Real-time pitch detection using your microphone</li>
					<li>Interactive staff notation with multiple clefs</li>
					<li>Customizable key signatures and time signatures</li>
					<li>Built-in metronome for rhythm practice</li>
					<li>Preset songs and custom MusicXML support</li>
					<li>Progress tracking and personalized exercises</li>
				</ul>
			</div>

			<div class="content-card">
				<h2 class="section-title">Technology</h2>
				<p class="content-text">
					Built with modern web technologies including SvelteKit, this app provides a responsive and accessible way to practice music theory and ear training.
				</p>
				<p class="content-text">
					You can check out the source code on <a href="https://github.com/ebtrinh/musicplayhelper" class="github-link">GitHub</a> as this is an open-source project.
				</p>
			</div>

			<div class="content-card">
				<h2 class="section-title">Get Started</h2>
				<p class="content-text">
					Happy practicing and good luck with your musical journey! Start by heading back to the main page and trying out some exercises.
				</p>
				<a href="/" class="back-button">
					<span class="button-icon">🎵</span>
					Back to Music Buddy
				</a>
			</div>
		</div>
	</section>
</div>

<style>
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

	/* About Section */
	.about-section {
		background: white;
		border-radius: 1rem;
		padding: 2rem;
		margin-bottom: 2rem;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
		border: 1px solid #e5e7eb;
	}

	.about-content {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.content-card {
		padding: 1.5rem;
		background: #f9fafb;
		border-radius: 0.75rem;
		border: 1px solid #e5e7eb;
	}

	.section-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: #374151;
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 2px solid #e5e7eb;
	}

	.content-text {
		margin-bottom: 1rem;
		line-height: 1.6;
		color: #4b5563;
		font-size: 1rem;
	}

	.feature-list {
		margin: 1rem 0 1rem 2rem;
		line-height: 1.6;
		color: #4b5563;
	}

	.feature-list li {
		margin-bottom: 0.75rem;
		font-size: 1rem;
	}

	.github-link {
		color: #667eea;
		text-decoration: none;
		font-weight: 600;
	}

	.github-link:hover {
		text-decoration: underline;
	}

	.back-button {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 2rem;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
		border: none;
		border-radius: 0.75rem;
		font-size: 1.1rem;
		font-weight: 600;
		cursor: pointer;
		text-decoration: none;
		transition: transform 0.2s ease, box-shadow 0.2s ease;
		margin-top: 1rem;
	}

	.back-button:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
	}

	.button-icon {
		font-size: 1.2rem;
	}

	/* Responsive Design */
	@media (max-width: 768px) {
		.main-container {
			padding: 0 1rem;
		}
		
		.app-title {
			font-size: 2.5rem;
		}
		
		.about-section {
			padding: 1.5rem;
		}
		
		.content-card {
			padding: 1rem;
		}
	}
</style>
