#!/usr/bin/env node
// Keeps the profile README current: featured projects, recent projects, recent activity,
// and the stats, languages and contribution cards in assets/generated.
// Runs in GitHub Actions on a schedule. No dependencies: Node 20+ only.
//
//   node .github/scripts/update-profile.mjs                  live data (needs GITHUB_TOKEN)
//   node .github/scripts/update-profile.mjs --fixture f.json  offline test with saved data
//   node .github/scripts/update-profile.mjs --dump f.json     also save the fetched data

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const USER = process.env.PROFILE_USER || (process.env.GITHUB_REPOSITORY || '').split('/')[0] || 'Umair-Habibx123';
const TOKEN = process.env.GITHUB_TOKEN;

const CONFIG = {
  featuredCount: 6,       // pinned repos come first, then the best of the rest
  recentCount: 5,
  activityCount: 6,
  languageCount: 6,
  excludeRepos: [USER],   // repos never shown as projects
  ignoreLanguages: [],    // for example ['Jupyter Notebook']
};

/* ---------------- Fetching ---------------- */

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': `${USER}-profile` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

async function rest(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { Authorization: `bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': `${USER}-profile` },
  });
  if (!res.ok) throw new Error(`GitHub REST error ${res.status} for ${pathname}`);
  return res.json();
}

async function fetchLive() {
  if (!TOKEN) throw new Error('Set GITHUB_TOKEN, or run with --fixture <file>.');

  const base = await gql(`query($login: String!) {
    user(login: $login) {
      login name createdAt
      followers { totalCount }
      pullRequests { totalCount }
      contributionsCollection { contributionYears }
      pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { name } } }
    }
  }`, { login: USER });
  const u = base.user;

  const repos = [];
  let cursor = null;
  do {
    const page = await gql(`query($login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: {field: PUSHED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name description url homepageUrl stargazerCount forkCount isFork isArchived pushedAt createdAt
            primaryLanguage { name color }
            repositoryTopics(first: 8) { nodes { topic { name } } }
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
          }
        }
      }
    }`, { login: USER, cursor });
    const conn = page.user.repositories;
    repos.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  // One request for every year's contributions.
  const years = u.contributionsCollection.contributionYears;
  const parts = years.map((y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
    totalCommitContributions
    contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
  }`);
  const yearly = years.length ? (await gql(`query($login: String!) { user(login: $login) { ${parts.join('\n')} } }`, { login: USER })).user : {};

  let events = [];
  try { events = await rest(`/users/${USER}/events/public?per_page=60`); } catch { events = []; }

  // The public events feed is often empty, so recent work also comes from contributions data.
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const emptyRecent = { commitContributionsByRepository: [], repositoryContributions: { nodes: [] }, pullRequestContributions: { nodes: [] } };
  const recent = await gql(`query($login: String!, $from: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from) {
        commitContributionsByRepository(maxRepositories: 8) {
          repository { nameWithOwner isPrivate }
          contributions(first: 1, orderBy: {field: OCCURRED_AT, direction: DESC}) { totalCount nodes { occurredAt } }
        }
        repositoryContributions(first: 5) { nodes { occurredAt repository { nameWithOwner isPrivate } } }
        pullRequestContributions(first: 5) { nodes { occurredAt pullRequest { number url repository { nameWithOwner isPrivate } } } }
      }
    }
  }`, { login: USER, from: since })
    .then((d) => d.user.contributionsCollection)
    .catch((err) => { console.warn(`Recent work unavailable: ${err.message}`); return emptyRecent; });

  return {
    user: { login: u.login, name: u.name || u.login, createdAt: u.createdAt, followers: u.followers.totalCount, pullRequests: u.pullRequests.totalCount },
    pinned: u.pinnedItems.nodes.map((n) => n.name),
    repos: repos.map((r) => ({
      name: r.name, description: r.description || '', url: r.url, homepage: r.homepageUrl || '',
      stars: r.stargazerCount, forks: r.forkCount, isFork: r.isFork, isArchived: r.isArchived,
      pushedAt: r.pushedAt, createdAt: r.createdAt,
      language: r.primaryLanguage ? r.primaryLanguage.name : '',
      topics: r.repositoryTopics.nodes.map((t) => t.topic.name),
      languages: r.languages.edges.map((e) => ({ name: e.node.name, color: e.node.color, size: e.size })),
    })),
    years: years.map((y) => ({
      year: y,
      total: yearly[`y${y}`].contributionCalendar.totalContributions,
      commits: yearly[`y${y}`].totalCommitContributions,
      days: yearly[`y${y}`].contributionCalendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount })),
    })),
    events: events.map((e) => ({ type: e.type, repo: e.repo.name, date: e.created_at, payload: e.payload || {} })),
    recentWork: [
      ...recent.commitContributionsByRepository.filter((c) => !c.repository.isPrivate).map((c) => ({
        kind: 'commits', repo: c.repository.nameWithOwner, count: c.contributions.totalCount,
        date: c.contributions.nodes[0] ? c.contributions.nodes[0].occurredAt : since,
      })),
      ...recent.repositoryContributions.nodes.filter((n) => !n.repository.isPrivate).map((n) => ({ kind: 'created', repo: n.repository.nameWithOwner, date: n.occurredAt })),
      ...recent.pullRequestContributions.nodes.filter((n) => !n.pullRequest.repository.isPrivate).map((n) => ({
        kind: 'pr', repo: n.pullRequest.repository.nameWithOwner, number: n.pullRequest.number, url: n.pullRequest.url, date: n.occurredAt,
      })),
    ],
  };
}

