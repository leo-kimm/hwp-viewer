import init, { HwpDocument } from './rhwp.js';
import {
  buildCanonicalIndex,
  canonicalizeQuery,
  findCanonicalMatches,
} from './search_index.js';
import {
  clearRecentDocuments,
  deleteRecentDocument,
  getRecentDocument,
  initRecentDocuments,
  listRecentDocuments,
  saveRecentDocument,
  updateRecentPage,
} from './recent_documents.js';

const statusElement = document.getElementById('status');
const pagesElement = document.getElementById('pages');
const pageIndicatorElement = document.getElementById('page-indicator');
const fastScrollerElement = document.getElementById('fast-scroller');
const fastScrollThumbElement = document.getElementById('fast-scroll-thumb');
const startScreenElement = document.getElementById('start-screen');
const startOpenButton = document.getElementById('start-open-button');
const emptyOpenButton = document.getElementById('empty-open-button');
const startMessageElement = document.getElementById('start-message');
const recentListElement = document.getElementById('recent-list');
const recentEmptyStateElement = document.getElementById('recent-empty-state');
const clearRecentsButton = document.getElementById('clear-recents-button');
const recentErrorElement = document.getElementById('recent-error');
const recentErrorMessageElement = document.getElementById('recent-error-message');
const deleteCorruptRecentButton = document.getElementById(
  'delete-corrupt-recent-button',
);
const documentInput = document.getElementById('document-input');
const viewerToolbar = document.getElementById('viewer-toolbar');
const documentToolbar = document.getElementById('document-toolbar');
const documentTitleElement = document.getElementById('document-title');
const homeButton = document.getElementById('home-button');
const openAnotherButton = document.getElementById('open-another-button');
const openSearchButton = document.getElementById('open-search-button');
const searchToolbar = document.getElementById('search-toolbar');
const searchInput = document.getElementById('search-input');
const searchResultElement = document.getElementById('search-result');
const previousMatchButton = document.getElementById('previous-match-button');
const nextMatchButton = document.getElementById('next-match-button');
const closeSearchButton = document.getElementById('close-search-button');
const renderProgressElement = document.getElementById('render-progress');
const recentActionSheet = document.getElementById('recent-action-sheet');
const actionDocumentBadge = document.getElementById('action-document-badge');
const actionDocumentName = document.getElementById('action-document-name');
const actionDocumentMeta = document.getElementById('action-document-meta');
const actionDocumentDetails = document.getElementById('action-document-details');
const actionOpenButton = document.getElementById('action-open-button');
const actionInfoButton = document.getElementById('action-info-button');
const actionDeleteButton = document.getElementById('action-delete-button');
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmCancelButton = document.getElementById('confirm-cancel-button');
const confirmAcceptButton = document.getElementById('confirm-accept-button');
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
let activeRecentDocumentId = null;
let activeRecentPageSaveTimer = null;
let selectedRecentDocumentId = null;
let selectedRecentDocument = null;
let corruptRecentDocumentId = null;
let pendingConfirmation = null;
let activeLoadGeneration = 0;

const svgNamespace = 'http://www.w3.org/2000/svg';
const normalHighlight = { fill: '#ffeb3b', opacity: '0.42' };
const activeHighlight = { fill: '#ff9800', opacity: '0.68' };
const initialPageBatchSize = 3;
const backgroundPageBatchSize = 4;
const fastScrollerPageThreshold = 30;
const recentPageSaveDelay = 750;

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function setStartMessage(message, isError = false) {
  startMessageElement.textContent = message;
  startMessageElement.classList.toggle('error', isError);
}

