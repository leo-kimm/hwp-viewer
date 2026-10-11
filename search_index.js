const whitespacePattern = /\s/u;
const invisibleFormatPattern = /\p{Cf}/u;

export function isIgnoredSearchCharacter(character) {
  return whitespacePattern.test(character)
    || invisibleFormatPattern.test(character);
}

function uniqueSources(sources) {
  const unique = [];
  const seen = new Set();
  for (const source of sources) {
    if (!seen.has(source)) {
      seen.add(source);
      unique.push(source);
    }
  }
  return unique;
}

function canonicalizeWithSegmenter(sourceCharacters) {
  let sourceText = '';
  const sourceByCodeUnit = [];
  for (const source of sourceCharacters) {
    if (isIgnoredSearchCharacter(source.char)) {
      continue;
    }
    sourceText += source.char;
    for (let index = 0; index < source.char.length; index += 1) {
      sourceByCodeUnit.push(source);
    }
  }

  let text = '';
  const characters = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const segment of segmenter.segment(sourceText)) {
    const canonicalSegment = segment.segment.normalize('NFC').toLowerCase();
    const sources = uniqueSources(sourceByCodeUnit.slice(
      segment.index,
      segment.index + segment.segment.length,
    ));
    text += canonicalSegment;
    for (let index = 0; index < canonicalSegment.length; index += 1) {
      characters.push({ char: canonicalSegment[index], sources });
    }
  }
  return { text, characters };
}

function canonicalizeWithoutSegmenter(sourceCharacters) {
  let sourceText = '';
  let text = '';
  const characters = [];

  for (const source of sourceCharacters) {
    if (isIgnoredSearchCharacter(source.char)) {
      continue;
    }
    sourceText += source.char;
    const nextText = sourceText.normalize('NFC').toLowerCase();
    let commonPrefixLength = 0;
    while (commonPrefixLength < text.length
      && commonPrefixLength < nextText.length
      && text[commonPrefixLength] === nextText[commonPrefixLength]) {
      commonPrefixLength += 1;
    }

    const replacedSources = characters
      .splice(commonPrefixLength)
      .flatMap((character) => character.sources);
    const sources = uniqueSources([...replacedSources, source]);
    for (let index = commonPrefixLength; index < nextText.length; index += 1) {
      characters.push({ char: nextText[index], sources });
    }
    text = nextText;
  }
  return { text, characters };
}

export function buildCanonicalIndex(sourceCharacters) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return canonicalizeWithSegmenter(sourceCharacters);
  }
  return canonicalizeWithoutSegmenter(sourceCharacters);
}

export function canonicalizeQuery(query) {
  const sourceCharacters = Array.from(String(query), (char) => ({ char }));
  return buildCanonicalIndex(sourceCharacters).text;
}

export function findCanonicalMatches(text, query) {
  if (!query) {
    return [];
  }

  const matches = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - query.length) {
    const startOffset = text.indexOf(query, searchFrom);
    if (startOffset === -1) {
      break;
    }
    matches.push({
      startOffset,
      endOffset: startOffset + query.length,
    });
    searchFrom = startOffset + query.length;
  }
  return matches;
}