/* ---------------- Numbers ---------------- */

function computeStats(data) {
  const today = new Date().toISOString().slice(0, 10);
  const byDate = new Map();
  for (const y of data.years) for (const d of y.days) if (d.date <= today) byDate.set(d.date, d.count);
  const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));

  let longest = 0, run = 0;
  for (const d of days) { run = d.count > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1;  // today may not have contributions yet
  for (; i >= 0 && days[i].count > 0; i -= 1) current += 1;

  const last365 = days.slice(-365);
  const own = data.repos.filter((r) => !r.isFork);
  const weeks = [];
  const recent = days.slice(-364);
  for (let w = 0; w < recent.length; w += 7) {
    const chunk = recent.slice(w, w + 7);
    weeks.push({ start: chunk[0].date, count: chunk.reduce((s, d) => s + d.count, 0) });
  }

  return {
    activeDays: last365.filter((d) => d.count > 0).length,
    allTime: data.years.reduce((s, y) => s + y.total, 0),
    lastYear: last365.reduce((s, d) => s + d.count, 0),
    commits: data.years.reduce((s, y) => s + (y.commits || 0), 0),
    current, longest,
    repos: own.length,
    stars: own.reduce((s, r) => s + r.stars, 0),
    pullRequests: data.user.pullRequests || 0,
    since: (data.user.createdAt || '').slice(0, 4),
    weeks,
  };
}

function computeLanguages(data) {
  const totals = new Map();
  for (const r of data.repos) {
    if (r.isFork || r.isArchived || CONFIG.excludeRepos.includes(r.name)) continue;
    for (const l of r.languages) {
      if (CONFIG.ignoreLanguages.includes(l.name)) continue;
      const cur = totals.get(l.name) || { name: l.name, color: l.color || '#8B949E', size: 0 };
      cur.size += l.size;
      totals.set(l.name, cur);
    }
  }
  const list = [...totals.values()].sort((a, b) => b.size - a.size);
  const sum = list.reduce((s, l) => s + l.size, 0) || 1;
  const top = list.slice(0, CONFIG.languageCount);
  const rest = list.slice(CONFIG.languageCount).reduce((s, l) => s + l.size, 0);
  if (rest > 0) top.push({ name: 'Other', color: '#8B949E', size: rest });
  return top.map((l) => ({ ...l, pct: (l.size / sum) * 100 }));
}

/* ---------------- Cards (SVG) ---------------- */

const THEMES = {
  dark: { bg: '#0D1117', border: '#30363D', text: '#E6EDF3', muted: '#8B949E', accent: '#38BDF8', accent2: '#FB923C', track: '#21262D' },
  light: { bg: '#FFFFFF', border: '#D0D7DE', text: '#1F2328', muted: '#59636E', accent: '#0284C7', accent2: '#EA580C', track: '#EAEEF2' },
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n).toLocaleString('en-US');

