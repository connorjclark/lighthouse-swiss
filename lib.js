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

module.exports.computeFileSizeMapOptimized = computeFileSizeMapOptimized;
