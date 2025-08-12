<script lang="ts">
	import { page } from '$app/state';
	import github from '$lib/images/github.svg';
</script>

<header>
	<div class="corner">
		<a href="https://ebtlabs.site" title="EBT Labs" class="ebt-button">
			<span class="logo-text">EBT</span>
		</a>
	</div>

	<nav>
		<ul>
			<li aria-current={page.url.pathname === '/' ? 'page' : undefined}>
				<a href="/">Music Buddy</a>
			</li>
			<li aria-current={page.url.pathname === '/about' ? 'page' : undefined}>
				<a href="/about">About</a>
			</li>
		</ul>
	</nav>

	<div class="corner">
		<a href="https://github.com/ebtrinh/musicplayhelper">
			<img src={github} alt="GitHub" />
		</a>
	</div>
</header>

<style>
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 2rem;
		background: rgba(249, 250, 251, 0.6);
		backdrop-filter: blur(15px);
		border-radius: 0 0 1rem 1rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
		margin-bottom: 2rem;
		border: 1px solid rgba(229, 231, 235, 0.4);
	}

	.corner {
		width: auto;
		height: auto;
	}

	.corner a {
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
	}

	.corner img {
		width: 2em;
		height: 2em;
		object-fit: contain;
	}

	.ebt-button {
		padding: 0.75rem 1.5rem;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
		border-radius: 0.75rem;
		font-weight: 600;
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}

	.ebt-button:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
	}

	.logo-text {
		font-size: 1.1rem;
		font-weight: bold;
		color: white;
		text-decoration: none;
	}

	nav {
		display: flex;
		justify-content: center;
		background: rgba(249, 250, 251, 0.8);
		backdrop-filter: blur(10px);
		border-radius: 1rem;
		padding: 0.5rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
		border: 1px solid rgba(229, 231, 235, 0.6);
	}

	ul {
		position: relative;
		padding: 0;
		margin: 0;
		height: auto;
		display: flex;
		justify-content: center;
		align-items: center;
		list-style: none;
		background: transparent;
		gap: 0;
	}

	li {
		position: relative;
		height: auto;
	}

	li[aria-current='page']::before {
		--size: 6px;
		content: '';
		width: 0;
		height: 0;
		position: absolute;
		top: -0.5rem;
		left: 50%;
		transform: translateX(-50%);
		border: var(--size) solid transparent;
		border-top: var(--size) solid #667eea;
	}

	nav a {
		display: flex;
		height: auto;
		align-items: center;
		padding: 0.75rem 1.5rem;
		color: #4b5563;
		font-weight: 600;
		font-size: 0.9rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		text-decoration: none;
		transition: all 0.2s ease;
		border-radius: 0.5rem;
		margin: 0 0.25rem;
	}

	nav a:hover {
		color: #667eea;
		background: rgba(255, 255, 255, 0.6);
		transform: translateY(-1px);
		box-shadow: 0 2px 8px rgba(102, 126, 234, 0.15);
	}

	li[aria-current='page'] a {
		color: white;
		font-weight: 700;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
	}

	li[aria-current='page'] a:hover {
		color: white;
		background: linear-gradient(135deg, #5a67d8 0%, #6b46c1 100%);
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
	}
</style>
