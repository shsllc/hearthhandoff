import { html, raw } from 'hono/html';
import { config } from '../config.ts';

export interface Viewer { id: string; name: string; role: 'owner' | 'caregiver'; householdId: string }

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5b5a55;--card:#fff;--line:#d9d6cf;--accent:#1f5f8b;--accent-fg:#fff;
--ok:#1e6b3a;--ok-bg:#e3f2e8;--warn:#8a4b00;--warn-bg:#fdf0dc;--bad:#9b1c1c;--bad-bg:#fbe5e5;--info:#28507a;--info-bg:#e5eef8;--demo:#5b3f8a;--demo-bg:#efe8fa}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#f0eee9;--muted:#b4b1a9;--card:#201f1c;--line:#3a3833;--accent:#7cb8e4;--accent-fg:#0d1b26;
--ok:#8fd6a5;--ok-bg:#16301f;--warn:#f2c27b;--warn-bg:#3a2a12;--bad:#f3a3a3;--bad-bg:#3d1a1a;--info:#a9c9ec;--info-bg:#1a2a3c;--demo:#cdb6f3;--demo-bg:#2a2140}}
*{box-sizing:border-box}html{font-size:112.5%}body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}main{max-width:52rem;margin:0 auto;padding:1rem 1rem 4rem}
header.top{border-bottom:1px solid var(--line);background:var(--card)}header.top .in{max-width:52rem;margin:0 auto;padding:.75rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header.top .brand{font-weight:700;font-size:1.15rem;text-decoration:none;color:var(--fg)}header.top .who{margin-left:auto;color:var(--muted)}
h1{font-size:1.6rem;margin:1.2rem 0 .4rem}h2{font-size:1.2rem;margin:1.8rem 0 .6rem}h3{font-size:1.05rem;margin:0 0 .3rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin:.75rem 0}
.muted{color:var(--muted)}.small{font-size:.9rem}
.pill{display:inline-block;border-radius:999px;padding:.1rem .65rem;font-size:.85rem;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.bad{color:var(--bad);background:var(--bad-bg)}
.pill.info{color:var(--info);background:var(--info-bg)}.pill.demo{color:var(--demo);background:var(--demo-bg)}.pill.plain{color:var(--muted)}
.banner{padding:.6rem 1rem;background:var(--demo-bg);color:var(--demo);border-bottom:1px solid var(--line);font-size:.9rem;text-align:center}
.flash{border-left:4px solid var(--accent);background:var(--info-bg);padding:.6rem .9rem;border-radius:6px;margin:1rem 0}
button,.btn{font:inherit;border-radius:10px;padding:.6rem 1rem;border:2px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer;text-decoration:none;display:inline-block;min-height:44px}
button.secondary,.btn.secondary{background:transparent;color:var(--accent)}button.danger{border-color:var(--bad);background:var(--bad);color:#fff}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
label{display:block;font-weight:600;margin:.8rem 0 .25rem}input,select,textarea{font:inherit;width:100%;padding:.55rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
fieldset{border:1px solid var(--line);border-radius:10px;padding:.5rem 1rem 1rem;margin:1rem 0}legend{font-weight:600;padding:0 .3rem}
.check{display:flex;gap:.5rem;align-items:center;font-weight:400;margin:.4rem 0}.check input{width:auto;transform:scale(1.25)}
.row{display:flex;gap:.75rem;flex-wrap:wrap}.row>*{flex:1 1 12rem}.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.8rem}
ol.timeline{list-style:none;padding:0;margin:0;border-left:3px solid var(--line)}ol.timeline li{position:relative;padding:.2rem 0 1rem 1.1rem}
ol.timeline li::before{content:"";position:absolute;left:-.55rem;top:.55rem;width:.8rem;height:.8rem;border-radius:50%;background:var(--card);border:3px solid var(--line)}
ol.timeline li.ring::before{border-color:var(--info)}ol.timeline li.person::before{border-color:var(--ok)}ol.timeline li.alert::before{border-color:var(--warn)}
.caveat{font-size:.88rem;color:var(--muted);margin:.15rem 0 0}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .3rem;border-bottom:1px solid var(--line);vertical-align:top}
.visit-row{display:flex;gap:.75rem;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
`;

const LIVE = `
(()=>{let since=Number(document.body.dataset.since||0);let dirty=false;
document.addEventListener('input',()=>{dirty=true});
setInterval(async()=>{if(dirty||document.hidden)return;try{const r=await fetch('/api/changes?since='+since);const j=await r.json();
if(j.latest>since){since=j.latest;const live=document.getElementById('live');if(live)live.textContent='Updated';location.reload();}}catch{}},4000);})();`;

export function page(opts: { title: string; viewer?: Viewer | null; since?: number; flash?: string | null; body: unknown }) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title} · CareRelay</title><style>${raw(CSS)}</style></head>
<body data-since="${opts.since ?? 0}">
${config.demoMode ? html`<div class="banner" role="note">Demo build: sign-in is a person picker, and any scenario or replayed data is labeled where it appears.</div>` : ''}
<header class="top"><div class="in"><a class="brand" href="/">CareRelay</a>
${opts.viewer ? html`<span class="who">${opts.viewer.name} · ${opts.viewer.role === 'owner' ? 'Household owner' : 'Trusted person'}</span>
<form method="post" action="/signout" style="margin:0"><button class="secondary" type="submit">Sign out</button></form>` : ''}
</div></header>
<main id="main">
${opts.flash ? html`<p class="flash" role="status">${opts.flash}</p>` : ''}
<p id="live" class="sr" aria-live="polite"></p>
${opts.body}
</main>
${opts.viewer ? html`<script>${raw(LIVE)}</script>` : ''}
</body></html>`;
}
