const yargs = require('yargs');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SourceMapConsumer } = require('source-map');
const { computeFileSizeMapOptimized, getDuplicates, getUnused } = require('./lib.js');

const flags = yargs
  .array('pages')
  .string('dir')
  .string('filter-page')
  .string('filter-script')
  .string('config-path')
  // .string('mode')
  .argv;

let options = {
  mode: 'collect', // remove?
};

if (flags.pages) {
  options.pages = flags.pages.map(page => {
    const split = page.split('=', 2);
    return { name: split[0], url: split[1] };
  });
}

if (flags.dir) {
  options.dir = flags.dir;
}

if (flags.configPath) {
  options = {
    ...require(path.resolve(flags.configPath)),
    ...options,
  };
}

options.pages = options.pages || [];
options.pages = options.pages.filter(page => filterPage(page.name));

// assume all urls have same origin.
const origin = new URL(options.pages[0].url).origin;

function filterPage(pageName) {
  if (!flags.filterPage) return true;
  const regex = new RegExp(flags.filterPage);
  return regex.test(pageName);
}

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 100);
}

function sum(arr) {
  return arr.reduce((acc, cur) => acc + cur, 0);
}

function sameOrigin(url) {
  return new URL(url).origin === origin;
}

function trimSameOrigin(url) {
  if (sameOrigin(url)) {
    const url_ = new URL(url);
    return url_.pathname + url_.search;
  } else {
    return url;
  }
}

function bytesToKB(bytes) {
  return Math.round(bytes / 1000);
}

function printTable(table, options = {}) {
  const { keyProp = 'key', sumProp, limit = 100 } = options;

  table = table.filter(Boolean);

  const obj = {};
  const showRows = table.slice(0, limit || table.length);
  for (const row of showRows) {
    const key = row[keyProp];
    const rest = { ...row };
    delete rest[keyProp];
    obj[key] = rest;
  }
  if (limit < table.length) {
    const restRows = table.slice(limit);
    const restRow = {};
    if (sumProp) restRow[sumProp] = restRows.reduce((acc, cur) => acc + cur[sumProp], 0);
    obj[`${restRows.length} more ...`] = restRow;
  }
  console.table(obj);
  console.log();
}

async function runLighthouse(page) {
  const dir = 'data/' + (options.dir || 'default');
  const urlSanitized = sanitize(`${page.name}-${page.url}`);
  const outputFolder = `${dir}/${urlSanitized}`;
  page.dir = outputFolder;
  if (fs.existsSync(outputFolder)) return;
  console.log('collect', page.url);

  const args = [
    __dirname + '/../lighthouse/lighthouse-cli',
    page.url,
    '-GA=' + `${outputFolder}/artifacts`,
    '--output=json',
    '--output=html',
    '--output-path=' + outputFolder + '/lh', // LH doesn't let you just specify a folder ...
  ];

  let chrome;
  if (page.userDataDir) {
    // Can't just do this b/c LH will delete the profile.
    // See https://github.com/GoogleChrome/lighthouse/issues/8957
    // args.push(`--chrome-flags=--user-data-dir=${dir}/${page.userDataDir}`);

    // So we launch chrome ourselves and pass a port.
    const chromeLauncher = require('chrome-launcher');
    chrome = await chromeLauncher.launch({userDataDir: `${dir}/${page.userDataDir}`});
    args.push(`--port=${chrome.port}`);
    // Don't delete the logged in state.
    // Note, this means a warm load will be tested.
    args.push('--disable-storage-reset');
  }

  let browser;
  if (page.puppeteerScript) {
    const puppeteer = require('puppeteer');
    const script = require(path.resolve(page.puppeteerScript));
    const PORT = 8041;
    browser = await puppeteer.launch({
      args: [`--remote-debugging-port=${PORT}`],
      headless: false,
      defaultViewport: null,
    });
    await script(browser);
    args.push(`--port=${PORT}`);
  }

  try {
    execFileSync('node', args);
  } finally {
    if (browser) await browser.close();
    if (chrome) await chrome.kill();
  }
}

