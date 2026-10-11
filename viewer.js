import init, { HwpDocument } from './rhwp.js';
import {
  buildCanonicalIndex,
  canonicalizeQuery,
  findCanonicalMatches,
} from './search_index.js';

const statusElement = document.getElementById('status');
const pagesElement = document.getElementById('pages');
const pageIndicatorElement = document.getElementById('page-indicator');
const fastScrollerElement = document.getElementById('fast-scroller');
const fastScrollThumbElement = document.getElementById('fast-scroll-thumb');
const startScreenElement = document.getElementById('start-screen');
const startOpenButton = document.getElementById('start-open-button');
const startMessageElement = document.getElementById('start-message');
const documentInput = document.getElementById('document-input');
const viewerToolbar = document.getElementById('viewer-toolbar');
const documentToolbar = document.getElementById('document-toolbar');
const documentTitleElement = document.getElementById('document-title');
const openAnotherButton = document.getElementById('open-another-button');
const openSearchButton = document.getElementById('open-search-button');
const searchToolbar = document.getElementById('search-toolbar');
const searchInput = document.getElementById('search-input');
const searchResultElement = document.getElementById('search-result');
const previousMatchButton = document.getElementById('previous-match-button');
const nextMatchButton = document.getElementById('next-match-button');
const closeSearchButton = document.getElementById('close-search-button');
const renderProgressElement = document.getElementById('render-progress');
const consoleErrors = [];
let currentDocument = null;
let svgTextIndexes = [];
let searchMatches = [];
let currentSearchMatchIndex = -1;
let highlightElementsByMatch = [];
let activeHighlightMatchIndex = -1;
let documentReady = false;
let pagePriorityObserver = null;
let pageTrackingObserver = null;
let prioritizePageWindow = null;
let currentPageIndex = -1;
let totalPageCount = 0;
let fastScrollDragging = false;
let pendingFastScrollPage = null;
let fastScrollAnimationFrame = null;
let engineReady = false;
let reportedSearchState = 'cleared';
let reportedTotalMatches = 0;
let reportedCurrentMatch = 0;

const svgNamespace = 'http://www.w3.org/2000/svg';
const normalHighlight = { fill: '#ffeb3b', opacity: '0.42' };
const activeHighlight = { fill: '#ff9800', opacity: '0.68' };
const initialPageBatchSize = 3;
const backgroundPageBatchSize = 4;
const fastScrollerPageThreshold = 30;

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function setStartMessage(message, isError = false) {
  startMessageElement.textContent = message;
  startMessageElement.classList.toggle('error', isError);
}

function updateSearchResultLabel() {
  const query = searchInput.value.trim();
  if (!query) {
    searchResultElement.textContent = '';
  } else if (reportedSearchState === 'notReady') {
    searchResultElement.textContent = '검색 준비 중...';
  } else if (reportedTotalMatches === 0) {
    searchResultElement.textContent = '0건';
  } else {
    const pageLabel = currentPageIndex >= 0 && totalPageCount > 0
      ? ` · ${currentPageIndex + 1}/${totalPageCount}쪽`
      : '';
    searchResultElement.textContent = `${reportedCurrentMatch} / `
      + `${reportedTotalMatches}${pageLabel}`;
  }

  const hasMatches = reportedTotalMatches > 0;
  previousMatchButton.disabled = !hasMatches;
  nextMatchButton.disabled = !hasMatches;
}

