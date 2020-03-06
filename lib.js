// TODO: use master lighthouse
// currently relies on origin/js-analysis-all branch being checked out
// in ../lighthouse

const assert = require('assert');
const UnusedJavascript = require('../lighthouse/lighthouse-core/audits/byte-efficiency/unused-javascript.js');

// Lifted from source-map-explorer.
/** Calculate the number of bytes contributed by each source file */
function computeFileSizeMapOptimized(sourceMapData) {
  const { consumer, content } = sourceMapData;
  const lines = content.split('\n');
  /** @type {Record<string, number>} */
  const files = {};
  let mappedBytes = 0;

  consumer.computeColumnSpans();

  consumer.eachMapping(({ source, generatedLine, generatedColumn, lastGeneratedColumn }) => {
    if (!source) return;

    // Lines are 1-based
    const line = lines[generatedLine - 1];
    if (line === null) {
      // throw new AppError({
      //   code: 'InvalidMappingLine',
      //   generatedLine: generatedLine,
      //   maxLine: lines.length,
      // });
    }

    // Columns are 0-based
    if (generatedColumn >= line.length) {
      // throw new AppError({
      //   code: 'InvalidMappingColumn',
      //   generatedLine: generatedLine,
      //   generatedColumn: generatedColumn,
      //   maxColumn: line.length,
      // });
      return;
    }

    let mappingLength = 0;
    if (lastGeneratedColumn !== null) {
      if (lastGeneratedColumn >= line.length) {
        // throw new AppError({
        //   code: 'InvalidMappingColumn',
        //   generatedLine: generatedLine,
        //   generatedColumn: lastGeneratedColumn,
        //   maxColumn: line.length,
        // });
        return;
      }
      mappingLength = lastGeneratedColumn - generatedColumn + 1;
    } else {
      mappingLength = line.length - generatedColumn;
    }
    files[source] = (files[source] || 0) + mappingLength;
    mappedBytes += mappingLength;
  });

  // Don't count newlines as original version didn't count newlines
  const totalBytes = content.length - lines.length + 1;

  return {
    files,
    unmappedBytes: totalBytes - mappedBytes,
    totalBytes,
  };
}

async function getDuplicates(scriptData) {
  const Audit = require('../lighthouse/lighthouse-core/audits/byte-efficiency/bundle-duplication.js');
  const makeDevtoolsLog = require('../lighthouse/lighthouse-core/test/network-records-to-devtools-log.js');
  const datas = Object.values(scriptData).filter(data => data.map);

  const SourceMaps = datas.map(data => {
    return {
      scriptUrl: data.scriptUrl,
      map: data.map,
    };
  });
  const ScriptElements = datas.map(data => {
    return {
      src: data.scriptUrl,
      content: data.content,
    };
  });
  const networkRecords = datas.map(data => {
    return {
      url: data.scriptUrl,
      content: data.content,
    };
  });

  const context = { computedCache: new Map() };
  const artifacts = {
    devtoolsLogs: { defaultPass: makeDevtoolsLog(networkRecords) },
    SourceMaps,
    ScriptElements,
  };
  const results = await Audit.audit_(artifacts, networkRecords, context);
  results.items.sort((a, b) => b.wastedBytes - a.wastedBytes);
  return {
    ...results,
    wastedBytes: results.items.reduce((acc, cur) => acc + cur.wastedBytes, 0),
  };
}

/**
 * @param {any[]} scriptCoverages
 */
function combineScriptCoverages(url, scriptCoverages) {
  if (scriptCoverages.length === 0) return { url, functions: [] };

  const computedWastes = scriptCoverages.map(UnusedJavascript.computeWaste);
  const length = computedWastes[0].contentLength;
  for (const computedWaste of computedWastes) {
    assert(computedWaste.contentLength === length);
  }

  const ranges = [];
  for (let i = 0; i < length; i++) {
    const currentRange = ranges.length > 0 && ranges[ranges.length - 1];
    const count = computedWastes.some(w => w.unusedByIndex[i] === 1) ? 1 : 0;
    if (currentRange && currentRange.count === count) {
      currentRange.endOffset += 1;
    } else {
      ranges.push({
        startOffset: i,
        endOffset: i + 1,
        count,
      });
    }
  }

  return {
    url,
    functions: [{ ranges }],
  };
}

// function combineJsUsages(JsUsages) {
//   debugger;
//   const byUrl = new Map();
//   for (const JsUsage of JsUsages) {
//     for (const scriptCoverage of JsUsage) {
//       const scriptCoverages = byUrl.get(scriptCoverage.url) || [];
//       scriptCoverages.push(scriptCoverage);
//       byUrl.set(scriptCoverage.url, scriptCoverages);
//     }
//   }

//   return [...byUrl.entires()].map(([url, scriptCoverages]) => {
//     return combineScriptCoverages(url, scriptCoverages);
//   });
// }

async function getUnused(scriptData) {
  const makeDevtoolsLog = require('../lighthouse/lighthouse-core/test/network-records-to-devtools-log.js');
  const datas = Object.values(scriptData).filter(data => data.map);

  const SourceMaps = datas.map(data => {
    return {
      scriptUrl: data.scriptUrl,
      map: data.map,
    };
  });
  const ScriptElements = datas.map(data => {
    return {
      src: data.scriptUrl,
      content: data.content,
    };
  });
  const JsUsage = Object.values(scriptData)
    .map(data => combineScriptCoverages(data.scriptUrl, data.scriptCoverages));
  const networkRecords = datas.map(data => {
    return {
      url: data.scriptUrl,
      content: data.content,
    };
  });

  const context = { computedCache: new Map() };
  const artifacts = {
    devtoolsLogs: { defaultPass: makeDevtoolsLog(networkRecords) },
    SourceMaps,
    ScriptElements,
    JsUsage,
  };
  const results = await UnusedJavascript.audit_(artifacts, networkRecords, context);
  results.items.sort((a, b) => b.wastedBytes - a.wastedBytes);
  return {
    ...results,
    wastedBytes: results.items.reduce((acc, cur) => acc + cur.wastedBytes, 0),
  };
}

module.exports = {
  computeFileSizeMapOptimized,
  getDuplicates,
  getUnused,
};