async function main() {
  const dir = 'data/' + (options.dir || 'default');
  const pages = options.pages;

  if (options.mode === 'collect') {
    fs.mkdirSync(dir, { recursive: true });

    for (const page of pages) {
      await runLighthouse(page);
    }

    const scriptData = {};
    for (const { name, dir } of pages) {
      const artifacts = require(path.resolve(dir, 'artifacts', 'artifacts.json'));
      // const lhr = require(path.resolve(dir, 'lh.report.json'));

      for (const ScriptElement of artifacts.ScriptElements) {
        if (!ScriptElement.src) continue;
        if (!scriptData[ScriptElement.src]) {
          scriptData[ScriptElement.src] = {
            scriptUrl: ScriptElement.src,
            content: ScriptElement.content || '',
            seen: [],
            coverage: [],
          };
        }
        scriptData[ScriptElement.src].seen.push(name);
      }

      for (const SourceMap of artifacts.SourceMaps) {
        if (!SourceMap.scriptUrl) continue;
        scriptData[SourceMap.scriptUrl].sourceMapUrl = SourceMap.sourceMapUrl;
        scriptData[SourceMap.scriptUrl].map = SourceMap.map;
      }

      for (const JsUsage of artifacts.JsUsage) {
        if (!JsUsage.url || !scriptData[JsUsage.url]) continue;
        scriptData[JsUsage.url].coverage.push(JsUsage.functions);
      }
    }

    if (flags.filterScript) {
      const pattern = new RegExp(flags.filterScript, 'i');
      for (const key of Object.keys(scriptData)) {
        if (!pattern.test(key)) delete scriptData[key];
      }
    }

    const jsOutFolder = `${dir}/js`;
    const js3pOutFolder = `${dir}/js-3p`;
    fs.mkdirSync(jsOutFolder, { recursive: true });
    fs.mkdirSync(js3pOutFolder, { recursive: true });

    for (const [scriptUrl, data] of Object.entries(scriptData)) {
      const outFolder = sameOrigin(scriptUrl) ? jsOutFolder : js3pOutFolder;
      fs.writeFileSync(`${outFolder}/${sanitize(scriptUrl)}.js`, data.content);
      if (data.sourceMapUrl) {
        fs.writeFileSync(`${outFolder}/${sanitize(data.sourceMapUrl)}.js.map`, JSON.stringify(data.map, null, 2));
      }
    }

    console.log('====== bundles');
    for (const data of Object.values(scriptData).sort((a, b) => b.content.length - a.content.length)) {
      if (!data.map) continue;

      console.log('______', data.scriptUrl, bytesToKB(data.content.length), 'KB');
      console.log('Pages:', data.seen.sort().join(', '));
      const consumer = await new SourceMapConsumer(data.map);
      const files = computeFileSizeMapOptimized({ consumer, content: data.content }).files;
      const sortedFiles = Object.entries(files).sort((a, b) => b[1] - a[1]);
      printTable(
        sortedFiles.map(([file, size]) => {
          return {
            key: file,
            'size (KB)': bytesToKB(size),
          };
        }),
        { sumProp: 'size (KB)', limit: 5 }
      );
    }

    const scriptsSize1p = sum(Object.values(scriptData).filter(d => sameOrigin(d.scriptUrl)).map(d => d.content.length));
    const scriptsSizeAll = sum(Object.values(scriptData).map(d => d.content.length));
    console.log('====== javascript size and pages', '1st party:', bytesToKB(scriptsSize1p), 'KB,', 'all:', bytesToKB(scriptsSizeAll), 'KB')

    printTable(
      Object.values(scriptData).sort((a, b) => b.content.length - a.content.length).map((data) => {
        if (!sameOrigin(data.scriptUrl)) return;

        return {
          key: trimSameOrigin(data.scriptUrl).slice(0, 100),
          'size (KB)': bytesToKB(data.content.length),
          pages: data.seen.sort().join(', '),
        };
      })
    );

    const groupTable = [];

    const pageGroups = [
      options.pages.map(page => page.name),
      ...(options.journeys || []).map(journey => journey.split(',')),
      ...options.pages.map(page => [page.name]),
    ].map(group => group.filter(filterPage).sort());

    const seenGroup = new Set();
    for (let pagesInGroup of pageGroups) {
      if (seenGroup.has(pagesInGroup.join(','))) continue;
      seenGroup.add(pagesInGroup.join(','));

      const relevantScriptData = Object.values(scriptData)
        .filter(data => data.seen.some(name => pagesInGroup.includes(name)));

      const sizes = {
        firstParty: 0,
        thirdParty: 0,
        all: 0,
        duplicated: 0,
      };

      for (const data of relevantScriptData) {
        const size = data.content.length;

        sizes.all += size;
        if (sameOrigin(data.scriptUrl)) sizes.firstParty += size;
        else sizes.thirdParty += size;
      }

      const duplicateResults = await getDuplicates(relevantScriptData);
      sizes.duplicated = duplicateResults.wastedBytes;

      groupTable.push({
        key: pagesInGroup.join(', '),
        '1p size (KB)': bytesToKB(sizes.firstParty),
        '3p size (KB)': bytesToKB(sizes.thirdParty),
        'all size (KB)': bytesToKB(sizes.all),
        'duplicated size (KB)': bytesToKB(sizes.duplicated),
      });
    }

    printTable(groupTable);

    const duplicateResults = await getDuplicates(scriptData);
    console.log('===== bundle duplication', bytesToKB(duplicateResults.wastedBytes), 'KB');
    printTable(
      duplicateResults.items.map(item => {
        if (item.source === 'Other') return; // TODO remove threshold so no Other.
        return {
          key: item.source,
          'duplicated (KB)': bytesToKB(item.wastedBytes),
          occurrence: item.urls.length,
        };
      }),
      { sumProp: 'duplicated (KB)', limit: 15 }
    );

    // const unusedResults = await getUnused(scriptData);
    // console.log(unusedResults);
  }
}

main();
