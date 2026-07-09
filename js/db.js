/* Lokale opslag voor routes (IndexedDB). Volledig offline. */
(function (global) {
  'use strict';

  const DB_NAME = 'wandelen';
  const DB_VERSION = 2;
  const STORE = 'routes';
  const REGIONS = 'regions';
  let _dbPromise = null;

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(REGIONS)) {
          db.createObjectStore(REGIONS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  const DB = {
    async all() {
      const store = await tx('readonly');
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          items.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
          resolve(items);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async get(id) {
      const store = await tx('readonly');
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    async put(route) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        const req = store.put(route);
        req.onsuccess = () => resolve(route);
        req.onerror = () => reject(req.error);
      });
    },

    async remove(id) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },

    async count() {
      const store = await tx('readonly');
      return new Promise((resolve, reject) => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    // ---------- Offline opgeslagen regio's ----------
    async putRegion(region) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(REGIONS, 'readwrite').objectStore(REGIONS).put(region);
        req.onsuccess = () => resolve(region);
        req.onerror = () => reject(req.error);
      });
    },
    async allRegions() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(REGIONS, 'readonly').objectStore(REGIONS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },
  };

  global.DB = DB;
})(window);