function frame(w, h, t, title, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<style>text { font-family: ${FONT}; }</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
<text x="24" y="38" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>
${body}
</svg>
`;
}

function overviewCard(stats, name, t) {
  const tiles = [
    ['Total contributions', num(stats.allTime), t.accent],
    ['Contributions, last year', num(stats.lastYear), t.text],
    ['Current streak', `${num(stats.current)} ${stats.current === 1 ? 'day' : 'days'}`, t.accent2],
    ['Longest streak', `${num(stats.longest)} ${stats.longest === 1 ? 'day' : 'days'}`, t.text],
    ['Commits', num(stats.commits), t.text],
    // Show pull requests once there are some; until then, show how many days had contributions.
    stats.pullRequests > 0 ? ['Pull requests', num(stats.pullRequests), t.text] : ['Active days, last year', num(stats.activeDays), t.text],
    ['Public repositories', num(stats.repos), t.text],
    ['Stars earned', num(stats.stars), t.text],
  ];
  const w = 860, colW = (w - 48) / 4;
  const body = tiles.map(([label, value, color], i) => {
    const x = 24 + (i % 4) * colW, y = i < 4 ? 74 : 138;
    return `<g class="in" style="animation-delay:${i * 60}ms">
  <text x="${x}" y="${y}" font-size="12.5" fill="${t.muted}">${esc(label)}</text>
  <text x="${x}" y="${y + 28}" font-size="24" font-weight="600" fill="${color}">${esc(value)}</text>
</g>`;
  }).join('\n');
  const since = stats.since ? `<text x="${w - 24}" y="38" font-size="12.5" text-anchor="end" fill="${t.muted}">On GitHub since ${esc(stats.since)}</text>` : '';
  return frame(w, 190, t, `${name} on GitHub`, since + body, `${name}: ${num(stats.allTime)} contributions, ${num(stats.repos)} public repositories, current streak ${stats.current} days`);
}

function languagesCard(langs, t) {
  const w = 420, h = 230, barX = 24, barW = w - 48, barY = 60;
  let x = barX;
  const segs = langs.map((l) => {
    const sw = Math.max(2, (l.pct / 100) * barW);
    const r = `<rect x="${x.toFixed(2)}" y="${barY}" width="${sw.toFixed(2)}" height="10" fill="${l.color}"/>`;
    x += sw;
    return r;
  }).join('');
  const rows = langs.map((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 24 + col * 190, ly = 102 + row * 32;
    return `<g class="in" style="animation-delay:${i * 60}ms">
  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/>
  <text x="${lx + 18}" y="${ly}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
  <text x="${lx + 170}" y="${ly}" font-size="13" text-anchor="end" fill="${t.muted}">${l.pct.toFixed(1)}%</text>
</g>`;
  }).join('\n');
  const body = `<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>
<rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" fill="${t.track}"/>
<g clip-path="url(#bar)">${segs}</g>
${rows}`;
  const empty = `<text x="24" y="110" font-size="13" fill="${t.muted}">No language data yet.</text>`;
  return frame(w, h, t, 'Most used languages', langs.length ? body : empty, `Most used languages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(', ')}`);
}

function activityCard(stats, t) {
  const w = 420, h = 230, left = 24, right = w - 24, top = 74, bottom = 190;
  const weeks = stats.weeks;
  const max = Math.max(1, ...weeks.map((wk) => wk.count));
  const slot = (right - left) / Math.max(1, weeks.length);
  const bw = Math.max(2, slot - 2);
  const bars = weeks.map((wk, i) => {
    const bh = wk.count ? Math.max(3, ((bottom - top) * wk.count) / max) : 2;
    const color = wk.count ? t.accent : t.track;
    return `<rect class="grow" style="animation-delay:${i * 12}ms" x="${(left + i * slot).toFixed(2)}" y="${(bottom - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="1.5" fill="${color}"><title>Week of ${wk.start}: ${wk.count}</title></rect>`;
  }).join('\n');
  const month = (d) => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const labels = weeks.length ? `<text x="${left}" y="${bottom + 20}" font-size="11.5" fill="${t.muted}">${esc(month(weeks[0].start))}</text>
<text x="${right}" y="${bottom + 20}" font-size="11.5" text-anchor="end" fill="${t.muted}">This week</text>` : '';
  const sub = `<text x="24" y="58" font-size="12.5" fill="${t.muted}">${num(stats.lastYear)} contributions in the last 12 months, by week</text>`;
  return frame(w, h, t, 'Contribution activity', sub + bars + labels, `Contribution activity: ${num(stats.lastYear)} contributions in the last 12 months`);
}

