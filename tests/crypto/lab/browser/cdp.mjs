/**
 * Minimal Chrome DevTools Protocol driver — no automation framework, just
 * the bundled `ws` package talking to a headless Chromium's debug endpoint.
 * The browser is launched, pointed at the lab page, and the page's run()
 * is evaluated to completion; every stage is timeout-bounded.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const DEFAULT_CHROME = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
);

export async function withBrowser(pageUrl, run, log = () => {}) {
  const profile = mkdtempSync(join(tmpdir(), 'ps-crypto-browser-profile-'));
  const chromePath = process.env.SHIPPING_LAB_CHROME ?? DEFAULT_CHROME;
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.on('error', (err) => {
    throw new Error(`chrome spawn failed: ${err.message}`);
  });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('chrome did not expose a debug endpoint')), 20_000);
      chrome.stderr.on('data', (chunk) => {
        buffered += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chrome.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`chrome exited early (${code})`));
      });
    });
    log(`chrome: ${wsUrl}`);

    const browserWs = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      browserWs.once('open', resolve);
      browserWs.once('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const events = [];
    browserWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled' && events.length < 200) {
          log(`[console.${msg.params.type}] ${msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        }
        if (msg.method === 'Runtime.exceptionThrown' && events.length < 200) {
          log(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
        }
      }
    });
    const waitForEvent = (method, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const existing = events.find((e) => e.method === method);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
        const poll = setInterval(() => {
          const found = events.find((e) => e.method === method);
          if (found) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(found);
          }
        }, 50);
      });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url: pageUrl }, sessionId);
    await waitForEvent('Page.loadEventFired', 30_000);

    // the page signals when its module graph is live
    await until(
      async () =>
        (await evalJs(send, sessionId, 'window.__shippingLabReady === true')) === true,
      20_000,
      'lab page never became ready',
    );
    const outcome = await evalJs(send, sessionId, 'window.__shippingLabRun()', 120_000);
    browserWs.close();
    return outcome;
  } finally {
    chrome.kill('SIGTERM');
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        chrome.kill('SIGKILL');
        resolve(null);
      }, 3_000);
      chrome.once('exit', () => {
        clearTimeout(killTimer);
        resolve(null);
      });
    });
    rmSync(profile, { recursive: true, force: true });
  }
}

async function evalJs(send, sessionId, expression, timeoutMs = 30_000) {
  const result = await Promise.race([
    send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 60)}`)), timeoutMs)),
  ]);
  if (result.exceptionDetails) {
    throw new Error(
      `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

async function until(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}