function handleViewerMessage(message) {
  switch (message.type) {
    case 'ready':
      engineReady = true;
      startOpenButton.disabled = false;
      startOpenButton.textContent = 'HWP/HWPX 파일 열기';
      setStartMessage('뷰어가 준비되었습니다.');
      break;
    case 'progress': {
      const state = message.state || 'rendering';
      if (state === 'ready') {
        renderProgressElement.hidden = true;
      } else {
        renderProgressElement.hidden = false;
        if (message.totalPages > 0) {
          renderProgressElement.max = message.totalPages;
          renderProgressElement.value = message.renderedPages || 0;
        } else {
          renderProgressElement.removeAttribute('value');
        }
      }
      break;
    }
    case 'pageChanged':
      updateSearchResultLabel();
      break;
    case 'rendered':
      documentReady = true;
      openAnotherButton.disabled = false;
      openSearchButton.disabled = false;
      renderProgressElement.hidden = true;
      if (searchInput.value.trim()) {
        globalThis.search(searchInput.value);
      }
      break;
    case 'searchResult':
      reportedSearchState = message.state || 'ready';
      reportedTotalMatches = message.totalMatches || 0;
      reportedCurrentMatch = message.currentMatch || 0;
      updateSearchResultLabel();
      break;
    case 'pageError':
      showStatus(message.message || '페이지 렌더링 오류', true);
      break;
    case 'error':
      documentReady = false;
      openAnotherButton.disabled = false;
      openSearchButton.disabled = true;
      renderProgressElement.hidden = true;
      if (!startScreenElement.hidden) {
        setStartMessage(message.message || '렌더링 엔진 오류', true);
      }
      break;
    case 'diagnostics':
      originalConsoleLog('[rhwp diagnostics]', message);
      break;
    default:
      break;
  }
}

function post(type, details = {}) {
  handleViewerMessage({ type, ...details });
}

function consoleText(values) {
  return values.map((value) => {
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }).join(' ');
}

console.log = (...values) => {
  originalConsoleLog(...values);
  post('console', { level: 'log', message: consoleText(values) });
};

console.error = (...values) => {
  const message = consoleText(values);
  consoleErrors.push(message);
  originalConsoleError(...values);
  post('console', { level: 'error', message });
};

function showStatus(message, isError = false) {
  statusElement.hidden = false;
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
}

function describeError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function reportRenderingError(error) {
  const message = `렌더링 오류: ${describeError(error)}`;
  showStatus(message, true);
  post('error', { message, browserConsoleErrors: [...consoleErrors] });
}

function resetSearchUi() {
  searchInput.value = '';
  reportedSearchState = 'cleared';
  reportedTotalMatches = 0;
  reportedCurrentMatch = 0;
  searchResultElement.textContent = '';
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  searchToolbar.hidden = true;
  documentToolbar.hidden = false;
  globalThis.clearSearch?.();
}

function showDocumentUi(fileName) {
  startScreenElement.hidden = true;
  viewerToolbar.hidden = false;
  documentTitleElement.textContent = fileName;
  openAnotherButton.disabled = true;
  openSearchButton.disabled = true;
  resetSearchUi();
  globalThis.scrollTo({ top: 0, behavior: 'auto' });
}

function showFileSelectionError(message) {
  if (!startScreenElement.hidden) {
    setStartMessage(message, true);
  } else {
    showStatus(message, true);
  }
}

function openFilePicker() {
  if (!engineReady) {
    return;
  }
  documentInput.click();
}

async function openSelectedFile(file) {
  const extensionIndex = file.name.lastIndexOf('.');
  const extension = extensionIndex >= 0
    ? file.name.slice(extensionIndex).toLowerCase()
    : '';
  if (extension !== '.hwp' && extension !== '.hwpx') {
    showFileSelectionError('HWP 또는 HWPX 파일만 열 수 있습니다.');
    return;
  }

  showDocumentUi(file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await globalThis.loadRhwpDocumentBytes(bytes, file.name);
  } catch (error) {
    reportRenderingError(error);
  }
}

startOpenButton.addEventListener('click', openFilePicker);
openAnotherButton.addEventListener('click', openFilePicker);
documentInput.addEventListener('change', () => {
  const file = documentInput.files?.[0];
  documentInput.value = '';
  if (file) {
    void openSelectedFile(file);
  }
});

openSearchButton.addEventListener('click', () => {
  documentToolbar.hidden = true;
  searchToolbar.hidden = false;
  searchInput.focus();
});

