const A = require('arcsecond');
const B = require('arcsecond-binary');
const C = require('construct-js');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.join(__dirname, './test.wav'));

const riffChunkSize = B.u32LE.chain(size => {
  if (size !== file.length - 8) {
    return A.fail(`Invalid file size: ${file.length}. Expected ${size}`);
  }
  return A.succeedWith(size);
});

const riffChunk = A.sequenceOf([
  A.str('RIFF'),
  riffChunkSize,
  A.str('WAVE')
]);

const fmtSubChunk = A.coroutine(function* () {
  const id = yield A.str('fmt ');
  const subChunk1Size = yield B.u32LE;
  const audioFormat = yield B.u16LE;
  const numChannels = yield B.u16LE;
  const sampleRate = yield B.u32LE;
  const byteRate = yield B.u32LE;
  const blockAlign = yield B.u16LE;
  const bitsPerSample = yield B.u16LE;

  const expectedByteRate = sampleRate * numChannels * bitsPerSample / 8;
  if (byteRate !== expectedByteRate) {
    yield A.fail(`Invalid byte rate: ${byteRate}, expected ${expectedByteRate}`);
  }

  const expectedBlockAlign = numChannels * bitsPerSample / 8;
  if (blockAlign !== expectedBlockAlign) {
    yield A.fail(`Invalid block align: ${blockAlign}, expected ${expectedBlockAlign}`);
  }

  const fmtChunkData = {
    id,
    subChunk1Size,
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample
  };

  yield A.setData(fmtChunkData);
  return fmtChunkData;
});

const dataSubChunk = A.coroutine(function* () {
  const id = yield A.str('data');
  const size = yield B.u32LE;

  const fmtData = yield A.getData;

  const samples = size / fmtData.numChannels / (fmtData.bitsPerSample / 8);
  const channelData = Array.from({length: fmtData.numChannels}, () => []);

  let sampleParser;
  if (fmtData.bitsPerSample === 8) {
    sampleParser = B.s8;
  } else if (fmtData.bitsPerSample === 16) {
    sampleParser = B.s16LE;
  } else if (fmtData.bitsPerSample === 32) {
    sampleParser = B.s32LE;
  } else {
    yield A.fail(`Unsupported bits per sample: ${fmtData.bitsPerSample}`);
  }

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
    for (let i = 0; i < fmtData.numChannels; i++) {
      const sampleValue = yield sampleParser;
      channelData[i].push(sampleValue);
    }
  }

  return {
    id,
    size,
    channelData
  };
});

const parser = A.sequenceOf([
  riffChunk,
  fmtSubChunk,
  dataSubChunk,
  A.endOfInput
]).map(([riffChunk, fmtSubChunk, dataSubChunk]) => ({
  riffChunk,
  fmtSubChunk,
  dataSubChunk
}));

const output = parser.run(file.buffer);
if (output.isError) {
  throw new Error(output.error);
}

const riffChunkStruct = C.Struct('riffChunk')
  .field('magic', C.RawString('RIFF'))
  .field('size', C.U32LE(0))
  .field('fmtName', C.RawString('WAVE'));

const fmtSubChunkStruct = C.Struct('fmtSubChunk')
  .field('id', C.RawString('fmt '))
  .field('subChunk1Size', C.U32LE(0))
  .field('audioFormat', C.U16LE(1))
  .field('numChannels', C.U16LE(1))
  .field('sampleRate', C.U32LE(44100))
  .field('byteRate', C.U32LE(44100 * 2))
  .field('blockAlign', C.U16LE(2))
  .field('bitsPerSample', C.U16LE(16));
const totalSubChunkSize = fmtSubChunkStruct.computeBufferSize();
fmtSubChunkStruct.get('subChunk1Size').set(totalSubChunkSize - 8);

const dataSubChunkStruct = C.Struct('dataSubChunk')
  .field('id', C.RawString('data'))
  .field('size', C.U32LE(0))
  .field('data', C.S16LEs([0]));

const soundData = [];
let isUp = true;
for (let i = 0; i < 44100; i++) {
  if (i % 100 === 0) {
    isUp = !isUp;
  }
  const sampleValue = isUp ? 16383 : -16383;
  soundData[i] = sampleValue;
}
dataSubChunkStruct.get('data').set(soundData);
dataSubChunkStruct.get('size').set(soundData.length * 2);

const fileStruct = C.Struct('waveFile')
  .field('riffChunk', riffChunkStruct)
  .field('fmtSubChunk', fmtSubChunkStruct)
  .field('dataSubChunk', dataSubChunkStruct);

fs.writeFileSync(path.join(__dirname, './new.wav'), fileStruct.toBuffer());