/* ---------------- README sections ---------------- */

const html = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s) => html(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[\s,.;:-]+$/, '')}…`;
};
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function chooseFeatured(data) {
  const usable = data.repos.filter((r) => !r.isFork && !r.isArchived && !CONFIG.excludeRepos.includes(r.name));
  const byName = new Map(usable.map((r) => [r.name, r]));
  const picked = data.pinned.map((n) => byName.get(n)).filter(Boolean);
  const score = (r) => r.stars * 10 + r.forks * 5 + (r.description ? 3 : 0) + Math.min(r.topics.length, 5) + (r.homepage ? 2 : 0)
    + Math.max(0, 6 - (Date.now() - new Date(r.pushedAt)) / (30 * 864e5));
  const rest = usable.filter((r) => !picked.includes(r) && r.description).sort((a, b) => score(b) - score(a));
  return [...picked, ...rest].slice(0, CONFIG.featuredCount);
}

function featuredSection(data) {
  const list = chooseFeatured(data);
  if (!list.length) return '_Projects will appear here soon._';
  const cell = (r) => {
    const meta = [r.language ? `<code>${html(r.language)}</code>` : '', r.stars ? `⭐ ${r.stars}` : '', r.homepage ? `<a href="${html(r.homepage)}">Live demo</a>` : '']
      .filter(Boolean).join(' &nbsp;·&nbsp; ');
    const topics = r.topics.slice(0, 4).map((t) => `<code>#${html(t)}</code>`).join(' ');
    return `<td width="50%" valign="top">
<h3><a href="${html(r.url)}">${html(r.name)}</a></h3>
<p>${html(clip(r.description, 150)) || 'No description yet.'}</p>
<p>${meta}</p>
${topics ? `<p><sub>${topics}</sub></p>` : ''}
</td>`;
  };
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(`<tr>\n${cell(list[i])}\n${list[i + 1] ? cell(list[i + 1]) : '<td width="50%"></td>'}\n</tr>`);
  return `<table>\n${rows.join('\n')}\n</table>`;
}