closeSearchButton.addEventListener('click', resetSearchUi);
searchInput.addEventListener('input', () => {
  const query = searchInput.value;
  reportedTotalMatches = 0;
  reportedCurrentMatch = 0;
  if (!query.trim()) {
    globalThis.clearSearch();
    return;
  }
  if (!documentReady) {
    reportedSearchState = 'notReady';
    updateSearchResultLabel();
    return;
  }
  globalThis.search(query);
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    resetSearchUi();
  } else if (event.key === 'Enter' && reportedTotalMatches > 0) {
    event.preventDefault();
    globalThis.nextMatch();
  }
});
previousMatchButton.addEventListener('click', () => globalThis.previousMatch());
nextMatchButton.addEventListener('click', () => globalThis.nextMatch());

if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  globalThis.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .catch((error) => originalConsoleError(
        'Service worker registration failed:',
        error,
      ));
  });
}

function normalizedText() {
  return pagesElement.textContent.replace(/\s+/gu, '');
}

function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function createPagePlaceholders(pageCount) {
  const fragment = document.createDocumentFragment();
  const pages = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.createElement('section');
    page.id = `page-${pageIndex}`;
    page.className = 'page placeholder';
    page.dataset.pageIndex = String(pageIndex);
    page.setAttribute('aria-label', `${pageIndex + 1}페이지`);
    page.setAttribute('aria-busy', 'true');

    const placeholderLabel = document.createElement('span');
    placeholderLabel.className = 'placeholder-label';
    placeholderLabel.textContent = `${pageIndex + 1}페이지 준비 중...`;
    page.append(placeholderLabel);
    fragment.append(page);
    pages.push(page);
  }
  pagesElement.append(fragment);
  return pages;
}

function reportRenderProgress(state, renderedPages, totalPages) {
  if (state === 'ready') {
    statusElement.hidden = true;
  } else if (renderedPages === 0) {
    showStatus(`페이지를 불러오는 중... ${renderedPages} / ${totalPages}`);
  } else {
    showStatus(`${renderedPages} / ${totalPages} 페이지 준비 중`);
  }
  post('progress', { state, renderedPages, totalPages });
}

function updatePageNavigationUi() {
  if (currentPageIndex < 0 || totalPageCount <= 0) {
    pageIndicatorElement.hidden = true;
    fastScrollerElement.hidden = true;
    return;
  }

  const pageLabel = `${currentPageIndex + 1} / ${totalPageCount}`;
  pageIndicatorElement.textContent = pageLabel;
  pageIndicatorElement.hidden = false;

  const showFastScroller = totalPageCount >= fastScrollerPageThreshold;
  fastScrollerElement.hidden = !showFastScroller;
  if (!showFastScroller) {
    return;
  }

  const ratio = totalPageCount === 1
    ? 0
    : currentPageIndex / (totalPageCount - 1);
  const thumbTravel = Math.max(
    0,
    fastScrollerElement.clientHeight - fastScrollThumbElement.offsetHeight,
  );
  fastScrollThumbElement.style.transform = `translateY(${ratio * thumbTravel}px)`;
}

function setCurrentPage(pageIndex) {
  if (totalPageCount <= 0) {
    return;
  }
  const nextPageIndex = Math.max(
    0,
    Math.min(totalPageCount - 1, pageIndex),
  );
  if (nextPageIndex === currentPageIndex) {
    updatePageNavigationUi();
    return;
  }

  currentPageIndex = nextPageIndex;
  updatePageNavigationUi();
  post('pageChanged', {
    pageIndex: currentPageIndex,
    pageNumber: currentPageIndex + 1,
    totalPages: totalPageCount,
  });
}

function resetPageNavigation(pageCount) {
  pageTrackingObserver?.disconnect();
  pageTrackingObserver = null;
  currentPageIndex = pageCount > 0 ? 0 : -1;
  totalPageCount = pageCount;
  fastScrollDragging = false;
  pendingFastScrollPage = null;
  if (fastScrollAnimationFrame != null) {
    cancelAnimationFrame(fastScrollAnimationFrame);
    fastScrollAnimationFrame = null;
  }
  fastScrollerElement.classList.remove('dragging');
  document.body.classList.remove('fast-scrolling');
  updatePageNavigationUi();

  if (pageCount > 0) {
    post('pageChanged', {
      pageIndex: 0,
      pageNumber: 1,
      totalPages: pageCount,
    });
  }
}