function formatFileSize(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatOpenedAt(openedAt) {
  const elapsed = Math.max(0, Date.now() - Number(openedAt));
  if (elapsed < 60_000) {
    return '방금 전';
  }
  if (elapsed < 60 * 60_000) {
    return `${Math.floor(elapsed / 60_000)}분 전`;
  }
  if (elapsed < 24 * 60 * 60_000) {
    return `${Math.floor(elapsed / (60 * 60_000))}시간 전`;
  }
  if (elapsed < 7 * 24 * 60 * 60_000) {
    return `${Math.floor(elapsed / (24 * 60 * 60_000))}일 전`;
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(openedAt));
}

function recentPageLabel(record) {
  if (!(record.totalPages > 0)) {
    return '페이지 정보 준비 중';
  }
  const page = Math.min(
    record.totalPages,
    Math.max(1, Number(record.lastPage) || 1),
  );
  return `${page} / ${record.totalPages} 페이지`;
}

function createRecentCard(record) {
  const card = document.createElement('article');
  card.className = 'recent-card';
  card.dataset.extension = record.extension;

  const openButton = document.createElement('button');
  openButton.className = 'recent-open';
  openButton.type = 'button';
  openButton.title = record.fileName;
  openButton.setAttribute('aria-label', `${record.fileName} 다시 열기`);
  openButton.addEventListener('click', () => {
    void openRecentDocument(record.id);
  });

  const icon = document.createElement('span');
  icon.className = 'document-icon';
  icon.setAttribute('aria-hidden', 'true');

  const copy = document.createElement('span');
  copy.className = 'recent-copy';
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = record.fileName;
  const metadata = document.createElement('span');
  metadata.className = 'recent-meta';
  const badge = document.createElement('span');
  badge.className = 'file-badge';
  badge.textContent = record.extension.toUpperCase();
  const details = document.createElement('span');
  details.textContent = `${formatFileSize(record.size)} · ${formatOpenedAt(record.openedAt)}`;
  const page = document.createElement('span');
  page.className = 'recent-page';
  page.textContent = recentPageLabel(record);
  metadata.append(badge, details);
  copy.append(name, metadata, page);
  openButton.append(icon, copy);

  const menuButton = document.createElement('button');
  menuButton.className = 'recent-menu';
  menuButton.type = 'button';
  menuButton.textContent = '⋮';
  menuButton.setAttribute('aria-label', `${record.fileName} 옵션`);
  menuButton.addEventListener('click', () => openRecentActions(record));
  card.append(openButton, menuButton);
  return card;
}

async function refreshRecentDocuments() {
  const records = await listRecentDocuments();
  recentListElement.replaceChildren(...records.map(createRecentCard));
  recentEmptyStateElement.hidden = records.length > 0;
  clearRecentsButton.hidden = records.length === 0;
}

function closeModal(layer) {
  layer.hidden = true;
  if (recentActionSheet.hidden && confirmModal.hidden) {
    document.body.classList.remove('modal-open');
  }
}

function openModal(layer, focusTarget) {
  layer.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => focusTarget?.focus());
}

function openRecentActions(record) {
  selectedRecentDocumentId = record.id;
  selectedRecentDocument = record;
  recentActionSheet.dataset.extension = record.extension;
  actionDocumentBadge.textContent = record.extension.toUpperCase();
  actionDocumentName.textContent = record.fileName;
  actionDocumentName.title = record.fileName;
  actionDocumentMeta.textContent = `${formatFileSize(record.size)} · ${recentPageLabel(record)}`;
  actionDocumentDetails.hidden = true;
  actionDocumentDetails.replaceChildren();
  actionInfoButton.setAttribute('aria-expanded', 'false');
  openModal(recentActionSheet, actionOpenButton);
}

function requestConfirmation({ title, message, acceptLabel }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAcceptButton.textContent = acceptLabel;
  openModal(confirmModal, confirmCancelButton);
  return new Promise((resolve) => {
    pendingConfirmation = resolve;
  });
}

function finishConfirmation(accepted) {
  closeModal(confirmModal);
  pendingConfirmation?.(accepted);
  pendingConfirmation = null;
}

function showCorruptRecentError(record, error) {
  corruptRecentDocumentId = record.id;
  const reason = error instanceof Error ? error.message : String(error);
  recentErrorMessageElement.textContent = `${record.fileName}: 저장된 문서가 손상되었거나 더 이상 읽을 수 없습니다. (${reason})`;
  recentErrorElement.hidden = false;
}

