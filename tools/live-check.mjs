// Smoke-tests the deployed site: node tools/live-check.mjs [url]
import puppeteer from 'puppeteer-core';
import { findBrowser, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
const url = process.argv[2] || 'https://fansist.github.io/fathomless/';
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: 'new', protocolTimeout: 300000, defaultViewport: { width: 1280, height: 720 }, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/audio device/.test(m.text())) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
await page.goto(url, { waitUntil: 'load' });
await sleep(3500);
const title = await page.title();
await page.click('#btnDive'); await sleep(1500);
await page.keyboard.down('Space'); await sleep(700); await page.keyboard.up('Space'); await sleep(2500);
await page.keyboard.down('KeyD'); await sleep(1200); await page.keyboard.up('KeyD');
const st = await page.evaluate(() => { const g = window.__fathom.game; return { state: g.state, depth: g.run && g.run.depth, pings: g.run && g.run.pings, audio: window.__fathom.audio.ok, ctx: window.__fathom.audio.ctx && window.__fathom.audio.ctx.state, peak: window.__fathom.audio.peak() }; });
await page.screenshot({ path: fileURLToPath(new URL('./out/live.png', import.meta.url)) });
console.log(JSON.stringify({ url, title, st, errors, failed }));
try { await browser.close(); } catch (e) {}