function startPageTracking(pages) {
  const visiblePages = new Map();
  const thresholds = Array.from({ length: 11 }, (_, index) => index / 10);
  pageTrackingObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageIndex = Number(entry.target.dataset.pageIndex);
      if (!Number.isInteger(pageIndex)) {
        continue;
      }
      if (!entry.isIntersecting) {
        visiblePages.delete(pageIndex);
        continue;
      }
      visiblePages.set(pageIndex, {
        visibleArea: entry.intersectionRect.width * entry.intersectionRect.height,
        centerDistance: Math.abs(
          entry.boundingClientRect.top
            + entry.boundingClientRect.height / 2
            - globalThis.innerHeight / 2,
        ),
      });
    }

    if (fastScrollDragging) {
      return;
    }
    let bestPageIndex = -1;
    let bestVisibility = null;
    for (const [pageIndex, visibility] of visiblePages) {
      if (!bestVisibility
          || visibility.visibleArea > bestVisibility.visibleArea
          || (visibility.visibleArea === bestVisibility.visibleArea
            && visibility.centerDistance < bestVisibility.centerDistance)) {
        bestPageIndex = pageIndex;
        bestVisibility = visibility;
      }
    }
    if (bestPageIndex >= 0) {
      setCurrentPage(bestPageIndex);
    }
  }, { threshold: thresholds });

  for (const page of pages) {
    pageTrackingObserver.observe(page);
  }
}

function scrollToPage(pageIndex) {
  const page = pagesElement.children[pageIndex];
  if (!page) {
    return;
  }
  setCurrentPage(pageIndex);
  prioritizePageWindow?.(pageIndex);
  page.scrollIntoView({ behavior: 'auto', block: 'start' });
}

function scheduleFastScroll(clientY) {
  const bounds = fastScrollerElement.getBoundingClientRect();
  const ratio = Math.max(
    0,
    Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height)),
  );
  pendingFastScrollPage = Math.round(ratio * (totalPageCount - 1));
  if (fastScrollAnimationFrame != null) {
    return;
  }
  fastScrollAnimationFrame = requestAnimationFrame(() => {
    fastScrollAnimationFrame = null;
    if (pendingFastScrollPage != null) {
      scrollToPage(pendingFastScrollPage);
    }
  });
}

function beginFastScroll(event) {
  if (fastScrollerElement.hidden || totalPageCount <= 0) {
    return;
  }
  event.preventDefault();
  fastScrollDragging = true;
  fastScrollerElement.classList.add('dragging');
  document.body.classList.add('fast-scrolling');
  fastScrollerElement.setPointerCapture(event.pointerId);
  scheduleFastScroll(event.clientY);
}

function moveFastScroll(event) {
  if (!fastScrollDragging) {
    return;
  }
  event.preventDefault();
  scheduleFastScroll(event.clientY);
}

function endFastScroll(event) {
  if (!fastScrollDragging) {
    return;
  }
  event.preventDefault();
  fastScrollDragging = false;
  fastScrollerElement.classList.remove('dragging');
  document.body.classList.remove('fast-scrolling');
  if (fastScrollerElement.hasPointerCapture(event.pointerId)) {
    fastScrollerElement.releasePointerCapture(event.pointerId);
  }
}

fastScrollerElement.addEventListener('pointerdown', beginFastScroll);
fastScrollerElement.addEventListener('pointermove', moveFastScroll);
fastScrollerElement.addEventListener('pointerup', endFastScroll);
fastScrollerElement.addEventListener('pointercancel', endFastScroll);
globalThis.addEventListener('resize', updatePageNavigationUi);

function isVisibleSvgText(element) {
  if (element.closest(
    'defs, style, clipPath, metadata, symbol, mask, pattern, '
      + '[data-rhwp-search-highlight]',
  )) {
    return false;
  }

  for (let current = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) {
      return false;
    }
    const style = getComputedStyle(current);
    if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || Number(style.opacity) === 0) {
      return false;
    }
    if (current.tagName.toLowerCase() === 'svg') {
      break;
    }
  }
  return true;
}