function hideCorruptRecentError() {
  corruptRecentDocumentId = null;
  recentErrorElement.hidden = true;
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
      setStartMessage('문서를 열 준비가 되었어요.');
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
      scheduleRecentPageSave();
      break;
    case 'rendered':
      documentReady = true;
      homeButton.disabled = false;
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
      homeButton.disabled = false;
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
  documentTitleElement.title = fileName;
  homeButton.disabled = false;
  openAnotherButton.disabled = true;
  openSearchButton.disabled = true;
  resetSearchUi();
  globalThis.scrollTo({ top: 0, behavior: 'auto' });
}

async function persistReadingPosition() {
  if (activeRecentPageSaveTimer != null) {
    clearTimeout(activeRecentPageSaveTimer);
    activeRecentPageSaveTimer = null;
  }
  if (!activeRecentDocumentId || currentPageIndex < 0) {
    return;
  }
  try {
    await updateRecentPage(
      activeRecentDocumentId,
      currentPageIndex + 1,
      totalPageCount,
    );
  } catch (error) {
    originalConsoleError('Recent page save failed:', error);
  }
}

function scheduleRecentPageSave() {
  if (!activeRecentDocumentId || currentPageIndex < 0) {
    return;
  }
  if (activeRecentPageSaveTimer != null) {
    clearTimeout(activeRecentPageSaveTimer);
  }
  activeRecentPageSaveTimer = setTimeout(() => {
    void persistReadingPosition();
  }, recentPageSaveDelay);
}

async function showHome() {
  activeLoadGeneration += 1;
  pagePriorityObserver?.disconnect();
  pagePriorityObserver = null;
  prioritizePageWindow = null;
  await persistReadingPosition();
  activeRecentDocumentId = null;
  resetSearchUi();
  currentDocument?.free();
  currentDocument = null;
  documentReady = false;
  resetPageNavigation(0);
  pagesElement.replaceChildren();
  statusElement.hidden = true;
  renderProgressElement.hidden = true;
  viewerToolbar.hidden = true;
  startScreenElement.hidden = false;
  globalThis.scrollTo({ top: 0, behavior: 'auto' });
  try {
    await refreshRecentDocuments();
  } catch (error) {
    setStartMessage('최근 문서 목록을 불러오지 못했어요.', true);
    originalConsoleError('Recent documents refresh failed:', error);
  }
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

  try {
    hideCorruptRecentError();
    await persistReadingPosition();
    const documentBytes = await file.arrayBuffer();
    let recentRecord = null;
    try {
      recentRecord = await saveRecentDocument({
        fileName: file.name,
        extension: extension.slice(1),
        size: file.size,
        openedAt: Date.now(),
        documentBytes,
      });
    } catch (storageError) {
      originalConsoleError('Recent document save failed:', storageError);
    }

    activeRecentDocumentId = recentRecord?.id || null;
    showDocumentUi(file.name);
    await globalThis.loadRhwpDocumentBytes(
      new Uint8Array(documentBytes),
      file.name,
      { restorePage: recentRecord?.lastPage || 1 },
    );
  } catch (error) {
    reportRenderingError(error);
  }
}

async function documentBytesToUint8Array(documentBytes) {
  if (documentBytes instanceof Uint8Array) {
    return documentBytes;
  }
  if (documentBytes instanceof ArrayBuffer) {
    return new Uint8Array(documentBytes);
  }
  if (ArrayBuffer.isView(documentBytes)) {
    return new Uint8Array(
      documentBytes.buffer,
      documentBytes.byteOffset,
      documentBytes.byteLength,
    );
  }
  if (documentBytes instanceof Blob) {
    return new Uint8Array(await documentBytes.arrayBuffer());
  }
  throw new TypeError('저장된 문서 데이터 형식을 읽을 수 없습니다.');
}

async function openRecentDocument(id) {
  if (!engineReady) {
    return;
  }
  let record;
  try {
    hideCorruptRecentError();
    await persistReadingPosition();
    record = await getRecentDocument(id);
    if (!record) {
      throw new Error('최근 문서 목록에서 이 항목을 찾을 수 없습니다.');
    }
    const bytes = await documentBytesToUint8Array(record.documentBytes);
    const refreshed = await saveRecentDocument({
      ...record,
      openedAt: Date.now(),
      documentBytes: record.documentBytes,
    });
    activeRecentDocumentId = refreshed.id;
    showDocumentUi(record.fileName);
    const result = await globalThis.loadRhwpDocumentBytes(
      bytes,
      record.fileName,
      { restorePage: record.lastPage || 1 },
    );
    if (result?.cancelled) {
      return;
    }
    if (!result?.ok) {
      const renderingError = result?.error || new Error('문서를 읽을 수 없습니다.');
      await showHome();
      showCorruptRecentError(record, renderingError);
      setStartMessage('최근 문서를 열지 못했어요.', true);
    }
  } catch (error) {
    activeRecentDocumentId = null;
    if (record) {
      await showHome();
      showCorruptRecentError(record, error);
    } else {
      setStartMessage(describeError(error), true);
    }
  }
}

