import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { LocalJsonData } from '../../src/adapters/data/LocalJsonData.js';

const TEST_BASE_PATH = './test-data/database';

interface TestDoc {
  id: string;
  name: string;
  value: number;
}

describe('LocalJsonData', () => {
  let dataAdapter: LocalJsonData;

  beforeEach(async () => {
    dataAdapter = new LocalJsonData(TEST_BASE_PATH);
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should store and fetch data', async () => {
    const doc: TestDoc = {
      id: 'doc1',
      name: 'Test Document',
      value: 42,
    };

    await dataAdapter.storeData('test', 'doc1', doc);
    const fetched = await dataAdapter.fetchData<TestDoc>('test', 'doc1');

    expect(fetched).toEqual(doc);
  });

  it('should return null for non-existent document', async () => {
    const fetched = await dataAdapter.fetchData('test', 'nonexistent');
    expect(fetched).toBeNull();
  });

  it('should check if document exists', async () => {
    expect(await dataAdapter.exists('test', 'doc1')).toBe(false);

    await dataAdapter.storeData('test', 'doc1', { id: 'doc1' });

    expect(await dataAdapter.exists('test', 'doc1')).toBe(true);
  });

  it('should update data', async () => {
    const doc: TestDoc = {
      id: 'doc1',
      name: 'Original',
      value: 1,
    };

    await dataAdapter.storeData('test', 'doc1', doc);
    await dataAdapter.updateData('test', 'doc1', { name: 'Updated' });

    const updated = await dataAdapter.fetchData<TestDoc>('test', 'doc1');

    expect(updated?.name).toBe('Updated');
    expect(updated?.value).toBe(1); // Unchanged field
  });

  it('should delete data', async () => {
    await dataAdapter.storeData('test', 'doc1', { id: 'doc1' });
    expect(await dataAdapter.exists('test', 'doc1')).toBe(true);

    await dataAdapter.deleteData('test', 'doc1');
    expect(await dataAdapter.exists('test', 'doc1')).toBe(false);
  });

  it('should query data with filters', async () => {
    await dataAdapter.storeData('test', 'doc1', {
      id: 'doc1',
      name: 'Alice',
      value: 10,
    });
    await dataAdapter.storeData('test', 'doc2', {
      id: 'doc2',
      name: 'Bob',
      value: 20,
    });
    await dataAdapter.storeData('test', 'doc3', {
      id: 'doc3',
      name: 'Charlie',
      value: 15,
    });

    const results = await dataAdapter.queryData<TestDoc>('test', [
      { field: 'value', operator: '>=', value: 15 },
    ]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain('Bob');
    expect(results.map((r) => r.name)).toContain('Charlie');
  });

  it('should list all document IDs', async () => {
    await dataAdapter.storeData('test', 'doc1', { id: 'doc1' });
    await dataAdapter.storeData('test', 'doc2', { id: 'doc2' });
    await dataAdapter.storeData('test', 'doc3', { id: 'doc3' });

    const ids = await dataAdapter.listIds('test');

    expect(ids).toHaveLength(3);
    expect(ids).toContain('doc1');
    expect(ids).toContain('doc2');
    expect(ids).toContain('doc3');
  });
});