function buildSvgTextIndex(page, pageIndex) {
  const sourceCharacters = [];
  for (const element of page.querySelectorAll('svg text')) {
    if (!isVisibleSvgText(element)) {
      continue;
    }
    let localIndex = 0;
    for (const char of Array.from(element.textContent || '')) {
      sourceCharacters.push({
        char,
        element,
        localIndex,
        pageIndex,
      });
      localIndex += 1;
    }
  }

  return {
    pageIndex,
    sourceCharacters,
    ...buildCanonicalIndex(sourceCharacters),
  };
}

function textRangesForMatch(match) {
  const index = svgTextIndexes[match.pageIndex];
  if (!index) {
    return [];
  }

  const sourceCharacters = [];
  const seenSources = new Set();
  for (let offset = match.startOffset; offset < match.endOffset; offset += 1) {
    for (const source of index.characters[offset]?.sources || []) {
      if (!seenSources.has(source)) {
        seenSources.add(source);
        sourceCharacters.push(source);
      }
    }
  }

  const ranges = [];
  let currentRange = null;
  for (const source of sourceCharacters) {
    if (currentRange
        && currentRange.element === source.element
        && source.localIndex <= currentRange.end + 1) {
      currentRange.end = Math.max(
        currentRange.end,
        source.localIndex,
      );
      continue;
    }
    currentRange = {
      element: source.element,
      start: source.localIndex,
      end: source.localIndex,
    };
    ranges.push(currentRange);
  }
  return ranges;
}

function rectangleGeometryForRange(range) {
  const rectangles = [];
  for (let characterIndex = range.start;
    characterIndex <= range.end;
    characterIndex += 1) {
    let extent;
    try {
      extent = range.element.getExtentOfChar(characterIndex);
    } catch (_) {
      continue;
    }
    if (![extent.x, extent.y, extent.width, extent.height]
      .every(Number.isFinite)) {
      continue;
    }

    const characterRectangle = {
      x: extent.x,
      y: extent.y,
      right: extent.x + extent.width,
      bottom: extent.y + extent.height,
      height: extent.height,
    };
    const previous = rectangles[rectangles.length - 1];
    const lineTolerance = Math.max(
      1,
      Math.min(previous?.height || extent.height, extent.height) * 0.35,
    );
    const isSameLine = previous
      && Math.abs(previous.y - characterRectangle.y) <= lineTolerance
      && characterRectangle.x >= previous.x - lineTolerance;
    if (isSameLine) {
      previous.x = Math.min(previous.x, characterRectangle.x);
      previous.y = Math.min(previous.y, characterRectangle.y);
      previous.right = Math.max(previous.right, characterRectangle.right);
      previous.bottom = Math.max(previous.bottom, characterRectangle.bottom);
      previous.height = previous.bottom - previous.y;
    } else {
      rectangles.push(characterRectangle);
    }
  }
  return rectangles;
}

function createHighlightElements(range, matchIndex) {
  const parent = range.element.parentNode;
  if (!parent) {
    return [];
  }

  const group = document.createElementNS(svgNamespace, 'g');
  group.setAttribute('data-rhwp-search-highlight', String(matchIndex));
  group.setAttribute('aria-hidden', 'true');
  group.setAttribute('pointer-events', 'none');
  const transform = range.element.getAttribute('transform');
  if (transform) {
    group.setAttribute('transform', transform);
  }

  const rectangles = [];
  for (const geometry of rectangleGeometryForRange(range)) {
    const padding = Math.max(0.5, geometry.height * 0.06);
    const rectangle = document.createElementNS(svgNamespace, 'rect');
    rectangle.setAttribute('x', String(geometry.x - padding));
    rectangle.setAttribute('y', String(geometry.y - padding));
    rectangle.setAttribute(
      'width',
      String(Math.max(1, geometry.right - geometry.x + padding * 2)),
    );
    rectangle.setAttribute(
      'height',
      String(Math.max(1, geometry.bottom - geometry.y + padding * 2)),
    );
    rectangle.setAttribute('rx', String(padding));
    group.append(rectangle);
    rectangles.push(rectangle);
  }

  if (rectangles.length === 0) {
    return [];
  }
  parent.insertBefore(group, range.element);
  return rectangles;
}

