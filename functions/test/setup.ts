import { beforeAll, afterAll } from 'vitest';

// Global setup for all tests
beforeAll(() => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
});

afterAll(() => {
  // Cleanup if needed
});