function recentSection(data) {
  const list = data.repos
    .filter((r) => !r.isFork && !CONFIG.excludeRepos.includes(r.name))
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .slice(0, CONFIG.recentCount);
  if (!list.length) return '_Nothing yet._';
  return list.map((r) => `- **[${md(r.name)}](${r.url})**${r.description ? ` — ${md(clip(r.description, 90))}` : ''}${r.language ? ` · \`${r.language}\`` : ''} · <sub>updated ${shortDate(r.pushedAt)}</sub>`).join('\n');
}

function activitySection(data) {
  const link = (repo) => `[${md(repo.split('/')[1] || repo)}](https://github.com/${repo})`;
  const lines = [];
  for (const e of data.events) {
    const p = e.payload, day = shortDate(e.date);
    let text = null, key = null;
    switch (e.type) {
      case 'PushEvent': {
        const n = p.size || p.distinct_size || (p.commits ? p.commits.length : 0) || 1;
        key = `push:${e.repo}:${day}`;
        const prev = lines.find((l) => l.key === key);
        if (prev) { prev.n += n; prev.text = `⬆️ Pushed ${prev.n} commits to ${link(e.repo)}`; continue; }
        text = `⬆️ Pushed ${n} ${n === 1 ? 'commit' : 'commits'} to ${link(e.repo)}`;
        lines.push({ key, n, text, day });
        continue;
      }
      case 'CreateEvent':
        if (p.ref_type === 'repository') text = `🆕 Created ${link(e.repo)}`;
        else if (p.ref_type === 'tag') text = `🏷️ Tagged \`${md(p.ref)}\` in ${link(e.repo)}`;
        break;
      case 'ReleaseEvent': text = `🚀 Released \`${md(p.release ? p.release.tag_name : '')}\` of ${link(e.repo)}`; break;
      case 'PullRequestEvent': if (p.pull_request) text = `🔀 ${p.action === 'closed' && p.pull_request.merged ? 'Merged' : p.action === 'opened' ? 'Opened' : null} pull request [#${p.pull_request.number}](${p.pull_request.html_url}) in ${link(e.repo)}`; if (text && text.includes('null')) text = null; break;
      case 'IssuesEvent': if (p.issue && p.action === 'opened') text = `📝 Opened issue [#${p.issue.number}](${p.issue.html_url}) in ${link(e.repo)}`; break;
      case 'PublicEvent': text = `📢 Open-sourced ${link(e.repo)}`; break;
      case 'WatchEvent': text = `⭐ Starred ${link(e.repo)}`; break;
      case 'ForkEvent': text = `🍴 Forked ${link(e.repo)}`; break;
      default: break;
    }
    if (text) lines.push({ text, day });
  }
  // Contributions data covers what the events feed misses: commits per repo, new repos and pull requests.
  const seen = new Set(lines.map((l) => l.text));
  const work = (data.recentWork || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  for (const w of work) {
    let text = null;
    if (w.kind === 'commits') text = `⬆️ ${w.count} ${w.count === 1 ? 'commit' : 'commits'} to ${link(w.repo)}`;
    else if (w.kind === 'created') text = `🆕 Created ${link(w.repo)}`;
    else if (w.kind === 'pr') text = `🔀 Opened pull request [#${w.number}](${w.url}) in ${link(w.repo)}`;
    if (text && !seen.has(text)) { seen.add(text); lines.push({ text, day: shortDate(w.date), sortKey: w.date }); }
  }
  const top = lines.slice(0, CONFIG.activityCount);
  if (!top.length) return '_No public activity in the last 30 days._';
  return `<sub>Last 30 days</sub>\n\n${top.map((l) => `- ${l.text} <sub>· ${l.day}</sub>`).join('\n')}`;
}

/* ---------------- Writing ---------------- */

function replaceSection(text, name, content) {
  const re = new RegExp(`(<!--START_SECTION:${name}-->)[\\s\\S]*?(<!--END_SECTION:${name}-->)`);
  if (!re.test(text)) { console.warn(`README has no ${name} section markers, skipping it.`); return text; }
  return text.replace(re, `$1\n${content}\n$2`);
}

async function writeIfChanged(file, content) {
  let old = null;
  try { old = await readFile(file, 'utf8'); } catch { /* new file */ }
  if (old === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return true;
}

async function main() {
  const fixture = flag('--fixture');
  const data = fixture ? JSON.parse(await readFile(path.resolve(fixture), 'utf8')) : await fetchLive();
  const dump = flag('--dump');
  if (dump) await writeFile(path.resolve(dump), JSON.stringify(data, null, 2));

  const stats = computeStats(data);
  const langs = computeLanguages(data);
  const name = (data.user.name || USER).split(' ')[0];
  const outDir = path.join(ROOT, 'assets', 'generated');
  const changed = [];
  for (const [theme, t] of Object.entries(THEMES)) {
    if (await writeIfChanged(path.join(outDir, `overview-${theme}.svg`), overviewCard(stats, name, t))) changed.push(`overview-${theme}.svg`);
    if (await writeIfChanged(path.join(outDir, `languages-${theme}.svg`), languagesCard(langs, t))) changed.push(`languages-${theme}.svg`);
    if (await writeIfChanged(path.join(outDir, `activity-${theme}.svg`), activityCard(stats, t))) changed.push(`activity-${theme}.svg`);
  }

  const readmePath = path.join(ROOT, 'README.md');
  const before = await readFile(readmePath, 'utf8');
  let after = before;
  after = replaceSection(after, 'featured', featuredSection(data));
  after = replaceSection(after, 'recent', recentSection(data));
  after = replaceSection(after, 'activity', activitySection(data));
  const strip = (s) => s.replace(/<!--START_SECTION:updated-->[\s\S]*?<!--END_SECTION:updated-->/, '');
  if (strip(after) !== strip(before) || changed.length) {
    const stamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
    after = replaceSection(after, 'updated', `<sub>Updated automatically from live GitHub data · ${stamp} UTC</sub>`);
  }
  if (await writeIfChanged(readmePath, after)) changed.push('README.md');

  console.log(changed.length ? `Updated: ${changed.join(', ')}` : 'Everything is already up to date.');
  console.log(`Stats: ${stats.allTime} contributions, ${stats.repos} repos, ${stats.stars} stars, streak ${stats.current}/${stats.longest}. Languages: ${langs.map((l) => l.name).join(', ')}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
