// Subscriber records in a JSON file, keyed by email. Fine for a small app;
// swap for a real database once there are many subscribers.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createFileStore(file) {
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let writing = Promise.resolve();

  async function persist() {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  }

  return {
    get: (email) => data[email.toLowerCase()] || null,
    async put(email, record) {
      data[email.toLowerCase()] = { ...record, email: email.toLowerCase(), updatedAt: new Date().toISOString() };
      writing = writing.then(persist, persist);
      await writing;
    },
  };
}

export function createMemoryStore() {
  const data = {};
  return {
    get: (email) => data[email.toLowerCase()] || null,
    async put(email, record) {
      data[email.toLowerCase()] = { ...record, email: email.toLowerCase() };
    },
  };
}
