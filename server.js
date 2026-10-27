// BullishBharat backend. Run: node server.js   (Node 18+, no npm packages needed)
// Put this file next to bullishbharat.html. Optional files: ipos.json, gmp.json
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = __dirname, EVERY = 15 * 60 * 1000, IPO_RETENTION_DAYS = 15;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const read = (f, d) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`Could not read ${f}:`, e.message);
    return d;
  }
};
const fmt = s => { const d = new Date(s); return isNaN(d) ? String(s || '') : `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const validRecord = x => x && typeof x === 'object' && !Array.isArray(x);
const validIpo = x => validRecord(x) && typeof x.id === 'string' && x.id.trim() && typeof x.n === 'string' && x.n.trim();
const ipoBoard = x => {
  const details = ['board', 'market', 'marketType', 'category', 'cat', 'segment', 'issueType', 'securityType', 'series']
    .map(key => String(x[key] || '')).join(' ').toLowerCase();
  return /\b(sme|emerge|sm|st)\b/.test(details) ? 'SME' : 'Mainboard';
};
function withinIpoRetention(ipo, now = Date.now()) {
  if (typeof ipo.close !== 'string' || !ipo.close.trim()) return true;
  const closeDate = new Date(ipo.close);
  if (!Number.isFinite(closeDate.getTime())) return true;
  closeDate.setHours(0, 0, 0, 0);
  closeDate.setDate(closeDate.getDate() + IPO_RETENTION_DAYS + 1);
  return now < closeDate.getTime();
}
let auto = [], autoUpcoming = [], autoCurrent = [], autoBseSme = [], chittorgarhIpos = [];
let liveIpoLogos = new Map();

const NSE_HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.nseindia.com/' };
const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.bseindia.com/markets/publicIssues/DisplayIPO.aspx',
  Origin: 'https://www.bseindia.com',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
};
async function bseJson(url) {
  const response = await fetch(url, { headers: BSE_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`BSE request failed (${response.status})`);
  const body = await response.text();
  try { return JSON.parse(body); }
  catch { throw new Error('BSE returned a non-JSON response'); }
}
async function nseJson(url, page = 'https://www.nseindia.com/') {
  const options = { headers: NSE_HEADERS, signal: AbortSignal.timeout(15000) };
  const landing = await fetch(page, options);
  if (!landing.ok) throw new Error(`NSE session request failed (${landing.status})`);
  const cookies = landing.headers.getSetCookie?.()
    || (landing.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
  const ck = cookies.map(c => c.split(';')[0]).join('; ');
  const response = await fetch(url, { ...options, headers: { ...NSE_HEADERS, Cookie: ck } });
  if (!response.ok) throw new Error(`NSE request failed (${response.status}): ${url}`);
  return response.json();
}
const nseRows = payload => (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [])
  .filter(validRecord);

const CHITTORGARH_HEADERS = {
  'User-Agent': 'BullishBharat/1.0 (IPO dashboard data)',
  Accept: 'text/html'
};
let investorGainGmp = new Map();
async function investorGainPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html',
      Referer: 'https://www.investorgain.com/'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`InvestorGain request failed (${response.status})`);
  return response.text();
}
function investorGainHistory(html) {
  const marker = html.indexOf('gmpHistoryData');
  if (marker < 0) return null;
  const start = html.indexOf('[', marker);
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let index = start; index < html.length; index++) {
    if (html[index] === '[') depth++;
    else if (html[index] === ']' && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) return null;
  let entries;
  try { entries = JSON.parse(html.slice(start, end).replace(/\\"/g, '"')); }
  catch { return null; }
  if (!Array.isArray(entries)) return null;
  const points = entries.map(entry => {
    const value = Number(entry?.gmp);
    const date = entry?.gmp_time || entry?.gmp_cr_dt;
    const time = Date.parse(date);
    return Number.isFinite(value) && Number.isFinite(time) ? { value, time } : null;
  }).filter(Boolean).sort((a, b) => a.time - b.time);
  if (points.length < 2) return null;
  return {
    h: points.map(point => point.value),
    gmpDates: points.map(point => new Date(point.time).toISOString())
  };
}
async function fromInvestorGainGmp(names) {
  const html = await investorGainPage('https://www.investorgain.com/report/ipo-gmp-live/331/');
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const records = new Map();
  const cell = (row, label) => row.match(new RegExp(
    `<td\\b[^>]*\\bdata-label=["']${label}["'][^>]*>([\\s\\S]*?)<\\/td>`, 'i'
  ))?.[1] || '';
  for (const row of rows) {
    const nameCell = cell(row, 'Name');
    const gmpCell = cell(row, 'GMP');
    const nameMatch = nameCell.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const pathMatch = nameCell.match(/<a\b[^>]*href=["'](\/gmp\/[a-z0-9-]+\/\d+\/)["']/i);
    if (!nameMatch || !gmpCell) continue;
    const name = htmlText(nameMatch[1]);
    const gmpText = htmlText(gmpCell).replace(/&minus;/gi, '-');
    const amount = gmpText.match(/₹\s*(--|—|–|-?\s*[\d,]+(?:\.\d+)?)/);
    if (!name || !amount || /^[-—–]+$/.test(amount[1].trim())) continue;
    const gmp = Number(amount[1].replace(/[\s,]/g, ''));
    const key = ipoNameKey(name);
    if (key && Number.isFinite(gmp)) records.set(key, {
      gmp,
      ...(pathMatch ? { path: pathMatch[1] } : {})
    });
  }
  if (!records.size) throw new Error('InvestorGain GMP page returned no usable rows');
  const wanted = new Set(names.map(ipoNameKey));
  const targets = [...records].filter(([key, value]) => wanted.has(key) && value.path);
  for (let offset = 0; offset < targets.length; offset += 4) {
    const batch = await Promise.all(targets.slice(offset, offset + 4).map(async ([key, value]) => {
      try {
        const detail = await investorGainPage(new URL(value.path, 'https://www.investorgain.com').href);
        const history = investorGainHistory(detail);
        if (history) records.set(key, { ...value, ...history });
      } catch (e) {
        console.log('InvestorGain GMP history failed:', key, e.message);
      }
    }));
  }
  const updatedAt = new Date().toISOString();
  return new Map([...records].map(([key, value]) => [key, {
    ...value,
    path: undefined,
    gmpSource: 'InvestorGain',
    gmpUpdatedAt: updatedAt
  }]));
}
async function chittorgarhPage(url) {
  const response = await fetch(url, { headers: CHITTORGARH_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Chittorgarh request failed (${response.status})`);
  return response.text();
}
function decodeChittorgarh(html) {
  return html.replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&').replace(/\\u0022/gi, '"').replace(/\\n/g, ' ').replace(/\\"/g, '"');
}
function htmlText(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&#8377;|&#x20b9;/gi, '₹')
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"').replace(/&#39;|&apos;|&lsquo;|&rsquo;/gi, "'")
    .replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—').replace(/&hellip;/gi, '…')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    }).replace(/\s+/g, ' ').trim();
}
function chittorgarhLinks(html, board) {
  const links = new Map();
  const re = /<a\b[^>]*href=["'](\/ipo\/[^"']+-ipo\/\d+\/)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = match[1], name = htmlText(match[2]);
    if (!name || links.has(href)) continue;
    const sourceId = href.match(/\/(\d+)\/$/)?.[1];
    links.set(href, { href, name, sec: board, sourceId });
  }
  return [...links.values()].slice(0, 10);
}
function chittorgarhNearbyValue(page, label, field = 'children') {
  const index = page.lastIndexOf(label);
  if (index < 0) return '';
  const nearby = page.slice(index, index + 1200);
  const pattern = field === '__html'
    ? /"__html":"([^"]+)"/
    : /"className":"text-end","children":"([^"]+)"/;
  return nearby.match(pattern)?.[1] || '';
}
function chittorgarhPriceBand(page) {
  const rows = page.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const text = htmlText(row);
    if (!/price band/i.test(text)) continue;
    const values = text.match(/\d[\d,]*(?:\.\d+)?/g) || [];
    if (!values.length) continue;
    const lo = parseFloat(values[0].replace(/,/g, ''));
    const hi = parseFloat((values[1] || values[0]).replace(/,/g, ''));
    if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo, hi };
  }
  const fallback = chittorgarhNearbyValue(page, '"children":["Price Band","$undefined"]', '__html');
  const values = htmlText(fallback).match(/\d[\d,]*(?:\.\d+)?/g) || [];
  const lo = parseFloat((values[0] || '').replace(/,/g, ''));
  const hi = parseFloat((values[1] || values[0] || '').replace(/,/g, ''));
  return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : { lo: 0, hi: 0 };
}
function chittorgarhSubscription(page) {
  const tables = page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  const table = tables.find(value => /Subscription\s*\(x\)/i.test(htmlText(value)));
  if (!table) return null;
  const values = { qib: null, nii: null, retail: null, total: null };
  const rows = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => htmlText(match[1]));
    if (cells.length < 2) continue;
    const category = cells[0].toLowerCase().replace(/\s+/g, ' ').trim();
    const subscription = parseFloat(cells[1].replace(/,/g, ''));
    if (!Number.isFinite(subscription)) continue;
    if (/^qib(?:\s|$)/.test(category)) values.qib = subscription;
    else if (/^nii(?:\s|$)/.test(category)) values.nii = subscription;
    else if (/^retail(?:\s|$)/.test(category)) values.retail = subscription;
    else if (/^total\b/.test(category)) values.total = subscription;
  }
  return Object.values(values).some(Number.isFinite)
    ? [values.qib, values.nii, values.retail, values.total]
    : null;
}
async function chittorgarhLiveSubscription(id) {
  const cacheKey = Date.now();
  const url = `https://www.chittorgarh.net/documents/subscription/${encodeURIComponent(id)}/subscriptions.html?abc=${cacheKey}`;
  const response = await fetch(url, {
    headers: {
      ...CHITTORGARH_HEADERS,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Referer: 'https://www.chittorgarh.com/'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Chittorgarh subscription request failed (${response.status})`);
  const subscription = chittorgarhSubscription(await response.text());
  return subscription ? {
    sub: subscription,
    subscriptionSource: 'Chittorgarh',
    subscriptionUpdatedAt: new Date().toISOString()
  } : null;
}
function chittorgarhTableRows(table) {
  return (table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []).map(row =>
    [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(match => htmlText(match[1]))
  );
}
function chittorgarhDivById(page, id) {
  const start = page.match(new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'));
  if (!start) return '';
  const contentStart = start.index + start[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1, match;
  while ((match = tags.exec(page))) {
    if (/^<\//.test(match[0])) depth--;
    else depth++;
    if (!depth) return page.slice(contentStart, match.index);
  }
  return '';
}
function chittorgarhLogo(page) {
  const images = page.match(/<img\b[^>]*>/gi) || [];
  for (const image of images) {
    const src = image.match(/\bsrc=["']([^"']+)["']/i)?.[1] || '';
    const label = image.match(/\b(?:alt|title)=["']([^"']+)["']/i)?.[1] || '';
    if (!/\/images\/ipo\//i.test(src) || !/\bipo logo\b/i.test(label)) continue;
    try {
      const url = new URL(src, 'https://www.chittorgarh.net');
      if (url.protocol === 'https:' && /(^|\.)chittorgarh\.net$/i.test(url.hostname)) return url.href;
    } catch (e) {
      console.log('Invalid Chittorgarh IPO logo URL:', e.message);
    }
  }
  return '';
}
function chittorgarhNumber(value) {
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
function chittorgarhFinancials(page) {
  const tables = page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  const table = tables.find(value => /<table\b[^>]*\bid=["']financialTable["']/i.test(value))
    || tables.find(value => /^Period Ended$/i.test(chittorgarhTableRows(value)[0]?.[0] || ''));
  if (!table) return [];
  const rows = chittorgarhTableRows(table);
  const headers = rows[0]?.slice(1) || [];
  const income = rows.find(row => /^(total income|revenue)$/i.test(row[0] || ''));
  const profit = rows.find(row => /^(profit after tax|profit \(after tax\)|pat)$/i.test(row[0] || ''));
  if (!income || !profit) return [];
  return headers.map((period, index) => {
    const revenue = chittorgarhNumber(income[index + 1]);
    const pat = chittorgarhNumber(profit[index + 1]);
    return revenue === null || pat === null ? null : [period, revenue, pat];
  }).filter(Boolean);
}
function chittorgarhShareholding(page) {
  const tables = page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  const table = tables.find(value => {
    const header = chittorgarhTableRows(value)[0] || [];
    return /^Category$/i.test(header[0] || '')
      && /^Pre IPO$/i.test(header[1] || '')
      && /^Post IPO$/i.test(header[2] || '');
  });
  if (!table) return [];
  return chittorgarhTableRows(table).slice(1)
    .filter(row => row.length >= 3 && row[0] && !/^total$/i.test(row[0]))
    .map(row => [row[0], chittorgarhNumber(row[1]), chittorgarhNumber(row[2])])
    .filter(([, pre, post]) => pre !== null || post !== null);
}
function chittorgarhAbout(page) {
  const section = chittorgarhDivById(page, 'ipoSummary');
  if (!section) return '';
  return [...section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => htmlText(match[1]))
    .filter(text => text && !/^competitive strengths$/i.test(text))
    .join('\n\n');
}
function chittorgarhKeyPoints(page) {
  const section = chittorgarhDivById(page, 'ipoSummary');
  const points = { st: [], rk: [] };
  if (!section) return points;
  const markers = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>|<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi;
  const headings = [...section.matchAll(markers)];
  for (let index = 0; index < headings.length; index++) {
    const heading = htmlText(headings[index][1] || headings[index][2]).replace(/[:.]+$/, '').trim();
    const key = /^(?:(?:key|main|competitive)\s+)?strengths?$/i.test(heading) ? 'st'
      : /^(?:(?:key|main|major|principal|ipo)\s+)*(?:risk(?:s| factors?)?|risk factors?)$/i.test(heading) ? 'rk'
        : null;
    if (!key) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? section.length;
    const list = section.slice(start, end).match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i)?.[1];
    if (!list) continue;
    points[key] = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(match => htmlText(match[1]))
      .filter(Boolean);
  }
  return points;
}
function chittorgarhObjectives(page) {
  const tables = page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  const table = tables.find(value => /<table\b[^>]*\bid=["']ObjectiveIssue["']/i.test(value));
  if (table) {
    return chittorgarhTableRows(table).slice(1)
      .filter(row => row.length >= 2 && row[1] && !/^total$/i.test(row[1]))
      .map(row => {
        const description = row[1].trim();
        const amount = chittorgarhNumber(row[2] || '');
        return amount !== null ? `${description} — ₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })} cr` : description;
      });
  }
  const index = page.search(/id=["']ipo-objectives-section["']/i);
  if (index < 0) return [];
  const contentStart = page.indexOf('>', index) + 1;
  const paragraphEnd = page.indexOf('</p>', contentStart);
  if (contentStart === 0 || paragraphEnd < 0) return [];
  const text = htmlText(page.slice(contentStart, paragraphEnd));
  return text ? [text] : [];
}
async function chittorgarhIndustry(id) {
  const url = `https://www.chittorgarh.com/report/sector-wise-ipo-list-in-india/96/all/${encodeURIComponent(id)}/`;
  const html = await chittorgarhPage(url);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const sector = htmlText(title).match(/\|\s*(.*?)\s+Sector IPO Listings/i)?.[1]?.trim();
  return sector || null;
}
function fromChittorgarhDetail(html, item) {
  const page = decodeChittorgarh(html);
  const industryId = page.match(/"ipo_industry"\s*:\s*"?(\d+)"?/i)?.[1] || '';
  const priceBand = chittorgarhPriceBand(page);
  const subscription = chittorgarhSubscription(page);
  const fin = chittorgarhFinancials(page);
  const sh = chittorgarhShareholding(page);
  const about = chittorgarhAbout(page);
  const obj = chittorgarhObjectives(page);
  const keyPoints = chittorgarhKeyPoints(page);
  const logo = chittorgarhLogo(page);
  const lotIndex = page.lastIndexOf('href":"/keyword/lot-size/');
  const lotText = lotIndex < 0 ? '' : page.slice(lotIndex, lotIndex + 700).match(/"children":"([\d,]+)\s+Shares"/)?.[1] || '';
  const issueSizeIndex = page.lastIndexOf('"title":"Total Issue Size"');
  const issueSizeArea = issueSizeIndex < 0 ? '' : page.slice(issueSizeIndex, issueSizeIndex + 900);
  const issueSizeText = issueSizeArea.match(/agg\.\s*up to\s*₹[^0-9]{0,20}([\d,]+)/i)?.[1] || '';
  const getDate = label => {
    const value = chittorgarhNearbyValue(page, label);
    const parsed = value && new Date(value);
    return parsed && Number.isFinite(parsed.getTime()) ? fmt(parsed) : '';
  };
  const getKeywordDate = keyword => {
    const index = page.toLowerCase().indexOf(keyword);
    if (index < 0) return '';
    const value = page.slice(index, index + 700)
      .match(/<\/a>\s*<\/span>\s*<span[^>]*class="text-end"[^>]*>([^<]+)<\/span>/i)?.[1];
    const parsed = value && new Date(htmlText(value));
    return parsed && Number.isFinite(parsed.getTime()) ? fmt(parsed) : '';
  };
  const getTentativeListingDate = () => {
    const index = page.toLowerCase().indexOf('/keyword/tentative-listing-date/');
    if (index < 0) return '';
    const context = htmlText(page.slice(index, index + 500));
    const value = context.match(/tentative listing date\s+(?:is\s+)?fixed as\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/i)?.[1];
    const parsed = value && new Date(value);
    return parsed && Number.isFinite(parsed.getTime()) ? fmt(parsed) : '';
  };
  const open = getDate('IPO Open Date'), close = getDate('Close date');
  const allot = getKeywordDate('/keyword/tentative-allotment/')
    || getDate('Tentative Allotment') || getDate('Allotment Date');
  const list = getTentativeListingDate()
    || getKeywordDate('/keyword/tentative-listing-date/')
    || getDate('Listing Date');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const openAt = open ? new Date(open).getTime() : NaN;
  const closeAt = close ? new Date(close).getTime() : NaN;
  const status = Number.isFinite(openAt) && now.getTime() < openAt ? 'upcoming'
    : Number.isFinite(closeAt) && now.getTime() <= closeAt ? 'open'
      : Number.isFinite(closeAt) ? 'closed' : 'upcoming';
  return {
    id: slug(item.name), n: item.name, s: status, sec: item.sec, cat: item.sec,
    lo: priceBand.lo, hi: priceBand.hi,
    lot: parseInt(lotText.replace(/,/g, ''), 10) || 0,
    size: parseFloat(issueSizeText.replace(/,/g, '')) || 0,
    open, close, allot, list, sub: subscription,
    ...(logo ? { logo, logoSource: 'Chittorgarh' } : {}),
    ...(industryId ? { industryId } : {}),
    ...(subscription ? { subscriptionSource: 'Chittorgarh', subscriptionUpdatedAt: new Date().toISOString() } : {}),
    ...(about ? { ab: about } : {}),
    ...(obj.length ? { obj } : {}),
    st: keyPoints.st,
    rk: keyPoints.rk,
    ...(keyPoints.st.length || keyPoints.rk.length ? {
      companyPointsSource: 'Chittorgarh',
      companyPointsUpdatedAt: new Date().toISOString()
    } : {}),
    fin, sh,
    ...(about || obj.length ? { companyInfoSource: 'Chittorgarh', companyInfoUpdatedAt: new Date().toISOString() } : {}),
    ...(fin.length || sh.length ? { fundamentalsSource: 'Chittorgarh', fundamentalsUpdatedAt: new Date().toISOString() } : {}),
    chittorgarhUpdatedAt: new Date().toISOString()
  };
}
async function fromChittorgarh() {
  const boards = [
    ['https://www.chittorgarh.com/ipo/ipo_dashboard.asp', 'Mainboard'],
    ['https://www.chittorgarh.com/ipo/ipo_dashboard.asp?a=sme', 'SME']
  ];
  const candidates = [];
  for (const [url, board] of boards) {
    const html = await chittorgarhPage(url);
    const links = chittorgarhLinks(html, board);
    if (!links.length) throw new Error(`${board} dashboard returned no IPO links`);
    candidates.push(...links);
  }
  const records = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = await Promise.all(candidates.slice(i, i + 3).map(async item => {
      try {
        const html = await chittorgarhPage(new URL(item.href, 'https://www.chittorgarh.com').href);
        const ipo = fromChittorgarhDetail(html, item);
        if (ipo.s === 'open' && item.sourceId) {
          try {
            const subscription = await chittorgarhLiveSubscription(item.sourceId);
            if (subscription) Object.assign(ipo, subscription);
          } catch (e) {
            console.log('Chittorgarh live subscription failed:', item.name, e.message);
          }
        }
        return ipo;
      } catch (e) {
        console.log('Chittorgarh IPO detail failed:', item.name, e.message);
        return null;
      }
    }));
    records.push(...batch.filter(Boolean));
    }
    if (!records.length) throw new Error('Chittorgarh returned no usable IPO detail pages');
    const industryIds = [...new Set(records.map(ipo => ipo.industryId).filter(Boolean))];
    const sectors = new Map();
    for (let i = 0; i < industryIds.length; i += 3) {
      await Promise.all(industryIds.slice(i, i + 3).map(async id => {
        try {
          const sector = await chittorgarhIndustry(id);
          if (sector) sectors.set(id, sector);
        } catch (e) {
          console.log('Chittorgarh IPO sector failed:', id, e.message);
        }
      }));
    }
    const sectorUpdatedAt = new Date().toISOString();
    return records.map(({ industryId, ...ipo }) => sectors.has(industryId)
      ? { ...ipo, sector: sectors.get(industryId), sectorSource: 'Chittorgarh', sectorUpdatedAt }
      : ipo);
}

// 1) AUTO SOURCE: NSE public IPO list. NSE changes field names and blocks bots at times,
//    so run once, check console.log(j[0]) and adjust the field names below if needed.
async function fromNSE() {
  const j = await nseJson('https://www.nseindia.com/api/ipo-current-issue', 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo');
  const now = Date.now();
  return nseRows(j).map(x => {
    const name = x.companyName || x.symbol || '';
    // issuePrice looks like "Rs.660 to Rs.693"
    const p = String(x.issuePrice || '').match(/\d[\d,]*\.?\d*/g) || ['0'];
    const num = v => parseFloat(String(v).replace(/,/g, '')) || 0;
    const lo = num(p[0]), hi = num(p[1] || p[0]);
    const st = String(x.status || '').trim().toLowerCase();
    const start = new Date(x.issueStartDate).getTime(), close = new Date(x.issueEndDate).getTime();
    const s = /^(open|ongoing|current)$/.test(st) ? 'open'
      : /^(upcoming|forthcoming)$/.test(st) ? 'upcoming'
        : st === 'closed' ? 'closed'
          : Number.isFinite(start) && now < start ? 'upcoming'
            : Number.isFinite(close) ? now < close + 864e5 ? 'open' : 'closed' : 'upcoming';
    const times = num(x.noOfTime);
    const board = ipoBoard(x);
    return {
      id: slug(name), n: name, s, sec: board, cat: board, lo, hi,
      lot: 1, // NSE does not send lot size: set the real one in ipos.json
      size: Math.round(num(x.issueSize) * hi / 1e7), // issueSize is a share count, so convert to crore
      gmp: 0, open: fmt(x.issueStartDate), close: fmt(x.issueEndDate),
      allot: '-', list: '-', sub: times ? [null, null, null, +times.toFixed(2)] : null,
      ab: 'Details will be added soon.', obj: [], fin: [], sh: [], st: [], rk: []
    };
  }).filter(validIpo);
}

// UPCOMING list (DRHP filed, dates and price often not announced yet).
// NSE field names may differ, so check the "Upcoming sample" line in the terminal and tell me if fields are missing.
async function fromUpcoming() {
  const j = await nseJson('https://www.nseindia.com/api/all-upcoming-issues?category=ipo', 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo');
  const arr = nseRows(j);
  if (arr[0]) console.log('Upcoming sample:', JSON.stringify(arr[0]));
  const num = v => parseFloat(String(v).replace(/,/g, '')) || 0;
  return arr.map(x => {
    const name = x.companyName || x.company || x.symbol || '';
    const p = String(x.issuePrice || '').match(/\d[\d,]*\.?\d*/g) || ['0'];
    const lo = num(p[0]), hi = num(p[1] || p[0]);
    const board = ipoBoard(x);
    return {
      id: slug(name), n: name, s: 'upcoming', sec: board, cat: board, lo, hi, lot: 1, size: 0, gmp: 0,
      open: fmt(x.issueStartDate), close: fmt(x.issueEndDate), allot: '', list: '', sub: null,
      ab: 'Details will be added soon.', obj: [], fin: [], sh: [], st: [], rk: []
    };
  }).filter(validIpo);
}

async function fromBseSme() {
  const payload = await bseJson('https://api.bseindia.com/BseIndiaAPI/api/GetPublicIssue_par_updated/w?flag=1&scrip_Name=&ir_flag=IPO&status=&exchange=');
  const rows = Array.isArray(payload) ? payload : payload?.Table || payload?.data || [];
  if (!Array.isArray(rows)) throw new Error('BSE IPO response has an unexpected format');
  return rows.filter(validRecord).filter(row => {
    const issueType = String(row.IR_FLAG_FULL || row.IR_flag || '').trim().toUpperCase();
    const platform = String(row.eXCHANGE_PLATFORM || row.Exchange_Platform || '').trim().toLowerCase();
    return issueType === 'IPO' && platform === 'sme';
  }).map(row => {
    const name = String(row.Scrip_Name || row.SCRIP_NAME || row.CompanyName || row.IssueName || '').trim();
    if (!name) return null;
    const rawStatus = String(row.Status || row.STATUS || row.IssueStatus || '').trim().toLowerCase();
    const status = ({
      l: 'open', live: 'open', open: 'open', f: 'upcoming', forthcoming: 'upcoming', upcoming: 'upcoming',
      c: 'closed', closed: 'closed', listed: 'closed'
    })[rawStatus];
    if (!status) return null;
    const priceBand = String(row.Price_Band || row.PriceBand || row.Issue_Price || '');
    const prices = priceBand.match(/\d[\d,]*\.?\d*/g) || [];
    const price = value => parseFloat(String(value).replace(/,/g, '')) || 0;
    return {
      id: slug(name), n: name, s: status, sec: 'SME', cat: 'SME',
      lo: price(prices[0]), hi: price(prices[1] || prices[0]), lot: 1, size: 0, gmp: 0,
      open: fmt(row.Start_Dt || row.StartDate || row.ISSUE_START_DATE),
      close: fmt(row.End_Dt || row.EndDate || row.ISSUE_END_DATE),
      allot: '', list: '', sub: null, ab: 'Details will be added soon.', obj: [], fin: [], sh: [], st: [], rk: []
    };
  }).filter(Boolean);
}

async function fromIpoListSme() {
  const response = await fetch('https://webnodejs.investorgain.com/cloud/v2/ipo/list-read', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/plain, */*', Referer: 'https://www.investorgain.com/' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`IPO list source failed (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload?.ipoList)) throw new Error('IPO list source returned an unexpected format');
  const rows = payload.ipoList.filter(validRecord);
  liveIpoLogos = new Map();
  for (const row of rows) {
    const name = String(row.company_short_name || '').trim();
    const filename = String(row.logo_url || '').trim();
    if (name && filename && filename !== 'noimage.png') {
      liveIpoLogos.set(ipoNameKey(name), `https://www.chittorgarh.net/images/ipo/${encodeURIComponent(filename)}`);
    }
  }
  return rows.filter(row =>
    String(row.ipo_category || row.issue_category || '').trim().toLowerCase() === 'sme'
  ).map(row => {
    const name = String(row.company_short_name || '').trim();
    if (!name) return null;
    const status = ({ u: 'upcoming', o: 'open', c: 'closed' })[String(row.ipo_status || '').trim().toLowerCase()];
    if (!status) return null;
    const sizeMatch = String(row.issue_size || '').replace(/&#8377;/g, '₹').match(/[\d,]+(?:\.\d+)?/);
    const size = sizeMatch ? parseFloat(sizeMatch[0].replace(/,/g, '')) || 0 : 0;
    return {
      id: slug(name), n: name, s: status, sec: 'SME', cat: 'SME', lo: 0, hi: 0, lot: 1,
      size, gmp: 0, open: fmt(row.issue_open_dt), close: fmt(row.issue_end_dt),
      allot: '', list: '', sub: null, ab: 'Details will be added soon.', obj: [], fin: [], sh: [], st: [], rk: []
    };
  }).filter(Boolean);
}

const ipoNameKey = name => String(name).toLowerCase()
  .replace(/\b(limited|ltd|ipo|and|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');
function mergeSmeSources(primary, supplemental) {
  const merged = new Map();
  for (const ipo of [...supplemental, ...primary]) {
    const key = ipoNameKey(ipo.n);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, ipo);
      continue;
    }
    merged.set(key, {
      ...previous,
      ...ipo,
      id: slug(ipo.n),
      size: ipo.size || previous.size,
      lo: ipo.lo || previous.lo,
      hi: ipo.hi || previous.hi,
      open: ipo.open || previous.open,
      close: ipo.close || previous.close
    });
  }
  return [...merged.values()];
}
function mergeChittorgarhSources(primary, supplemental) {
  const merged = new Map(primary.map(ipo => [ipoNameKey(ipo.n), ipo]));
  for (const ipo of supplemental) {
    const key = ipoNameKey(ipo.n);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, ipo);
      continue;
    }
    merged.set(key, {
      ...previous,
      lo: previous.lo || ipo.lo,
      hi: previous.hi || ipo.hi,
      lot: ipo.lot > 1 ? ipo.lot : previous.lot,
      size: previous.size || ipo.size,
      logo: ipo.logo || previous.logo,
      logoSource: ipo.logo ? ipo.logoSource : previous.logoSource,
      open: previous.open && previous.open !== '-' ? previous.open : ipo.open,
      close: previous.close && previous.close !== '-' ? previous.close : ipo.close,
      allot: previous.allot && previous.allot !== '-' ? previous.allot : ipo.allot,
      list: previous.list && previous.list !== '-' ? previous.list : ipo.list,
      sub: Array.isArray(ipo.sub) && ipo.sub.some(Number.isFinite) ? ipo.sub : previous.sub,
      subscriptionSource: Array.isArray(ipo.sub) && ipo.sub.some(Number.isFinite)
        ? ipo.subscriptionSource || previous.subscriptionSource : previous.subscriptionSource,
      subscriptionUpdatedAt: Array.isArray(ipo.sub) && ipo.sub.some(Number.isFinite)
        ? ipo.subscriptionUpdatedAt || previous.subscriptionUpdatedAt : previous.subscriptionUpdatedAt,
      fin: Array.isArray(ipo.fin) && ipo.fin.length ? ipo.fin : previous.fin,
      sh: Array.isArray(ipo.sh) && ipo.sh.length ? ipo.sh : previous.sh,
      ab: ipo.ab && ipo.ab !== 'Details will be added soon.' ? ipo.ab : previous.ab,
      obj: Array.isArray(ipo.obj) && ipo.obj.length ? ipo.obj : previous.obj,
      companyInfoSource: ipo.companyInfoSource || previous.companyInfoSource,
      companyInfoUpdatedAt: ipo.companyInfoUpdatedAt || previous.companyInfoUpdatedAt,
      st: ipo.companyPointsSource ? ipo.st : previous.st,
      rk: ipo.companyPointsSource ? ipo.rk : previous.rk,
      companyPointsSource: ipo.companyPointsSource || previous.companyPointsSource,
      companyPointsUpdatedAt: ipo.companyPointsUpdatedAt || previous.companyPointsUpdatedAt,
      sector: ipo.sector || previous.sector,
      sectorSource: ipo.sectorSource || previous.sectorSource,
      sectorUpdatedAt: ipo.sectorUpdatedAt || previous.sectorUpdatedAt,
      fundamentalsSource: ipo.fundamentalsSource || previous.fundamentalsSource,
      fundamentalsUpdatedAt: ipo.fundamentalsUpdatedAt || previous.fundamentalsUpdatedAt,
      chittorgarhUpdatedAt: ipo.chittorgarhUpdatedAt
    });
  }
  return [...merged.values()];
}

// Moneycontrol is the primary earnings/corporate-action source; BSE remains the fallback.
// Refreshed every 3 hours.
let corporate = [], corporateAt = 0;
const bseDateText = value => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return fmt(text);
  const month = Number(match[2]) - 1;
  return month >= 0 && month < 12 ? `${Number(match[1])} ${MON[month]} ${match[3]}` : text;
};
const MONEYCONTROL_HEADERS = {
  'User-Agent': BSE_HEADERS['User-Agent'],
  Accept: 'text/html,application/xhtml+xml'
};
async function moneycontrolPageData(page) {
  const url = new URL(page, 'https://www.moneycontrol.com');
  const response = await fetch(url, {
    headers: MONEYCONTROL_HEADERS,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Moneycontrol request failed (${response.status})`);
  const html = await response.text();
  const match = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Moneycontrol page did not contain its data payload');
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch { throw new Error('Moneycontrol returned an invalid data payload'); }
  const pageProps = payload?.props?.pageProps;
  if (!validRecord(pageProps)) throw new Error('Moneycontrol page data was unavailable');
  return pageProps;
}
function moneycontrolResultDate(value, fromDate, toDate) {
  const match = String(value || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (!match) return '';
  const day = Number(match[1]);
  const month = MON.findIndex(item => item.toLowerCase() === match[2].slice(0, 3).toLowerCase());
  const start = Date.parse(`${fromDate}T00:00:00Z`), end = Date.parse(`${toDate}T23:59:59Z`);
  if (month < 0 || !Number.isFinite(start) || !Number.isFinite(end)) return '';
  const firstYear = new Date(start).getUTCFullYear() - 1;
  const lastYear = new Date(end).getUTCFullYear() + 1;
  for (let year = firstYear; year <= lastYear; year++) {
    const time = Date.UTC(year, month, day);
    if (new Date(time).getUTCDate() !== day || time < start || time > end) continue;
    return `${day} ${MON[month]} ${year}`;
  }
  return '';
}
function moneycontrolActionDate(value) {
  const text = String(value || '').trim();
  const slashDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const namedDate = text.match(/^(\d{1,2})\s+([A-Za-z]{3,}),?\s+(\d{4})$/);
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const monthName = namedDate
    ? MON.findIndex(item => item.toLowerCase() === namedDate[2].slice(0, 3).toLowerCase())
    : -1;
  const day = slashDate ? Number(slashDate[1])
    : namedDate ? Number(namedDate[1]) : isoDate ? Number(isoDate[3]) : 0;
  const month = slashDate ? Number(slashDate[2]) - 1
    : namedDate ? monthName : isoDate ? Number(isoDate[2]) - 1 : -1;
  const year = slashDate ? Number(slashDate[3])
    : namedDate ? Number(namedDate[3]) : isoDate ? Number(isoDate[1]) : 0;
  if (!day || month < 0 || month > 11 || !year) return '';
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCDate() === day && date.getUTCMonth() === month
    ? `${day} ${MON[month]} ${year}`
    : '';
}
const moneycontrolCompanyCache = new Map();
async function moneycontrolCompanyInfo(row) {
  const stockUrl = String(row.url || '').split('#')[0];
  if (!stockUrl) return {};
  if (moneycontrolCompanyCache.has(stockUrl)) return moneycontrolCompanyCache.get(stockUrl);
  const task = (async () => {
    let symbol = '';
    let company = '';
    try {
      const response = await fetch(stockUrl, {
        headers: MONEYCONTROL_HEADERS,
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`Moneycontrol stock page failed (${response.status})`);
      const html = await response.text();
      const nseSymbol = html.match(/\bvar\s+nseId\s*=\s*["']([^"']+)["']/i)?.[1]?.trim() || '';
      const bseSymbol = html.match(/\bvar\s+bseId\s*=\s*["']([^"']+)["']/i)?.[1]?.trim() || '';
      symbol = row.ex === 'B' ? bseSymbol : nseSymbol;
      const ogTitle = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || '';
      const officialNames = [...ogTitle.matchAll(/,\s*([^,]+?)\s+Stock Price/gi)];
      if (officialNames.length > 1) company = htmlText(officialNames[officialNames.length - 1][1]);
      const screenerSymbol = nseSymbol && nseSymbol !== '-' ? nseSymbol : bseSymbol;
      if (!screenerSymbol || screenerSymbol === '-') return {
        ...(symbol && symbol !== '-' ? { symbol } : {}),
        ...(company ? { company } : {})
      };
      const logoResponse = await fetch(
        `https://www.screener.in/company/${encodeURIComponent(screenerSymbol)}/`,
        { headers: { 'User-Agent': BSE_HEADERS['User-Agent'], Accept: 'text/html' }, signal: AbortSignal.timeout(10000) }
      );
      if (!logoResponse.ok) {
        console.log('Company logo unavailable:', row.stockName || row.scId, `Screener returned ${logoResponse.status}`);
        return {
          ...(symbol && symbol !== '-' ? { symbol } : {}),
          ...(company ? { company } : {})
        };
      }
      const logoHtml = await logoResponse.text();
      const logo = logoHtml.match(/https:\/\/cdn-media\.screener\.in\/company-logos\/thumbnails\/[^"'\\\s]+/i)?.[0];
      return {
        ...(symbol && symbol !== '-' ? { symbol } : {}),
        ...(company ? { company } : {}),
        ...(logo ? { logo } : {})
      };
    } catch (e) {
      console.log('Company symbol/logo lookup failed:', row.stockName || row.scId, e.message);
      return {
        ...(symbol && symbol !== '-' ? { symbol } : {}),
        ...(company ? { company } : {})
      };
    }
  })();
  moneycontrolCompanyCache.set(stockUrl, task);
  return task;
}
async function enrichMoneycontrolActions(rows) {
  const out = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    const batch = await Promise.all(rows.slice(offset, offset + 4).map(async row => ({
      ...row,
      ...(await moneycontrolCompanyInfo(row))
    })));
    out.push(...batch);
  }
  return out;
}
async function fromMoneycontrolActions() {
  const pages = [
    { path: '/markets/corporate-action/dividends_declared/', name: 'dividends' },
    { path: '/markets/corporate-action/bonus/', name: 'bonus actions' },
    { path: '/markets/corporate-action/splits/', name: 'stock splits' },
    { path: '/markets/corporate-action/rights/', name: 'rights issues' }
  ];
  const batches = await Promise.all(pages.map(async page => {
    try {
      const payload = await moneycontrolPageData(page.path);
      const rows = payload.data?.filteredList;
      if (!Array.isArray(rows)) throw new Error('Moneycontrol returned no action list');
      return rows.flatMap(row => {
        if (!validRecord(row)) return [];
        const date = moneycontrolActionDate(row.exDate);
        const sourceCode = String(row.scId || row.scDid || '').trim();
        const company = String(row.stockName || '').trim();
        const eventType = String(row.eventType || page.name).trim();
        if (!date || !(sourceCode || company)) return [];
        const amount = String(row.dividend || '').trim();
        const ratio = String(row.ratio || '').trim();
        const value = /dividend/i.test(eventType) && amount && amount !== '-'
          ? `₹${amount} per share`
          : ratio && ratio !== '-' ? ratio : '';
        const details = [value, row.premium > 0 ? `Premium ₹${row.premium}` : ''].filter(Boolean).join(' · ');
        const actionType = /bonus/i.test(eventType) ? 'Bonus'
          : /split/i.test(eventType) ? 'Split'
            : /rights/i.test(eventType) ? 'Rights Issue'
              : /dividend/i.test(eventType) ? 'Dividend' : 'Corporate action';
        return [{
          date,
          title: `${company || sourceCode}: ${actionType}`,
          type: 'dividend',
          symbol: '',
          exchange: row.ex === 'B' ? 'BSE' : 'NSE',
          company,
          actionType,
          details: details || eventType,
          record: moneycontrolActionDate(row.recordDate || row.record_date),
          url: row.url,
          scId: sourceCode,
          source: 'Moneycontrol'
        }];
      });
    } catch (e) {
      console.log(`Moneycontrol ${page.name} source failed:`, e.message);
      return [];
    }
  }));
  return enrichMoneycontrolActions(batches.flat());
}
async function fromMoneycontrolResults() {
  const payload = await moneycontrolPageData('/markets/earnings/results-calendar/');
  const data = payload.resultCalendarData;
  const rows = data?.tableData?.list;
  if (!Array.isArray(rows)) throw new Error('Moneycontrol returned no results list');
  return rows.flatMap(row => {
    if (!validRecord(row)) return [];
    const date = moneycontrolResultDate(row.date, data.fromDate, data.toDate);
    const symbol = String(row.scId || row.stockShortName || '').trim();
    const company = String(row.stockName || '').trim();
    if (!date || !(symbol || company)) return [];
    const purpose = String(row.resultType || 'Quarterly results').trim();
    return [{
      date,
      title: `${company || symbol}: ${purpose}`,
      type: 'earnings',
      symbol,
      company,
      purpose,
      source: 'Moneycontrol'
    }];
  });
}
const bseDateParam = date => `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
const bseRows = payload => (Array.isArray(payload) ? payload : Array.isArray(payload?.Table) ? payload.Table : Array.isArray(payload?.data) ? payload.data : [])
  .filter(validRecord);
async function fromBseResults() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 40);
  const to = new Date();
  to.setHours(0, 0, 0, 0);
  to.setDate(to.getDate() + 200);
  const dateParam = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const query = new URLSearchParams({
    fromdate: dateParam(from),
    todate: dateParam(to),
    scripcode: ''
  });
  const payload = await bseJson(`https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?${query}`);
  return bseRows(payload).flatMap(row => {
    const symbol = String(row.short_name || row.Short_Name || row.scripname || '').trim();
    const company = String(row.Long_Name || row.long_name || row.company_name || symbol).trim();
    const date = bseDateText(row.meeting_date || row.Meeting_Date || row.MEETING_DATE);
    if (!date || date === '-' || !(symbol || company)) return [];
    return [{
      date,
      title: `${company || symbol}: Financial results`,
      type: 'earnings',
      symbol: symbol || String(row.scrip_Code || row.scrip_code || ''),
      company,
      purpose: 'Financial results'
    }];
  });
}
async function fromCorporate() {
  const out = [];
  try { out.push(...await fromMoneycontrolActions()); }
  catch (e) { console.log('Moneycontrol corporate actions source failed:', e.message); }
  try { out.push(...await fromMoneycontrolResults()); }
  catch (e) { console.log('Moneycontrol results source failed:', e.message); }
  try {
    out.push(...await fromBseResults());
  } catch (e) { console.log('BSE earnings source failed:', e.message); }
  try {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 200);
    const query = new URLSearchParams({
      strCat: 'Equity',
      strPrevDate: bseDateParam(from),
      strScrip: '',
      strSearch: 'P',
      strToDate: bseDateParam(to),
      strType: 'ALL',
      flag: 'csv'
    });
    const list = bseRows(await bseJson(`https://api.bseindia.com/BseIndiaAPI/api/CorpAction/w?${query}`));
    list.forEach(row => {
      const purpose = String(row.Purpose || row.purpose || row.Subject || row.subject || '').trim();
      const details = purpose
        .replace(/\bRs\.?\s*-\s*/gi, '₹')
        .replace(/\s*-\s*₹\s*/g, ' · ₹')
        .replace(/₹\s*([\d,]+(?:\.\d+)?)/g, (_, amount) => {
          const value = Number(amount.replace(/,/g, ''));
          return Number.isFinite(value)
            ? `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `₹${amount}`;
        });
      const symbol = String(row.Security || row.security || row.Symbol || row.symbol || '').trim();
      const company = String(row.Company || row.company || row.Long_Name || row.long_name || symbol).trim();
      const date = bseDateText(row.ExDate || row.exDate || row.ex_date);
      if (!purpose || !date || date === '-' || !(symbol || company)) return;
      out.push({
        date,
        title: `${company || symbol}: ${details}`,
        type: 'dividend',
        symbol: symbol || String(row.Code || row.code || ''),
        company,
        details,
        record: bseDateText(row.RecordDate || row.recordDate || row.record_date || row.recDate)
      });
    });
  } catch (e) { console.log('BSE corporate actions source failed:', e.message); }
  const unique = new Map();
  out.forEach(event => {
    if (!event.date || event.date === '-') return;
    const identity = `${event.type}|${event.date}|${slug(event.symbol || event.company)}|${actionTypeKey(event.title)}`;
    const previous = unique.get(identity);
    unique.set(identity, previous
      ? { ...event, ...previous, record: previous.record || event.record }
      : event);
  });
  return [...unique.values()];
}
const actionTypeKey = title => {
  if (/bonus/i.test(title)) return 'bonus';
  if (/split/i.test(title)) return 'split';
  if (/buy[\s-]?back/i.test(title)) return 'buyback';
  if (/rights?\s+issue/i.test(title)) return 'rights';
  if (/dividend/i.test(title)) return 'dividend';
  return 'corporate';
};

// MARKET TICKER: a few NSE indices (refreshed every minute). SENSEX is a BSE index, so it is not here.
// Check the "Index sample" line in the terminal if the ticker stays empty.
let market = [];
async function fromMarket() {
  const list = await nseGet('https://www.nseindia.com/api/allIndices');
  if (!market.length && list[0]) console.log('Index sample:', JSON.stringify(list[0]));
  const WANT = { 'NIFTY 50': 'NIFTY 50', 'NIFTY BANK': 'BANK NIFTY', 'NIFTY NEXT 50': 'NIFTY NEXT 50', 'INDIA VIX': 'INDIA VIX' };
  return list.filter(x => WANT[x.index])
    .map(x => ({ name: WANT[x.index], price: Number(x.last), change: Number(x.percentChange) }))
    .filter(m => Number.isFinite(m.price) && m.price > 0 && Number.isFinite(m.change))
    .map(m => ({ ...m, change: Number(m.change.toFixed(2)) }));
}
async function fromYahooMarket() {
  const indices = [
    { name: 'NIFTY 50', symbol: '^NSEI' },
    { name: 'BANK NIFTY', symbol: '^NSEBANK' },
    { name: 'NIFTY NEXT 50', symbol: '^NSMIDCP' },
    { name: 'INDIA VIX', symbol: '^INDIAVIX' }
  ];
  const quotes = await Promise.all(indices.map(async ({ name, symbol }) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      const payload = await response.json();
      const quote = payload?.chart?.result?.[0]?.meta;
      const price = Number(quote?.regularMarketPrice);
      const previousClose = Number(quote?.chartPreviousClose ?? quote?.previousClose);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) {
        throw new Error('returned no usable quote');
      }
      return {
        name,
        price,
        change: Number((((price - previousClose) / previousClose) * 100).toFixed(2))
      };
    } catch (e) {
      console.log(`Yahoo Finance market quote failed (${symbol}):`, e.message);
      return null;
    }
  }));
  return quotes.filter(Boolean);
}
async function refreshMarket() {
  try {
    const latest = await fromMarket();
    if (latest.length) {
      market = latest;
      return;
    }
    console.log('Market source returned no usable indices; trying Yahoo Finance');
  } catch (e) {
    console.log('Market source failed; trying Yahoo Finance:', e.message);
  }
  try {
    const latest = await fromYahooMarket();
    if (latest.length) {
      market = latest;
      console.log('Yahoo Finance market fallback available:', latest.length);
    } else {
      console.log('Yahoo Finance returned no usable indices; keeping previous data');
    }
  } catch (e) {
    console.log('Yahoo Finance market fallback failed; keeping previous data:', e.message);
  }
}

// MARKET HOLIDAYS: trading holidays published by NSE (refreshed twice a day)
// NSE may change field names, so check the "Holiday sample" line in the terminal.
let holidays = [], holidaysAt = 0;
async function fromHolidays() {
  const j = await nseJson('https://www.nseindia.com/api/holiday-master?type=trading');
  const list = j.CM || j.FO || j.CBM || [];
  if (list[0]) console.log('Holiday sample:', JSON.stringify(list[0]));
  return list.map(h => ({ date: fmt(h.tradingDate), title: h.description || 'Market holiday', type: 'holiday' }));
}

async function refresh() {
  try { autoUpcoming = await fromUpcoming(); } catch (e) { console.log('Upcoming source failed:', e.message); }
  try { autoCurrent = await fromNSE(); } catch (e) { console.log('Current IPO source failed:', e.message); }
  let bseSme = [], fallbackSme = [];
  try { bseSme = await fromBseSme(); } catch (e) { console.log('BSE SME IPO source failed:', e.message); }
  try { fallbackSme = await fromIpoListSme(); } catch (e) { console.log('SME IPO fallback source failed:', e.message); }
  autoBseSme = mergeSmeSources(bseSme, fallbackSme);
  try {
    const latest = await fromChittorgarh();
    if (latest.length) chittorgarhIpos = latest;
  } catch (e) { console.log('Chittorgarh IPO source failed; keeping previous data:', e.message); }
  auto = mergeChittorgarhSources([...autoUpcoming, ...autoCurrent, ...autoBseSme], chittorgarhIpos);
  try {
    const manual = read('ipos.json', []);
    const names = [...auto, ...(Array.isArray(manual) ? manual : [])]
      .filter(validIpo)
      .map(ipo => ipo.n);
    const latest = await fromInvestorGainGmp(names);
    for (const [key, value] of latest) {
      if (!value.h && investorGainGmp.get(key)?.h) {
        value.h = investorGainGmp.get(key).h;
        value.gmpDates = investorGainGmp.get(key).gmpDates;
      }
      if (Array.isArray(value.h) && value.h.length
        && value.h[value.h.length - 1] !== value.gmp) {
        if (!Array.isArray(value.gmpDates)) value.gmpDates = [];
        value.h.push(value.gmp);
        value.gmpDates.push(value.gmpUpdatedAt);
      }
    }
    investorGainGmp = latest;
    console.log('InvestorGain GMP and histories available:', latest.size);
  } catch (e) {
    console.log('InvestorGain GMP source failed; keeping previous data:', e.message);
  }
  console.log('Auto IPOs available:', auto.length, '(upcoming ' + autoUpcoming.length + ', current ' + autoCurrent.length + ', BSE SME ' + autoBseSme.length + ')');

  if (Date.now() - holidaysAt > 12 * 3600 * 1000) {
    try {
      const latest = await fromHolidays();
      if (latest.length) holidays = latest;
      holidaysAt = Date.now();
      console.log('Market holidays available:', holidays.length);
    }
    catch (e) { console.log('Holiday source failed:', e.message); }
  }

  if (Date.now() - corporateAt > 3 * 3600 * 1000) {
    const latest = await fromCorporate();
    if (latest.length) corporate = latest;
    corporateAt = Date.now();
    console.log('Results and corporate actions available:', corporate.length);
  }
}

// Calendar events = NSE holidays (auto) + BSE results/corporate actions + your own events.json.
// events.json example: [ { "date": "5 Dec 2026", "title": "RBI policy decision", "type": "economic" } ]
// Only keep results/dividends from 40 days ago to 200 days ahead so the page stays light
const inWindow = e => {
  const d = new Date(e.date).getTime();
  return Number.isFinite(d) && d > Date.now() - 40 * 864e5 && d < Date.now() + 200 * 864e5;
};
const buildEvents = () => {
  const manual = read('events.json', []);
  return [...holidays, ...corporate.filter(inWindow),
  ...(Array.isArray(manual) ? manual.filter(e => validRecord(e) && e.date && e.title).map(e => ({ type: 'economic', ...e })) : [])];
};

// 2) MERGE: auto list + your own ipos.json (full details win) + gmp.json (GMP is not in any official source)
// gmp.json example: { "aarav-foods-ltd": { "gmp": 42, "h": [18,22,27,31,35,39,42] } }
function build() {
  const manual = read('ipos.json', []), gmpData = read('gmp.json', {}), map = new Map();
  const gmp = validRecord(gmpData) ? gmpData : {};
  const liveNames = new Map(auto.map(i => [slug(i.id), i.n.trim()]));
  const livePrices = new Map(auto.map(i => [ipoNameKey(i.n), { lo: i.lo, hi: i.hi }]));
  const liveLogos = new Map(auto
    .filter(i => typeof i.logo === 'string' && i.logo.trim())
    .map(i => [ipoNameKey(i.n), { logo: i.logo, logoSource: i.logoSource }]));
  const liveSectors = new Map(auto
    .filter(i => typeof i.sector === 'string' && i.sector.trim())
    .map(i => [ipoNameKey(i.n), {
      sector: i.sector,
      sectorSource: i.sectorSource,
      sectorUpdatedAt: i.sectorUpdatedAt
    }]));
  const liveSubscriptions = new Map(auto
    .filter(i => Array.isArray(i.sub) && i.sub.some(Number.isFinite))
    .map(i => [ipoNameKey(i.n), {
      sub: i.sub,
      subscriptionSource: i.subscriptionSource,
      subscriptionUpdatedAt: i.subscriptionUpdatedAt
    }]));
  const liveFundamentals = new Map(auto
    .filter(i => (Array.isArray(i.fin) && i.fin.length) || (Array.isArray(i.sh) && i.sh.length))
    .map(i => [ipoNameKey(i.n), i]));
  const liveCompanyInfo = new Map(auto
    .filter(i => (typeof i.ab === 'string' && i.ab.trim() && i.ab !== 'Details will be added soon.')
      || (Array.isArray(i.obj) && i.obj.length))
    .map(i => [ipoNameKey(i.n), i]));
  const liveCompanyPoints = new Map(auto
    .filter(i => i.companyPointsSource === 'Chittorgarh')
    .map(i => [ipoNameKey(i.n), i]));
  const liveSmeNames = new Set(auto
    .filter(i => /\bsme\b/i.test(`${i.cat || ''} ${i.sec || ''}`))
    .map(i => ipoNameKey(i.n)));
  const records = [...auto, ...(Array.isArray(manual) ? manual.filter(validRecord) : [])];
  records.forEach(i => {
    const id = slug(i.id || i.n || '');
    if (!id) return;
    const key = ipoNameKey(i.n || id);
    if (!key) return;
    const previous = map.get(key) || {};
    const previousHasGmp = validRecord(gmp[previous.id]);
    const currentHasGmp = validRecord(gmp[id]);
    const preferredId = currentHasGmp && !previousHasGmp ? id : (previous.id || id);
    const name = liveNames.get(id) || (typeof i.n === 'string' && i.n.trim() ? i.n.trim() : previous.n);
    if (!name) return;
    const merged = { ...previous, ...i, id: preferredId, n: name };
    const livePrice = livePrices.get(key);
    if (livePrice?.lo > 0 && livePrice?.hi > 0) {
      merged.lo = livePrice.lo;
      merged.hi = livePrice.hi;
    }
    const liveSubscription = liveSubscriptions.get(key);
    if (liveSubscription) Object.assign(merged, liveSubscription);
    const liveSector = liveSectors.get(key);
    if (liveSector) Object.assign(merged, liveSector);
    for (const field of ['open', 'close', 'allot', 'list']) {
      if ((!merged[field] || merged[field] === '-') && previous[field]) merged[field] = previous[field];
    }
    if ((!Array.isArray(merged.sub) || !merged.sub.some(Number.isFinite))
      && Array.isArray(previous.sub) && previous.sub.some(Number.isFinite)) merged.sub = previous.sub;
    if (liveSmeNames.has(key)) merged.sec = merged.cat = 'SME';
    map.set(key, merged);
  });
  return [...map.values()].filter(i => withinIpoRetention(i)).map(i => {
    const extra = validRecord(gmp[i.id]) ? gmp[i.id] : {};
    const liveLogo = liveLogos.get(ipoNameKey(i.n));
    const logo = liveLogo?.logo || liveIpoLogos.get(ipoNameKey(i.n)) || i.logo;
    const liveGmp = investorGainGmp.get(ipoNameKey(i.n));
    const fundamentals = liveFundamentals.get(ipoNameKey(i.n));
    const companyInfo = liveCompanyInfo.get(ipoNameKey(i.n));
    const companyPoints = liveCompanyPoints.get(ipoNameKey(i.n));
    return {
      ...i,
      ...(logo ? { logo } : {}),
      ...(liveLogo ? { logoSource: liveLogo.logoSource } : {}),
      ...extra,
      ...(liveGmp || {}),
      ...(companyInfo ? {
        ...(companyInfo.ab && companyInfo.ab !== 'Details will be added soon.' ? { ab: companyInfo.ab } : {}),
        ...(companyInfo.obj?.length ? { obj: companyInfo.obj } : {}),
        companyInfoSource: companyInfo.companyInfoSource,
        companyInfoUpdatedAt: companyInfo.companyInfoUpdatedAt
      } : {}),
      ...(companyPoints ? {
        st: companyPoints.st || [],
        rk: companyPoints.rk || [],
        companyPointsSource: companyPoints.companyPointsSource,
        companyPointsUpdatedAt: companyPoints.companyPointsUpdatedAt
      } : {}),
      ...(fundamentals ? {
        ...(fundamentals.fin?.length ? { fin: fundamentals.fin } : {}),
        ...(fundamentals.sh?.length ? { sh: fundamentals.sh } : {}),
        fundamentalsSource: fundamentals.fundamentalsSource,
        fundamentalsUpdatedAt: fundamentals.fundamentalsUpdatedAt
      } : {})
    };
  });
}

// ----- SEO helpers: a different title/description for every IPO page -----
const escAttr = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ipoSeo(i, base) {
  const price = i.hi ? `price band Rs ${i.lo}-${i.hi}, ` : '';
  const dates = i.open ? `Opens ${i.open}${i.close ? ', closes ' + i.close : ''}. ` : '';
  const gmp = i.hi ? `GMP ${i.gmp >= 0 ? '+' : ''}${i.gmp}. ` : '';
  return {
    title: `${i.n} IPO GMP, Price Band, Dates & Subscription | BullishBharat`,
    desc: `${i.n} IPO: ${price}${gmp}${dates}Check subscription status, allotment and listing date.`.replace(/\s+/g, ' ').trim(),
    url: `${base}/ipo/${encodeURIComponent(i.id)}`
  };
}
function sendHtml(res, file, status, seo, head = false) {
  fs.readFile(path.join(DIR, file), 'utf8', (e, html) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    if (seo) {
      html = html
        .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escAttr(seo.title)}</title>`)
        .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escAttr(seo.desc)}">`)
        .replace('</head>', () => `  <link rel="canonical" href="${escAttr(seo.url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="BullishBharat">
  <meta property="og:title" content="${escAttr(seo.title)}">
  <meta property="og:description" content="${escAttr(seo.desc)}">
  <meta property="og:url" content="${escAttr(seo.url)}">
  <meta name="twitter:card" content="summary">
</head>`);
    }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(head ? '' : html);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }
  const head = req.method === 'HEAD';
  const end = body => res.end(head ? '' : body);
  const u = new URL(req.url, 'http://localhost').pathname;
  const sendJson = data => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    end(JSON.stringify(data));
  };
  if (u === '/api/ipos') {
    return sendJson(build());
  }
  if (u === '/api/market') {
    return sendJson(market);
  }
  if (u === '/api/events') {
    return sendJson(buildEvents());
  }
  const port = server.address()?.port || configuredPort;
  const base = (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  if (u === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  }
  if (u === '/sitemap.xml') {
    const paths = ['/', '/ipo-gmp', '/dividends-bonus', '/calendar', '/lot-calculator', '/allotment-status', '/about', '/privacy', '/disclaimer', '/contact', ...build().map(i => '/ipo/' + encodeURIComponent(i.id))];
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map(p => `  <url><loc>${escAttr(base + p)}</loc></url>`).join('\n')}\n</urlset>\n`);
  }

  // Home, info pages and every IPO page (/ipo/<id>) serve the same page. We only change the title and
  // description for Google and WhatsApp previews; the page's script draws the content.
  const home = fs.existsSync(path.join(DIR, 'bullishbharat-clean.html')) ? 'bullishbharat-clean.html' : 'bullishbharat.html';
  const INFO = { '/about': 'About', '/privacy': 'Privacy Policy', '/disclaimer': 'Disclaimer', '/contact': 'Contact' };
  const VIEWS = {
    '/ipo-gmp': { title: 'IPO GMP Tracker', desc: 'Track upcoming and open IPOs, price bands, subscription status, key dates and grey market premium.' },
    '/dividends-bonus': { title: 'Dividends & Bonus', desc: 'Track upcoming dividends, bonus issues, stock splits and other corporate actions.' },
    '/calendar': { title: 'Calendar', desc: 'See upcoming IPO dates, earnings, dividends, holidays and market events in one calendar.' },
    '/lot-calculator': { title: 'Lot Calculator', desc: 'Estimate IPO investment amount and potential profit by lot size and grey market premium.' },
    '/allotment-status': { title: 'Allotment status', desc: 'Find IPO registrar links to check your IPO allotment status.' }
  };
  if (VIEWS[u]) {
    const page = VIEWS[u];
    return sendHtml(res, home, 200, {
      title: `${page.title} | BullishBharat`,
      desc: page.desc,
      url: base + u
    }, head);
  }
  const ipoMatch = u.match(/^\/ipo\/([^/]+)$/);
  if (ipoMatch) {
    let id;
    try { id = decodeURIComponent(ipoMatch[1]); }
    catch { res.writeHead(400); return res.end('Bad request'); }
    const ipo = build().find(i => i.id === id);
    return sendHtml(res, home, ipo ? 200 : 404, ipo && ipoSeo(ipo, base), head);
  }
  if (INFO[u]) return sendHtml(res, home, 200, { title: `${INFO[u]} | BullishBharat`, desc: `${INFO[u]} - BullishBharat, live IPO and GMP hub for the Indian market.`, url: base + u }, head);
  if (u === '/') return sendHtml(res, home, 200, null, head);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  end('Not found');
});

const configuredPort = Number(process.env.PORT || 3000);
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
function listen(port, retries = 10) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && retries > 0 && port < 65535) {
      console.warn(`Port ${port} is in use; trying ${port + 1}`);
      return listen(port + 1, retries - 1);
    }
    console.error('Could not start server:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, () => {
    const address = server.address();
    console.log('BullishBharat running on http://localhost:' + address.port);
  });
}
listen(configuredPort);

refresh(); setInterval(refresh, EVERY);
refreshMarket(); setInterval(refreshMarket, 60 * 1000);