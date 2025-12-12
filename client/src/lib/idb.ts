import { openDB } from 'idb';

export async function getDB() {
  return openDB('spectatore', 2, {
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
    },
  });
}