startOpenButton.addEventListener('click', openFilePicker);
emptyOpenButton.addEventListener('click', openFilePicker);
openAnotherButton.addEventListener('click', openFilePicker);
homeButton.addEventListener('click', () => {
  void showHome();
});
documentInput.addEventListener('change', () => {
  const file = documentInput.files?.[0];
  documentInput.value = '';
  if (file) {
    void openSelectedFile(file);
  }
});

clearRecentsButton.addEventListener('click', async () => {
  const accepted = await requestConfirmation({
    title: '모든 최근 문서를 지울까요?',
    message: '이 기기에 저장된 최근 문서 데이터가 모두 삭제됩니다. 이 작업은 되돌릴 수 없어요.',
    acceptLabel: '모두 지우기',
  });
  if (!accepted) {
    return;
  }
  try {
    await clearRecentDocuments();
    hideCorruptRecentError();
    await refreshRecentDocuments();
    setStartMessage('최근 문서를 모두 삭제했어요.');
  } catch (error) {
    setStartMessage(`최근 문서를 삭제하지 못했어요. ${describeError(error)}`, true);
  }
});

actionOpenButton.addEventListener('click', () => {
  const id = selectedRecentDocumentId;
  closeModal(recentActionSheet);
  if (id) {
    void openRecentDocument(id);
  }
});

actionInfoButton.addEventListener('click', () => {
  if (!selectedRecentDocument) {
    return;
  }
  const willShow = actionDocumentDetails.hidden;
  if (willShow) {
    const opened = new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(selectedRecentDocument.openedAt));
    actionDocumentDetails.textContent = [
      `형식 ${selectedRecentDocument.extension.toUpperCase()}`,
      `크기 ${formatFileSize(selectedRecentDocument.size)}`,
      `마지막으로 연 시간 ${opened}`,
      recentPageLabel(selectedRecentDocument),
      '저장 위치 이 기기',
    ].join(' · ');
  }
  actionDocumentDetails.hidden = !willShow;
  actionInfoButton.setAttribute('aria-expanded', String(willShow));
});

actionDeleteButton.addEventListener('click', async () => {
  const id = selectedRecentDocumentId;
  closeModal(recentActionSheet);
  if (!id) {
    return;
  }
  const accepted = await requestConfirmation({
    title: '이 문서를 삭제할까요?',
    message: '최근 문서 목록에서 이 문서를 삭제합니다. 저장된 문서 데이터도 함께 삭제됩니다. 원본 파일은 삭제되지 않아요.',
    acceptLabel: '삭제',
  });
  if (accepted) {
    try {
      await deleteRecentDocument(id);
      if (corruptRecentDocumentId === id) {
        hideCorruptRecentError();
      }
      await refreshRecentDocuments();
    } catch (error) {
      setStartMessage(`최근 문서를 삭제하지 못했어요. ${describeError(error)}`, true);
    }
  }
});

deleteCorruptRecentButton.addEventListener('click', async () => {
  if (!corruptRecentDocumentId) {
    return;
  }
  try {
    await deleteRecentDocument(corruptRecentDocumentId);
    hideCorruptRecentError();
    await refreshRecentDocuments();
    setStartMessage('손상된 최근 문서를 목록에서 삭제했어요.');
  } catch (error) {
    setStartMessage(`최근 문서를 삭제하지 못했어요. ${describeError(error)}`, true);
  }
});

