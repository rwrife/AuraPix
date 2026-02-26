import { promises as fs } from 'fs';
import path from 'path';
import type { DataAdapter, QueryFilter } from './DataAdapter.js';

interface CollectionData {
  [id: string]: any;
}

export class LocalJsonData implements DataAdapter {
  constructor(private readonly basePath: string) {}

  private getCollectionPath(collection: string): string {
    return path.join(this.basePath, `${collection}.json`);
  }

  private async loadCollection(collection: string): Promise<CollectionData> {
    const filePath = this.getCollectionPath(collection);
    
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async saveCollection(
    collection: string,
    data: CollectionData
  ): Promise<void> {
    const filePath = this.getCollectionPath(collection);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write with pretty formatting for easier debugging
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  async storeData<T>(collection: string, id: string, data: T): Promise<void> {
    const collectionData = await this.loadCollection(collection);
    collectionData[id] = data;
    await this.saveCollection(collection, collectionData);
  }

  async fetchData<T>(collection: string, id: string): Promise<T | null> {
    const collectionData = await this.loadCollection(collection);
    return collectionData[id] ?? null;
  }

  async queryData<T>(
    collection: string,
    filters: QueryFilter[]
  ): Promise<T[]> {
    const collectionData = await this.loadCollection(collection);
    const allDocuments = Object.values(collectionData) as T[];

    // Apply filters
    return allDocuments.filter((doc) => {
      return filters.every((filter) => {
        const value = (doc as any)[filter.field];
        
        switch (filter.operator) {
          case '==':
            return value === filter.value;
          case '!=':
            return value !== filter.value;
          case '>':
            return value > filter.value;
          case '>=':
            return value >= filter.value;
          case '<':
            return value < filter.value;
          case '<=':
            return value <= filter.value;
          default:
            return false;
        }
      });
    });
  }

  async updateData<T>(
    collection: string,
    id: string,
    updates: Partial<T>
  ): Promise<void> {
    const collectionData = await this.loadCollection(collection);
    
    if (!collectionData[id]) {
      throw new Error(`Document ${id} not found in collection ${collection}`);
    }

    collectionData[id] = {
      ...collectionData[id],
      ...updates,
    };

    await this.saveCollection(collection, collectionData);
  }

  async deleteData(collection: string, id: string): Promise<void> {
    const collectionData = await this.loadCollection(collection);
    delete collectionData[id];
    await this.saveCollection(collection, collectionData);
  }

  async exists(collection: string, id: string): Promise<boolean> {
    const collectionData = await this.loadCollection(collection);
    return id in collectionData;
  }

  async listIds(collection: string): Promise<string[]> {
    const collectionData = await this.loadCollection(collection);
    return Object.keys(collectionData);
  }
}