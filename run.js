const yargs = require('yargs');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SourceMapConsumer } = require('source-map');
const { computeFileSizeMapOptimized, getDuplicates } = require('./lib.js');

const flags = yargs
  .array('pages')
  .string('dir')
  .string('config-path')
  // .string('mode')
  .argv;

let options = {
  mode: 'collect', // remove?
};

if (flags.pages) {
  options.pages = flags.pages.map(page => {
    const split = page.split('=', 2);
    return {name: split[0], url: split[1]};
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

// assume all urls have same origin.
const origin = new URL(options.pages[0].url).origin;

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 100);
}

function sum(arr) {
  return arr.reduce((acc, cur) => acc + cur);
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

  const obj = {};
  const showRows = table.slice(0, limit || table.length);
  for (const row of showRows) {
    if (!row) continue;
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

async function main() {
  const dir = 'data/' + (options.dir || 'default');
  const pages = options.pages;

  if (options.mode === 'collect') {
    fs.mkdirSync(dir, { recursive: true });

    for (const { url } of pages) {
      const urlSanitized = sanitize(url);
      const outputFolder = `${dir}/${urlSanitized}`;
      if (fs.existsSync(outputFolder)) continue;
      console.log('collect', url);

      execFileSync('node', [
        __dirname + '/../lighthouse/lighthouse-cli',
        url,
        '-GA=' + `${outputFolder}/artifacts`,
        '--output=json',
        '--output=html',
        '--output-path=' + outputFolder + '/lh', // LH doesn't let you juut specify a folder ...
      ]);
    }

    const scriptData = {};
    for (const { url } of pages) {
      const urlSanitized = sanitize(url);
      const outputFolder = `${dir}/${urlSanitized}`;
      const artifacts = require(path.resolve(outputFolder, 'artifacts', 'artifacts.json'));
      // const lhr = require(path.resolve(outputFolder, 'lh.report.json'));

      for (const ScriptElement of artifacts.ScriptElements) {
        if (!ScriptElement.src) continue;
        if (!scriptData[ScriptElement.src]) {
          scriptData[ScriptElement.src] = {
            scriptUrl: ScriptElement.src,
            content: ScriptElement.content || '',
            seen: [],
          };
        }

        scriptData[ScriptElement.src].seen.push(url);
      }
      for (const SourceMap of artifacts.SourceMaps) {
        if (!SourceMap.scriptUrl) continue;
        scriptData[SourceMap.scriptUrl].sourceMapUrl = SourceMap.sourceMapUrl;
        scriptData[SourceMap.scriptUrl].map = SourceMap.map;
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
      console.log('Pages:', data.seen.map(url => pages.find(un => un.url === url).name).sort().join(', '));
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
          pages: data.seen.map(url => pages.find(un => un.url === url).name).sort().join(', '),
        };
      })
    );

    const duplicateResults = await getDuplicates(scriptData);
    console.log('===== bundle duplication', bytesToKB(duplicateResults.wastedBytes), 'KB');
    printTable(
      duplicateResults.items.map(item => {
        return {
          key: item.source,
          'duplicated (KB)': bytesToKB(item.wastedBytes),
          occurrence: item.multi.wastedBytes.length,
        };
      }),
      { sumProp: 'duplicated (KB)', limit: 15 }
    );
  }
}

main();