function applyHighlightStyle(elements, isActive) {
  const style = isActive ? activeHighlight : normalHighlight;
  for (const element of elements) {
    element.setAttribute('fill', style.fill);
    element.setAttribute('fill-opacity', style.opacity);
  }
}

function removeSearchHighlights() {
  for (const element of pagesElement.querySelectorAll(
    '[data-rhwp-search-highlight]',
  )) {
    element.remove();
  }
  highlightElementsByMatch = [];
  activeHighlightMatchIndex = -1;
}

function renderSearchHighlights() {
  removeSearchHighlights();
  highlightElementsByMatch = searchMatches.map((match, matchIndex) => {
    const elements = textRangesForMatch(match)
      .flatMap((range) => createHighlightElements(range, matchIndex));
    applyHighlightStyle(elements, false);
    return elements;
  });
}

function updateActiveHighlight() {
  if (activeHighlightMatchIndex >= 0) {
    applyHighlightStyle(
      highlightElementsByMatch[activeHighlightMatchIndex] || [],
      false,
    );
  }
  applyHighlightStyle(
    highlightElementsByMatch[currentSearchMatchIndex] || [],
    true,
  );
  activeHighlightMatchIndex = currentSearchMatchIndex;
}

function emitSearchResult(state = 'ready') {
  const match = currentSearchMatchIndex >= 0
    ? searchMatches[currentSearchMatchIndex]
    : null;
  post('searchResult', {
    state,
    totalMatches: searchMatches.length,
    currentMatch: match ? currentSearchMatchIndex + 1 : 0,
    pageIndex: match?.pageIndex ?? null,
    occurrenceIndexOnPage: match?.occurrenceIndexOnPage ?? null,
  });
}

function navigateToCurrentMatch() {
  if (currentSearchMatchIndex < 0) {
    updateActiveHighlight();
    emitSearchResult();
    return;
  }

  const match = searchMatches[currentSearchMatchIndex];
  setCurrentPage(match.pageIndex);
  updateActiveHighlight();
  const scrollTarget = highlightElementsByMatch[currentSearchMatchIndex]?.[0]
    || pagesElement.children[match.pageIndex];
  scrollTarget?.scrollIntoView({
    behavior: 'smooth',
    block: highlightElementsByMatch[currentSearchMatchIndex]?.length > 0
      ? 'center'
      : 'start',
    inline: 'nearest',
  });
  emitSearchResult();
}

globalThis.search = (query) => {
  if (!documentReady) {
    emitSearchResult('notReady');
    return;
  }

  const canonicalQuery = canonicalizeQuery(query);
  if (!canonicalQuery) {
    globalThis.clearSearch();
    return;
  }

  searchMatches = [];
  svgTextIndexes.forEach((visualIndex, pageNumber) => {
    findCanonicalMatches(visualIndex.text, canonicalQuery)
      .forEach((match, occurrenceIndexOnPage) => {
        searchMatches.push({
          pageIndex: pageNumber,
          occurrenceIndexOnPage,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
        });
      });
  });

  currentSearchMatchIndex = searchMatches.length > 0 ? 0 : -1;
  renderSearchHighlights();
  navigateToCurrentMatch();
};

globalThis.nextMatch = () => {
  if (searchMatches.length === 0) {
    emitSearchResult();
    return;
  }
  currentSearchMatchIndex =
    (currentSearchMatchIndex + 1) % searchMatches.length;
  navigateToCurrentMatch();
};

globalThis.previousMatch = () => {
  if (searchMatches.length === 0) {
    emitSearchResult();
    return;
  }
  currentSearchMatchIndex =
    (currentSearchMatchIndex - 1 + searchMatches.length) % searchMatches.length;
  navigateToCurrentMatch();
};

globalThis.clearSearch = () => {
  removeSearchHighlights();
  searchMatches = [];
  currentSearchMatchIndex = -1;
  emitSearchResult('cleared');
};

