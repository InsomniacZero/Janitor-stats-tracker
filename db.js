const DB_NAME = "janitorai-stats-tracker";
const DB_VERSION = 2;
const CHAR_STORE = "characters";
const SNAP_STORE = "snapshots";

function openTrackerDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CHAR_STORE)) {
        db.createObjectStore(CHAR_STORE, { keyPath: "characterId" });
      }

      if (!db.objectStoreNames.contains(SNAP_STORE)) {
        const store = db.createObjectStore(SNAP_STORE, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("characterId", "characterId", { unique: false });
        store.createIndex("characterTime", ["characterId", "timestamp"], { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open tracker database."));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

async function getAllCharacters() {
  const db = await openTrackerDb();
  try {
    const tx = db.transaction(CHAR_STORE, "readonly");
    return await idbRequest(tx.objectStore(CHAR_STORE).getAll());
  } finally {
    db.close();
  }
}

async function getCharacter(characterId) {
  const db = await openTrackerDb();
  try {
    const tx = db.transaction(CHAR_STORE, "readonly");
    return await idbRequest(tx.objectStore(CHAR_STORE).get(characterId));
  } finally {
    db.close();
  }
}

async function getSnapshots(characterId) {
  const db = await openTrackerDb();
  try {
    const tx = db.transaction(SNAP_STORE, "readonly");
    const index = tx.objectStore(SNAP_STORE).index("characterTime");
    const range = IDBKeyRange.bound(
      [characterId, ""],
      [characterId, "\uffff"]
    );
    const rows = await idbRequest(index.getAll(range));
    return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map(r => {
      const chats = Number(r.chats);
      const msgs = Number(r.msgs);
      return {
        ...r,
        chatMsgRatio: r.chatMsgRatio != null ? Number(r.chatMsgRatio) : (chats > 0 ? Number((msgs / chats).toFixed(3)) : null)
      };
    });
  } finally {
    db.close();
  }
}

async function getLatestSnapshot(characterId) {
  const db = await openTrackerDb();
  try {
    const tx = db.transaction(SNAP_STORE, "readonly");
    const index = tx.objectStore(SNAP_STORE).index("characterTime");
    const range = IDBKeyRange.bound(
      [characterId, ""],
      [characterId, "\uffff"]
    );
    return await new Promise((resolve, reject) => {
      const request = index.openCursor(range, "prev");
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error || new Error("Could not read latest snapshot."));
    });
  } finally {
    db.close();
  }
}

async function saveCharacterSnapshot(character, snapshot) {
  const db = await openTrackerDb();

  return new Promise((resolve, reject) => {
    let changed = false;
    const tx = db.transaction([CHAR_STORE, SNAP_STORE], "readwrite");
    const chars = tx.objectStore(CHAR_STORE);
    const snaps = tx.objectStore(SNAP_STORE);

    const charRequest = chars.get(character.characterId);

    charRequest.onerror = () => {
      try { tx.abort(); } catch {}
    };

    charRequest.onsuccess = () => {
      const existing = charRequest.result || {
        characterId: character.characterId,
        characterName: character.characterName || "JanitorAI character",
        url: character.url || "",
        createdAt: null,
        updatedAt: null,
        publishedAt: null,
        publishedChats: null,
        firstSeen: snapshot.timestamp,
        lastSeen: snapshot.timestamp,
        snapshotCount: 0,
        lastStats: null
      };

      existing.characterName = character.characterName || existing.characterName;
      existing.url = character.url || existing.url;
      existing.avatar = character.avatar || existing.avatar || null;
      existing.creator = character.creator || existing.creator || null;
      existing.creatorAvatar = character.creatorAvatar || existing.creatorAvatar || null;
      existing.createdAt = character.createdAt || existing.createdAt;
      existing.updatedAt = character.updatedAt || existing.updatedAt;
      existing.publishedAt = character.publishedAt || existing.publishedAt;
      if (Number.isFinite(snapshot.publishedChats)) existing.publishedChats = snapshot.publishedChats;
      existing.lastSeen = snapshot.timestamp;

      const sameStats = existing.lastStats &&
        ["msgs", "chats", "comments", "favourites", "publishedChats"].every(
          key => existing.lastStats[key] === snapshot[key]
        );

      if (!sameStats) {
        snaps.add({
          ...snapshot,
          characterId: character.characterId
        });
        existing.snapshotCount += 1;
        changed = true;
        existing.lastStats = {
          msgs: snapshot.msgs,
          chats: snapshot.chats,
          comments: snapshot.comments,
          favourites: snapshot.favourites,
          publishedChats: snapshot.publishedChats ?? null
        };
      }

      chars.put(existing);
    };

    tx.oncomplete = () => {
      db.close();
      resolve({
        saved: true,
        changed
      });
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Could not save snapshot."));
    };

    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("Snapshot save transaction aborted."));
    };
  });
}


async function importLegacyCharacters(characters) {
  const entries = Object.values(characters || {}).filter(Boolean);
  if (!entries.length) return 0;

  const db = await openTrackerDb();
  let imported = 0;

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([CHAR_STORE, SNAP_STORE], "readwrite");
      const chars = tx.objectStore(CHAR_STORE);
      const snaps = tx.objectStore(SNAP_STORE);

      for (const legacy of entries) {
        if (!legacy.characterId) continue;

        const character = {
          characterId: legacy.characterId,
          characterName: legacy.characterName || "JanitorAI character",
          url: legacy.url || "",
          createdAt: legacy.createdAt || null,
          updatedAt: legacy.updatedAt || null,
          publishedAt: legacy.publishedAt || null,
          publishedChats: legacy.publishedChats ?? null,
          firstSeen: legacy.snapshots?.[0]?.timestamp || legacy.lastSeen || new Date().toISOString(),
          lastSeen: legacy.lastSeen || legacy.snapshots?.at(-1)?.timestamp || new Date().toISOString(),
          snapshotCount: 0,
          lastStats: null
        };

        for (const item of legacy.snapshots || []) {
          if (!item?.timestamp) continue;
          const snapshot = {
            timestamp: item.timestamp,
            characterId: legacy.characterId,
            msgs: item.msgs ?? null,
            msgsDisplay: item.msgsDisplay ?? null,
            chats: item.chats ?? null,
            chatsDisplay: item.chatsDisplay ?? null,
            comments: item.comments ?? null,
            commentsDisplay: item.commentsDisplay ?? null,
            favourites: item.favourites ?? null,
            favouritesDisplay: item.favouritesDisplay ?? null,
            publishedChats: item.publishedChats ?? null,
            publishedChatsDisplay: item.publishedChatsDisplay ?? null
          };

          if (!["msgs", "chats", "comments", "favourites"].every(k => Number.isFinite(snapshot[k]))) {
            continue;
          }

          snaps.add(snapshot);
          character.snapshotCount += 1;
          character.lastStats = {
            msgs: snapshot.msgs,
            chats: snapshot.chats,
            comments: snapshot.comments,
            favourites: snapshot.favourites,
            publishedChats: snapshot.publishedChats ?? null
          };
          imported += 1;
        }

        chars.put(character);
      }

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Legacy migration failed."));
      tx.onabort = () => reject(tx.error || new Error("Legacy migration aborted."));
    });
  } finally {
    db.close();
  }

  return imported;
}

async function deleteCharacter(characterId) {
  const db = await openTrackerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CHAR_STORE, SNAP_STORE], "readwrite");
    const chars = tx.objectStore(CHAR_STORE);
    const snaps = tx.objectStore(SNAP_STORE);
    const index = snaps.index("characterId");

    chars.delete(characterId);

    const request = index.openCursor(IDBKeyRange.only(characterId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Could not delete character."));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("Delete transaction aborted."));
    };
  });
}

async function clearDatabase() {
  const db = await openTrackerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CHAR_STORE, SNAP_STORE], "readwrite");
    tx.objectStore(CHAR_STORE).clear();
    tx.objectStore(SNAP_STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Clear transaction aborted.")); };
  });
}

export {
  openTrackerDb,
  idbRequest,
  getAllCharacters,
  getCharacter,
  getSnapshots,
  getLatestSnapshot,
  saveCharacterSnapshot,
  importLegacyCharacters,
  deleteCharacter,
  clearDatabase
};

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    openTrackerDb,
    idbRequest,
    getAllCharacters,
    getCharacter,
    getSnapshots,
    getLatestSnapshot,
    saveCharacterSnapshot,
    importLegacyCharacters,
    deleteCharacter,
    clearDatabase
  });
}

