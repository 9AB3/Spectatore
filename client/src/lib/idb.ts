import { openDB } from 'idb';

export async function getDB() {
  return openDB('spectatore', 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('session');
        db.createObjectStore('shift');
        db.createObjectStore('activities', { keyPath: 'id', autoIncrement: true });
      }
      if (oldVersion < 2) {
        db.createObjectStore('equipment', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
      }
      if (oldVersion < 3) {
        // refresh locations schema/cache (now stores {id,name,type})
        if (db.objectStoreNames.contains('locations')) db.deleteObjectStore('locations');
        db.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
      }
    },
  });
}
