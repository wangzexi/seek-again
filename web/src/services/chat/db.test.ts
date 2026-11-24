import "fake-indexeddb/auto";
import { expect, test, spyOn } from "bun:test";
import { forceCloseDatabase } from "fake-indexeddb";
import * as db from "./db.js";
import type { Session } from "./types.js";

const session: Session = {
  id: "connection-recovery",
  title: "Before closure",
  createdAt: 1,
  updatedAt: 1,
  messages: [],
};

test("reopens closed connections, preserves concurrent save order, and bounds retries", async () => {
  let connection: IDBDatabase | undefined;
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = spyOn(indexedDB, "open").mockImplementation((...args) => {
    const request = originalOpen(...args);
    request.addEventListener("success", () => {
      connection = request.result;
    });
    return request;
  });
  const originalTransaction = IDBDatabase.prototype.transaction;
  let failures = 0;
  let failureName = "InvalidStateError";
  let attempts = 0;
  const txSpy = spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    attempts += 1;
    if (failures > 0) {
      failures -= 1;
      if (failureName === "InvalidStateError") this.close();
      else throw new DOMException("Storage full", failureName);
    }
    return originalTransaction.apply(this, args);
  });
  try {
    await db.saveSession(session);
    // Explicit close emits no close event: the transaction creation retry must recover.
    connection!.close();
    await Promise.all([
      db.saveSession({ ...session, title: "Older" }),
      db.saveSession({ ...session, title: "Newest" }, [
        { id: "image", blob: new Blob(["original"]) },
      ]),
    ]);
    expect((await db.loadSession(session.id))?.title).toBe("Newest");
    expect(await (await db.loadFile("image"))?.text()).toBe("original");
    // Browser termination fires close, so the next read must open a fresh connection.
    forceCloseDatabase(connection! as unknown as Parameters<typeof forceCloseDatabase>[0]);
    expect((await db.loadSessionSummaries())[0]?.title).toBe("Newest");
    failures = 2;
    const before = attempts;
    await expect(db.saveSession(session)).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(attempts - before).toBe(2);
    failures = 0;
    await db.saveSession(session);
    failureName = "QuotaExceededError";
    failures = 1;
    const beforeQuota = attempts;
    await expect(db.saveSession(session)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(attempts - beforeQuota).toBe(1);
  } finally {
    txSpy.mockRestore();
    openSpy.mockRestore();
    connection?.close();
  }
});