function targetDiagnostics(targetText) {
  const textNodes = [...pagesElement.querySelectorAll('text, tspan')];
  const targetNode = textNodes.find((node) =>
    (node.textContent || '').includes('연결하'),
  );
  const style = targetNode ? getComputedStyle(targetNode) : null;
  const font = style?.font || [
    style?.fontStyle || 'normal',
    style?.fontWeight || '400',
    style?.fontSize || '16px',
    style?.fontFamily || 'sans-serif',
  ].join(' ');
  const context = document.createElement('canvas').getContext('2d');
  context.font = font;

  const allSvg = [...pagesElement.querySelectorAll('svg')]
    .map((svg) => svg.outerHTML)
    .join('\n');
  const matchIndex = Math.max(
    allSvg.indexOf(targetText),
    allSvg.indexOf('대한민국'),
    allSvg.indexOf('연결하'),
  );
  const snippetStart = Math.max(0, matchIndex - 500);

  return {
    targetText,
    svgSnippet: matchIndex >= 0
      ? allSvg.slice(snippetStart, matchIndex + 1000)
      : 'Target text was not found in generated SVG markup.',
    canvasMeasurements: {
      full: context.measureText(targetText).width,
      withoutFinalDa: context.measureText(targetText.slice(0, -1)).width,
    },
    computedFontFamily: style?.fontFamily || null,
    computedFont: font,
    browserConsoleErrors: [...consoleErrors],
  };
}

globalThis.addEventListener('error', (event) => {
  reportRenderingError(event.error || event.message);
});

globalThis.addEventListener('unhandledrejection', (event) => {
  reportRenderingError(event.reason);
});

globalThis.measureTextWidth = (font, text) => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
};

