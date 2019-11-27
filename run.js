const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const mode = process.argv[2];
const dir = 'data/' + process.argv[3];
const urls = process.argv.slice(4);

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 100);
}

function sameOrigin(url1, url2) {
  return new URL(url1).origin === new URL(url2).origin;
}

if (mode === 'collect') {
  fs.mkdirSync(dir, {recursive: true});
  
  for (const url of urls) {
    const urlSanitized = sanitize(url);
    const outputFolder = `${dir}/${urlSanitized}`;
    if (fs.existsSync(outputFolder)) continue;
    console.log('collect', url);
    
    execFileSync('node', [
      '/Users/Connor/code/lighthouse/lighthouse-cli',
      url,
      '-GA=' + `${outputFolder}/artifacts`,
      '--output=json',
      '--output=html',
      '--output-path=' + outputFolder + '/lh', // LH doesn't let you juut specify a folder ...
    ]);
  }

  const scriptData = {};
  for (const url of urls) {
    console.log('===========', url);
    
    const urlSanitized = sanitize(url);
    const outputFolder = `${dir}/${urlSanitized}`;
    const artifacts = require(path.resolve(outputFolder, 'artifacts', 'artifacts.json'));
    const lhr = require(path.resolve(outputFolder, 'lh.report.json'));

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
  fs.mkdirSync(jsOutFolder, {recursive: true});
  fs.mkdirSync(js3pOutFolder, {recursive: true});
  
  for (const [scriptUrl, data] of Object.entries(scriptData)) {
    const outFolder = sameOrigin(scriptUrl, urls[0]) ? jsOutFolder : js3pOutFolder;
    fs.writeFileSync(`${outFolder}/${sanitize(scriptUrl)}.js`, data.content);
    if (data.sourceMapUrl) {
      fs.writeFileSync(`${outFolder}/${sanitize(data.sourceMapUrl)}.js.map`, JSON.stringify(data.map, null, 2));
    }

    if (sameOrigin(scriptUrl, urls[0])) console.dir(scriptUrl);
  }

  console.log('====== all')
  const datas = Object.values(scriptData).sort((a, b) => b.content.length - a.content.length);
  for (const data of datas) {
    if (!sameOrigin(data.scriptUrl, urls[0])) continue;

    console.log(Math.round(data.content.length / 1024), data.scriptUrl, ...data.seen);
  }
}
