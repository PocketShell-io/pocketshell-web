<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
import { blogPosts } from '../generated/blog-posts';
import githubGraph from '../assets/github-contributions-dark.png';

const auth = useAuthStore();
// Tease the four newest posts; the full list lives at /blog.
const latestPosts = blogPosts.slice(0, 4);

// The only conversion path is the Google sign-in on /login; a signed-in
// visitor skips straight past it to the app.
function ctaTo() {
  return { name: auth.signedIn ? 'hosts' : 'login' } as const;
}
</script>

<template>
  <div class="landing">
    <header class="topbar landing-topbar">
      <div class="topbar-rail">
        <RouterLink class="brand" :to="{ name: 'landing' }"
          ><span class="brand-mark">&gt;_</span> PocketShell</RouterLink
        >
        <nav class="site-nav">
          <a class="nav-link" href="#features">Features</a>
          <a class="nav-link" href="#how">How it works</a>
          <a class="nav-link" href="#security">Security</a>
          <a class="nav-link" href="#faq">FAQ</a>
          <a class="nav-link" href="/blog">Blog</a>
        </nav>
        <span class="spacer" />
        <RouterLink class="button" :to="ctaTo()">{{ auth.signedIn ? 'Open app' : 'Sign in' }}</RouterLink>
      </div>
    </header>

    <main>
      <section class="hero container">
        <div class="hero-copy">
          <p class="eyebrow">Browser SSH client</p>
          <h1>Your SSH hosts, in a browser tab.</h1>
          <p class="sub">
            Sign in with Google, click a host from your synced list, and a real
            terminal opens in the tab — nothing to install.
          </p>
          <div class="cta-row">
            <RouterLink class="button primary large" :to="ctaTo()">
              {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
            </RouterLink>
            <a class="text-link" href="#how">See how it works</a>
          </div>
          <p class="cta-note">Free · access is currently allowlisted · nothing to install on your servers</p>
          <ul class="chips" aria-label="Key facts">
            <li class="chip">Zero-knowledge sync</li>
            <li class="chip">Keys stay local</li>
            <li class="chip">Works on iPad &amp; Chromebooks</li>
          </ul>
        </div>
        <section id="fact-strip" aria-label="Key facts">
          <ul class="fact-strip">
            <li class="fact"><strong>AES-256-GCM · PBKDF2 600k</strong>zero-knowledge, end-to-end</li>
            <li class="fact"><strong>Real xterm.js terminal</strong>scrollback, copy/paste, resize</li>
            <li class="fact"><strong>No server-side install</strong>plain SSH is enough</li>
            <li class="fact"><strong>iPad · Chromebook · phone</strong>any browser tab works</li>
          </ul>
        </section>
        <div class="hero-visual" aria-hidden="true">
          <div class="term-mock">
            <div class="bar">
              <span class="dot" /><span class="dot" /><span class="dot" />
              <span class="title">ssh — edge-1</span>
            </div>
            <pre><span class="t-prompt">$</span> ssh edge-1
<span class="t-dim">Last login: Tue Sep  9 08:14 UTC</span>
<span class="t-user">deploy@edge-1</span>:<span class="t-dir">~</span>$ tmux attach -t agent
<span class="t-green">●</span> agent — claude is running (2h 14m)
  <span class="t-dim">✓ 14 tests passing</span>
  <span class="t-dim">→ refactor: extracting sync merge logic</span>
<span class="t-user">deploy@edge-1</span>:<span class="t-dir">~</span>$ <span class="cursor">█</span></pre>
          </div>
        </div>
      </section>

      <section id="how" class="band">
        <div class="container">
          <h2>From zero to a shell in three steps</h2>
          <ol class="steps">
            <li class="step">
              <span class="num">1</span>
              <h3>Your hosts are already there</h3>
              <p>Sign in with the same Google account the desktop app syncs with — your host list is already yours.</p>
            </li>
            <li class="step">
              <span class="num">2</span>
              <h3>Only you can read them</h3>
              <p>Enter your sync passphrase once to decrypt the host list. It never leaves this browser.</p>
            </li>
            <li class="step">
              <span class="num">3</span>
              <h3>Click a host, get a shell</h3>
              <p>Click Connect — the session rides an authenticated WebSocket straight to SSH, and your server just sees a normal login.</p>
            </li>
          </ol>
        </div>
      </section>

      <section id="features" class="band">
        <div class="container">
          <h2>Why a browser tab beats another terminal app</h2>
          <div class="frow">
            <div class="frow-copy">
              <h3>Your hosts, already there</h3>
              <p class="outcome">
                Hosts saved in the desktop app appear on the web automatically — no re-entering
                addresses, users, and ports a second time. The sync is zero-knowledge: the blob is
                encrypted in your browser before it leaves it, and the server stores ciphertext it
                can't read.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Zero-knowledge sync</li>
                <li class="chip">AES-256-GCM</li>
                <li class="chip">Passphrase never uploaded</li>
              </ul>
              <a class="text-link" href="/blog/ssh-config-file">Keep ~/.ssh/config tidy across machines</a>
            </div>
            <div class="frow-visual">
              <div class="hosts-mock" aria-hidden="true">
                <div class="hosts-bar">Hosts <span class="pill">synced · encrypted</span></div>
                <div class="hosts-row"><span class="hname">edge-1</span><span class="hmeta">deploy@203.0.113.10:22</span><span class="hbtn">Connect</span></div>
                <div class="hosts-row"><span class="hname">db-prod</span><span class="hmeta">admin@db.internal:22</span><span class="hbtn">Connect</span></div>
                <div class="hosts-row"><span class="hname">ci-runner</span><span class="hmeta">root@10.0.4.17:2222</span><span class="hbtn">Connect</span></div>
              </div>
            </div>
          </div>

          <div class="frow frow--flip">
            <div class="frow-copy">
              <h3>A real terminal, not a web toy</h3>
              <p class="outcome">
                Full xterm.js in the tab: colors, scrollback, copy and paste, resize — not a
                screen-sharing approximation of one. When the connection drops, the tab is the only
                thing that ends: reattach to tmux and pick up exactly where you left off.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Full scrollback</li>
                <li class="chip">Copy/paste</li>
                <li class="chip">Survives disconnects</li>
              </ul>
              <a class="text-link" href="/blog/tmux-persistent-ssh-sessions">tmux sessions that survive anything</a>
            </div>
            <div class="frow-visual">
              <div class="term-mock" aria-hidden="true">
                <div class="bar">
                  <span class="dot" /><span class="dot" /><span class="dot" />
                  <span class="title">ssh — edge-1</span>
                </div>
                <pre><span class="t-prompt">$</span> tmux attach -t work
<span class="t-user">deploy@edge-1</span>:<span class="t-dir">~</span>$ tail -f logs/api.log
[api] GET /health 200 2ms
[api] POST /sync 204 8ms
<span class="t-user">deploy@edge-1</span>:<span class="t-dir">~</span>$ <span class="cursor">█</span></pre>
              </div>
            </div>
          </div>

          <div class="frow">
            <div class="frow-copy">
              <h3>Works where clients can't</h3>
              <p class="outcome">
                iPad, Chromebook, a locked-down work laptop — if it has a browser, it's your
                terminal. Nothing to install, and private keys never sync: a key you attach is
                encrypted in this browser only and used once, in memory.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Keys stay local</li>
                <li class="chip">Nothing to install</li>
                <li class="chip">Any modern browser</li>
              </ul>
              <a class="text-link" href="/blog/ssh-authorized-keys-hardening">One key per device: SSH keys, hardened</a>
            </div>
            <div class="frow-visual">
              <div class="devices" aria-hidden="true">
                <div class="device device--laptop">
                  <div class="screen"><span /><span class="hl" /><span /><span /></div>
                  <div class="base" />
                </div>
                <div class="device device--tablet"><div class="screen"><span /><span /><span class="hl" /><span /></div></div>
                <div class="device device--phone"><div class="screen"><span class="hl" /><span /><span /></div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="security" class="band">
        <div class="container">
          <div class="security">
            <div class="security-copy">
              <h2>Zero-knowledge by design</h2>
              <p>No badges, no promises — this is the actual data path, step by step.</p>
              <ol class="sec-flow">
                <li class="sec-item">
                  <span class="n">01</span>
                  <h3>Passphrase stays local</h3>
                  <p>Typed once per session and used in your browser, never sent — there is no server-side reset, because the server never had it.</p>
                </li>
                <li class="sec-item">
                  <span class="n">02</span>
                  <h3>PBKDF2, 600,000 iterations</h3>
                  <p>The encryption key is derived from your passphrase with PBKDF2-SHA256, so the stored blob resists offline guessing.</p>
                </li>
                <li class="sec-item">
                  <span class="n">03</span>
                  <h3>AES-256-GCM before sync</h3>
                  <p>The host list is encrypted before it leaves the browser. The sync server stores ciphertext it cannot read.</p>
                </li>
                <li class="sec-item">
                  <span class="n">04</span>
                  <h3>Keys never sync at all</h3>
                  <p>SSH private keys are entered per host, encrypted with your passphrase, and stored in that one browser only.</p>
                </li>
              </ol>
              <p class="sec-bridge">
                Sessions ride an authenticated WebSocket to an SSH bridge on AWS (eu-west-1); your
                servers see a normal SSH login and need nothing installed.
              </p>
              <RouterLink class="button primary large" :to="ctaTo()">
                {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
              </RouterLink>
            </div>
          </div>
        </div>
      </section>

      <section id="opensource" class="band">
        <div class="container">
          <div class="oss">
            <div class="oss-copy">
              <h2>Built in the open</h2>
              <p>
                PocketShell is an independent project by
                <a href="https://github.com/alexeygrigorev">Alexey Grigorev</a>,
                developed out in the open — the commit history below is the
                actual GitHub record.
              </p>
            </div>
            <figure class="oss-figure">
              <a href="https://github.com/alexeygrigorev">
                <img
                  class="oss-image"
                  :src="githubGraph"
                  alt="GitHub contribution calendar for alexeygrigorev: 30,111 contributions in the last year"
                  width="924"
                  height="231"
                  loading="lazy"
                />
              </a>
              <figcaption>
                The real commit history behind PocketShell — follow along on GitHub.
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section id="blog" class="band">
        <div class="container">
          <h2>From the blog</h2>
          <p class="band-sub">Practical notes on SSH and remote machines — the kind of things you'll want a terminal for.</p>
          <div class="cards blog-cards">
            <a v-for="post in latestPosts" :key="post.slug" class="card card-link" :href="`/blog/${post.slug}`">
              <h3>{{ post.title }}</h3>
              <p>{{ post.description }}</p>
              <span class="card-meta">{{ post.readingMinutes }} min read</span>
            </a>
          </div>
          <p class="band-more"><a class="text-link" href="/blog">All posts →</a></p>
        </div>
      </section>

      <section id="faq" class="band">
        <div class="container">
          <h2>Frequently asked questions</h2>
          <div class="faq">
            <details>
              <summary>Who can see my host list?</summary>
              <p>
                Only you. The list is encrypted in your browser before it syncs —
                PBKDF2 with 600,000 iterations derives the key from your sync
                passphrase, AES-256-GCM encrypts the blob. The server stores
                ciphertext it cannot read, and the passphrase never leaves your
                device.
              </p>
            </details>
            <details>
              <summary>Is my SSH private key safe?</summary>
              <p>
                Private keys never sync. A key you attach to a host is encrypted
                with your sync passphrase, stored only in this browser, decrypted
                in memory when the session starts, and never uploaded.
              </p>
            </details>
            <details>
              <summary>Do I need the desktop app?</summary>
              <p>
                Yes — PocketShell web opens the hosts you saved in the
                PocketShell desktop app. The two sync end-to-end encrypted
                through your Google account, so the web client stays in step
                with the desktop.
              </p>
            </details>
            <details>
              <summary>Do I need to install anything on my servers?</summary>
              <p>
                No. Servers need nothing beyond the SSH port you already use.
                Sessions arrive at the SSH bridge on AWS (eu-west-1) over an
                authenticated WebSocket and continue to your host as a normal
                SSH login — no agent, no daemon, no extra ports.
              </p>
            </details>
            <details>
              <summary>Which devices can I use?</summary>
              <p>
                Anything with a modern browser: Linux, macOS, Windows,
                Chromebooks, iPads, and Android tablets — including locked-down
                machines where you can't install software.
              </p>
            </details>
            <details>
              <summary>What happens to my session when the tab closes?</summary>
              <p>
                The SSH session ends with the tab, but anything running under
                tmux or similar keeps going on your server. Reconnect,
                reattach, and everything is where you left it.
              </p>
            </details>
            <details>
              <summary>What if I lose my sync passphrase?</summary>
              <p>
                Then the synced blob is undecryptable — by design. Zero-knowledge
                means there is no reset: you'd sign in again, re-enter your
                hosts, and set a new passphrase. That's the trade for a server
                that can never read your data.
              </p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>
                Nothing. PocketShell is free while access is allowlisted — no
                card, no tiers. If that ever changes, existing users will hear
                it from us first.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section class="band">
        <div class="container">
          <div class="final-cta">
            <h2>Open a shell in a new tab.</h2>
            <p>Same hosts, same keys, same account as the desktop app.</p>
            <RouterLink class="button primary large" :to="ctaTo()">
              {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
            </RouterLink>
          </div>
        </div>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="footer-row">
        <span class="foot-brand"><span class="brand-mark">&gt;_</span> PocketShell</span>
        <span class="foot-dim">Built by Alexey Grigorev — a developer who wanted his servers from an iPad.</span>
        <nav class="footer-nav">
          <RouterLink :to="{ name: 'landing', hash: '#how' }">How it works</RouterLink>
          <RouterLink :to="{ name: 'landing', hash: '#security' }">Security</RouterLink>
          <RouterLink :to="{ name: 'landing', hash: '#faq' }">FAQ</RouterLink>
          <a href="/blog">Blog</a>
          <a href="https://github.com/alexeygrigorev">GitHub</a>
          <RouterLink :to="ctaTo()">{{ auth.signedIn ? 'Open app' : 'Sign in' }}</RouterLink>
        </nav>
      </div>
    </footer>
  </div>
</template>
