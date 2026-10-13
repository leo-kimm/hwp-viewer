export const RECENT_DOCUMENTS_DB_NAME = 'kyokyo-viewer';
export const RECENT_DOCUMENTS_DB_VERSION = 1;
export const RECENT_DOCUMENTS_STORE_NAME = 'recentDocuments';
export const MAX_RECENT_DOCUMENTS = 10;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(
      request.error || new Error('IndexedDB 요청에 실패했습니다.'),
    ), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(
      transaction.error || new Error('IndexedDB 트랜잭션이 중단되었습니다.'),
    ), { once: true });
    transaction.addEventListener('error', () => reject(
      transaction.error || new Error('IndexedDB 트랜잭션에 실패했습니다.'),
    ), { once: true });
  });
}

function createIndexedDbBackend(indexedDBFactory = globalThis.indexedDB) {
  let databasePromise;

  const openDatabase = () => {
    if (!indexedDBFactory) {
      return Promise.reject(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다.'));
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBFactory.open(
          RECENT_DOCUMENTS_DB_NAME,
          RECENT_DOCUMENTS_DB_VERSION,
        );
        request.addEventListener('upgradeneeded', () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(
            RECENT_DOCUMENTS_STORE_NAME,
          )) {
            const store = database.createObjectStore(
              RECENT_DOCUMENTS_STORE_NAME,
              { keyPath: 'id' },
            );
            store.createIndex('openedAt', 'openedAt');
            store.createIndex('duplicateKey', 'duplicateKey', { unique: true });
          }
        });
        request.addEventListener('success', () => {
          const database = request.result;
          database.addEventListener('versionchange', () => database.close());
          resolve(database);
        }, { once: true });
        request.addEventListener('error', () => {
          databasePromise = null;
          reject(request.error || new Error('최근 문서 저장소를 열 수 없습니다.'));
        }, { once: true });
      });
    }
    return databasePromise;
  };

  const withStore = async (mode, callback) => {
    const database = await openDatabase();
    const transaction = database.transaction(
      RECENT_DOCUMENTS_STORE_NAME,
      mode,
    );
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(RECENT_DOCUMENTS_STORE_NAME);
    const result = await callback(store);
    await completion;
    return result;
  };

  return {
    init: openDatabase,
    getAll: () => withStore('readonly', (store) => requestResult(store.getAll())),
    get: (id) => withStore('readonly', (store) => requestResult(store.get(id))),
    put: (record) => withStore('readwrite', (store) => requestResult(
      store.put(record),
    )),
    delete: (id) => withStore('readwrite', (store) => requestResult(
      store.delete(id),
    )),
    clear: () => withStore('readwrite', (store) => requestResult(store.clear())),
  };
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `recent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function duplicateKey(fileName, size) {
  return `${String(fileName).normalize('NFC')}\u0000${Number(size) || 0}`;
}

function metadataOnly(record) {
  if (!record) {
    return null;
  }
  const { documentBytes: _documentBytes, ...metadata } = record;
  return metadata;
}

function newestFirst(records) {
  return [...records].sort((left, right) => (
    Number(right.openedAt) - Number(left.openedAt)
  ));
}

function normalizePage(page, totalPages = 0) {
  const maximum = Math.max(1, Number(totalPages) || 1);
  return Math.min(maximum, Math.max(1, Math.trunc(Number(page) || 1)));
}

export function createRecentDocumentsRepository(backend) {
  let writeQueue = Promise.resolve();
  const serializeWrite = (operation) => {
    const result = writeQueue.then(operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  const initRecentDocuments = () => backend.init();

  const listRecentDocuments = async () => newestFirst(
    await backend.getAll(),
  ).map(metadataOnly);

  const getRecentDocument = (id) => backend.get(id);

  const saveRecentDocument = (input) => serializeWrite(async () => {
    await backend.init();
    const records = await backend.getAll();
    const key = duplicateKey(input.fileName, input.size);
    const existing = records.find((record) => record.duplicateKey === key);
    const totalPages = Math.max(
      0,
      Math.trunc(Number(input.totalPages ?? existing?.totalPages) || 0),
    );
    const record = {
      id: existing?.id || input.id || createId(),
      fileName: String(input.fileName),
      extension: String(input.extension || '').replace(/^\./u, '').toLowerCase(),
      size: Math.max(0, Number(input.size) || 0),
      openedAt: Number(input.openedAt) || Date.now(),
      lastPage: normalizePage(input.lastPage ?? existing?.lastPage, totalPages),
      totalPages,
      documentBytes: input.documentBytes ?? existing?.documentBytes,
      duplicateKey: key,
    };
    if (record.documentBytes == null) {
      throw new TypeError('최근 문서에는 documentBytes가 필요합니다.');
    }

    await backend.put(record);
    const overflow = newestFirst([
      ...records.filter((item) => item.id !== record.id),
      record,
    ]).slice(MAX_RECENT_DOCUMENTS);
    await Promise.all(overflow.map((item) => backend.delete(item.id)));
    return metadataOnly(record);
  });

  const updateRecentPage = (id, page, totalPages) => serializeWrite(async () => {
    const record = await backend.get(id);
    if (!record) {
      return null;
    }
    const nextTotalPages = totalPages == null
      ? record.totalPages
      : Math.max(0, Math.trunc(Number(totalPages) || 0));
    const updated = {
      ...record,
      totalPages: nextTotalPages,
      lastPage: normalizePage(page, nextTotalPages),
    };
    await backend.put(updated);
    return metadataOnly(updated);
  });

  const deleteRecentDocument = (id) => serializeWrite(() => backend.delete(id));
  const clearRecentDocuments = () => serializeWrite(() => backend.clear());

  return {
    initRecentDocuments,
    saveRecentDocument,
    listRecentDocuments,
    getRecentDocument,
    updateRecentPage,
    deleteRecentDocument,
    clearRecentDocuments,
  };
}

const repository = createRecentDocumentsRepository(createIndexedDbBackend());

export const initRecentDocuments = repository.initRecentDocuments;
export const saveRecentDocument = repository.saveRecentDocument;
export const listRecentDocuments = repository.listRecentDocuments;
export const getRecentDocument = repository.getRecentDocument;
export const updateRecentPage = repository.updateRecentPage;
export const deleteRecentDocument = repository.deleteRecentDocument;
export const clearRecentDocuments = repository.clearRecentDocuments;