confirmCancelButton.addEventListener('click', () => finishConfirmation(false));
confirmAcceptButton.addEventListener('click', () => finishConfirmation(true));
for (const closeButton of document.querySelectorAll('[data-close-modal]')) {
  closeButton.addEventListener('click', () => {
    if (!confirmModal.hidden) {
      finishConfirmation(false);
    } else {
      closeModal(recentActionSheet);
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (!confirmModal.hidden) {
    finishConfirmation(false);
  } else if (!recentActionSheet.hidden) {
    closeModal(recentActionSheet);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void persistReadingPosition();
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
    showStatus(`문서를 준비하고 있어요… ${renderedPages} / ${totalPages}`);
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

function startPageTracking(pages, loadGeneration = activeLoadGeneration) {
  const visiblePages = new Map();
  const thresholds = Array.from({ length: 11 }, (_, index) => index / 10);
  pageTrackingObserver = new IntersectionObserver((entries) => {
    if (loadGeneration !== activeLoadGeneration) {
      return;
    }
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

globalThis.loadRhwpDocumentBytes = async (
  inputBytes,
  fileName,
  { restorePage = 1 } = {},
) => {
  const loadGeneration = activeLoadGeneration + 1;
  activeLoadGeneration = loadGeneration;
  const isCurrentLoad = () => loadGeneration === activeLoadGeneration;
  const cancelledResult = { ok: false, cancelled: true };
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
    currentDocument = null;
    currentDocument = new HwpDocument(bytes);
    console.log(
      `[timing] document parse completed: `
        + `${(performance.now() - loadStartedAt).toFixed(1)} ms`,
    );

    const pageCount = currentDocument.pageCount();
    const pages = createPagePlaceholders(pageCount);
    resetPageNavigation(pageCount);
    startPageTracking(pages, loadGeneration);
    const restorePageIndex = pageCount > 0
      ? Math.min(pageCount - 1, Math.max(0, Number(restorePage) - 1 || 0))
      : -1;
    let restoreApplied = false;
    svgTextIndexes = new Array(pageCount);
    const completedPages = new Set();
    const priorityPages = [];
    const queuedPriorityPages = new Set();
    let completedPageCount = 0;
    let nextSequentialPage = initialPageBatchSize;

    const enqueuePriorityWindow = (targetPageIndex) => {
      if (!isCurrentLoad()) {
        return;
      }
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
    if (restorePageIndex >= 0) {
      enqueuePriorityWindow(restorePageIndex);
    }

    if (typeof IntersectionObserver === 'function') {
      pagePriorityObserver = new IntersectionObserver((entries) => {
        if (!isCurrentLoad()) {
          return;
        }
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
      if (!isCurrentLoad() || completedPages.has(pageIndex)) {
        return false;
      }

      const page = pages[pageIndex];
      try {
        page.innerHTML = currentDocument.renderPageSvg(pageIndex);
        page.classList.remove('placeholder');
        page.classList.add('rendered');
        page.removeAttribute('aria-busy');
        svgTextIndexes[pageIndex] = buildSvgTextIndex(page, pageIndex);
        if (!restoreApplied && pageIndex === restorePageIndex) {
          restoreApplied = true;
          requestAnimationFrame(() => {
            if (isCurrentLoad()) {
              scrollToPage(restorePageIndex);
            }
          });
        }
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
      return true;
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
      if (!isCurrentLoad()) {
        return cancelledResult;
      }

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
      if (!isCurrentLoad()) {
        return cancelledResult;
      }
    }

    while (isCurrentLoad() && completedPageCount < pageCount) {
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

    if (!isCurrentLoad()) {
      return cancelledResult;
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
    return { ok: true, ...result };
  } catch (error) {
    if (!isCurrentLoad()) {
      return cancelledResult;
    }
    reportRenderingError(error);
    return { ok: false, error };
  }
};

void initRecentDocuments()
  .then(refreshRecentDocuments)
  .catch((error) => {
    originalConsoleError('Recent documents initialization failed:', error);
    setStartMessage('최근 문서 저장소를 사용할 수 없지만 파일은 열 수 있어요.', true);
  });

try {
  await init({ module_or_path: './rhwp_bg.wasm' });
  showStatus('렌더링 엔진 준비 완료');
  post('ready', { coreVersion: '0.8.7' });
} catch (error) {
  reportRenderingError(error);
}
