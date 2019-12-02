const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SourceMapConsumer } = require('source-map');
const { computeFileSizeMapOptimized } = require('./lib.js');

const mode = process.argv[2];
const dir = 'data/' + process.argv[3];
const urlAndNames = process.argv.slice(4).map(nameAndUrl => {
  const split = nameAndUrl.split('=', 2);
  return { name: split[0], url: split[1] };
});
// assume all urls have same origin.
const origin = new URL(urlAndNames[0].url).origin;

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 100);
}

function sameOrigin(url) {
  return new URL(url).origin === origin;
}

async function main() {
  if (mode === 'collect') {
    fs.mkdirSync(dir, { recursive: true });

    for (const { url } of urlAndNames) {
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
    for (const { url } of urlAndNames) {
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

      console.log('______', data.scriptUrl, data.content.length);
      const consumer = await new SourceMapConsumer(data.map);
      const files = computeFileSizeMapOptimized({ consumer, content: data.content }).files;
      const sortedFiles = Object.entries(files).sort((a, b) => b[1] - a[1]);
      const largest = sortedFiles.slice(0, 5);
      const rest = sortedFiles.slice(5);
      for (const [file, size] of largest) {
        console.log(file, size);
      }
      if (rest.length) {
        console.log(`${rest.length} more ...`);
      }
    }

    console.log('====== javascript size and pages')
    const table = {};

    function trimSameOrigin(url) {
      if (sameOrigin(url)) {
        const url_ = new URL(url);
        return url_.pathname + url_.search;
      } else {
        return url;
      }
    }

    for (const data of Object.values(scriptData).sort((a, b) => b.content.length - a.content.length)) {
      if (!sameOrigin(data.scriptUrl)) continue;

      table[trimSameOrigin(data.scriptUrl)] = {
        'size (KB)': Math.round(data.content.length / 1024),
        pages: data.seen.map(url => urlAndNames.find(un => un.url === url).name).sort().join(', '),
      };
    }
    console.table(table);
  }
}

main();