globalThis.loadRhwpDocumentBytes = async (inputBytes, fileName) => {
  const loadStartedAt = performance.now();
  showStatus('문서를 준비하는 중...');
  post('progress', {
    state: 'preparing',
    renderedPages: 0,
    totalPages: 0,
  });
  removeSearchHighlights();
  pagePriorityObserver?.disconnect();
  pagePriorityObserver = null;
  prioritizePageWindow = null;
  resetPageNavigation(0);
  pagesElement.replaceChildren();
  documentReady = false;
  svgTextIndexes = [];
  searchMatches = [];
  currentSearchMatchIndex = -1;

  try {
    const bytes = inputBytes instanceof Uint8Array
      ? inputBytes
      : new Uint8Array(inputBytes);
    currentDocument?.free();
    currentDocument = new HwpDocument(bytes);
    console.log(
      `[timing] document parse completed: `
        + `${(performance.now() - loadStartedAt).toFixed(1)} ms`,
    );

    const pageCount = currentDocument.pageCount();
    const pages = createPagePlaceholders(pageCount);
    resetPageNavigation(pageCount);
    startPageTracking(pages);
    svgTextIndexes = new Array(pageCount);
    const completedPages = new Set();
    const priorityPages = [];
    const queuedPriorityPages = new Set();
    let completedPageCount = 0;
    let nextSequentialPage = initialPageBatchSize;

    const enqueuePriorityWindow = (targetPageIndex) => {
      for (let pageIndex = Math.max(0, targetPageIndex - 1);
        pageIndex <= Math.min(pageCount - 1, targetPageIndex + 1);
        pageIndex += 1) {
        if (!completedPages.has(pageIndex)
            && !queuedPriorityPages.has(pageIndex)) {
          priorityPages.push(pageIndex);
          queuedPriorityPages.add(pageIndex);
        }
      }
    };
    prioritizePageWindow = enqueuePriorityWindow;

    if (typeof IntersectionObserver === 'function') {
      pagePriorityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const pageIndex = Number(entry.target.dataset.pageIndex);
          if (Number.isInteger(pageIndex)) {
            enqueuePriorityWindow(pageIndex);
          }
        }
      }, { rootMargin: '100% 0px' });
      for (const page of pages) {
        pagePriorityObserver.observe(page);
      }
    }

    const renderPage = (pageIndex) => {
      if (completedPages.has(pageIndex)) {
        return;
      }

      const page = pages[pageIndex];
      try {
        page.innerHTML = currentDocument.renderPageSvg(pageIndex);
        page.classList.remove('placeholder');
        page.classList.add('rendered');
        page.removeAttribute('aria-busy');
        svgTextIndexes[pageIndex] = buildSvgTextIndex(page, pageIndex);
      } catch (error) {
        const message = `${pageIndex + 1}페이지 렌더링 오류: `
          + describeError(error);
        page.classList.remove('placeholder');
        page.classList.add('page-error');
        page.removeAttribute('aria-busy');
        page.textContent = message;
        svgTextIndexes[pageIndex] = {
          pageIndex,
          sourceCharacters: [],
          ...buildCanonicalIndex([]),
        };
        console.error(message);
        post('pageError', { pageIndex, message });
      } finally {
        completedPages.add(pageIndex);
        completedPageCount += 1;
        queuedPriorityPages.delete(pageIndex);
        pagePriorityObserver?.unobserve(page);
        reportRenderProgress(
          completedPageCount === pageCount ? 'ready' : 'rendering',
          completedPageCount,
          pageCount,
        );
      }
    };

    const takeNextPage = () => {
      while (priorityPages.length > 0) {
        const pageIndex = priorityPages.shift();
        queuedPriorityPages.delete(pageIndex);
        if (!completedPages.has(pageIndex)) {
          return pageIndex;
        }
      }
      while (nextSequentialPage < pageCount) {
        const pageIndex = nextSequentialPage;
        nextSequentialPage += 1;
        if (!completedPages.has(pageIndex)) {
          return pageIndex;
        }
      }
      return null;
    };

    reportRenderProgress('rendering', 0, pageCount);

    const initialPageCount = Math.min(initialPageBatchSize, pageCount);
    if (initialPageCount > 0) {
      renderPage(0);
      console.log(
        `[timing] first page rendered: `
          + `${(performance.now() - loadStartedAt).toFixed(1)} ms`,
      );
      await yieldToBrowser();

      for (let pageIndex = 1; pageIndex < initialPageCount; pageIndex += 1) {
        renderPage(pageIndex);
      }
      if (initialPageCount === initialPageBatchSize) {
        console.log(
          `[timing] first 3 pages rendered: `
            + `${(performance.now() - loadStartedAt).toFixed(1)} ms`,
        );
      }
      await yieldToBrowser();
    }

    while (completedPageCount < pageCount) {
      for (let batchIndex = 0;
        batchIndex < backgroundPageBatchSize;
        batchIndex += 1) {
        const pageIndex = takeNextPage();
        if (pageIndex == null) {
          break;
        }
        renderPage(pageIndex);
      }
      await yieldToBrowser();
    }

    pagePriorityObserver?.disconnect();
    pagePriorityObserver = null;
    if (pageCount === 0) {
      reportRenderProgress('ready', 0, 0);
    }
    console.log(
      `[timing] all pages rendered: `
        + `${(performance.now() - loadStartedAt).toFixed(1)} ms`,
    );

    const text = normalizedText();
    const regressionTarget = '대한민국AI산업을연결하다';
    const regressionComplete = text.includes(regressionTarget);
    const result = {
      fileName,
      pageCount,
      regressionComplete,
      researchComplete: text.includes('연구'),
      assignmentComplete: text.includes('과제'),
      researchAssignmentComplete: text.includes('연구과제'),
    };

    documentReady = true;

    if (fileName.toLowerCase() === 'regression.hwpx' && !regressionComplete) {
      const diagnostics = targetDiagnostics('대한민국 AI 산업을 연결하다');
      globalThis.rhwpDiagnostics = diagnostics;
      post('diagnostics', diagnostics);
    }

    post('rendered', result);
  } catch (error) {
    reportRenderingError(error);
  }
};

try {
  await init({ module_or_path: './rhwp_bg.wasm' });
  showStatus('렌더링 엔진 준비 완료');
  post('ready', { coreVersion: '0.8.7' });
} catch (error) {
  reportRenderingError(error);
}
