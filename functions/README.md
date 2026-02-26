# AuraPix Functions

Node.js service for image processing, serving, and storage operations. Designed to run locally for development and deploy to Firebase Functions for production.

## Architecture

### Adapter Pattern

The service uses adapters to remain host-agnostic:

- **StorageAdapter**: File storage operations (LocalDiskStorage / FirebaseStorage)
- **DataAdapter**: Database operations (LocalJsonData / FirestoreData)
- **CacheLayer**: Multi-tier caching (MemoryCache / DiskCache)

### Directory Structure

```
functions/
├── src/
│   ├── server.ts              # Local Express server
│   ├── index.ts              # Firebase Functions entry (future)
│   ├── adapters/             # Storage, data, and cache adapters
│   ├── config/               # Environment configuration
│   ├── middleware/           # Auth, error handling, logging
│   ├── models/               # Domain models
│   ├── services/             # Business logic
│   ├── handlers/             # Request handlers
│   ├── routes/               # Express routes
│   └── utils/                # Utilities
├── local-data/               # Local development data (git-ignored)
│   ├── storage/              # Image files
│   ├── database/             # JSON data files
│   └── cache/                # Cached images
└── test/                     # Tests
```

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create environment file**:
   ```bash
   cp .env.example .env
   ```

3. **Start development server**:
   ```bash
   npm run dev
   ```

   Server will run on http://localhost:3001

## Features

### Implemented (Phase 1)

- ✅ Adapter pattern for storage and data
- ✅ Local disk storage implementation
- ✅ Local JSON database implementation
- ✅ Multi-tier caching (memory + disk)
- ✅ Mock authentication middleware
- ✅ Structured logging
- ✅ Express server setup
- ✅ Photo domain model with edit versioning

### Planned

- [ ] Image upload endpoint
- [ ] Thumbnail generation
- [ ] Image serving with caching
- [ ] Non-destructive editing
- [ ] Firebase adapters
- [ ] Firebase Functions deployment

## API Endpoints

### Health Check
```
GET /health
```

### Images (Coming Soon)
```
GET  /images/:libraryId/:photoId
POST /images/:libraryId
```

### Internal (Coming Soon)
```
POST /internal/generate-thumbnails/:libraryId/:photoId
POST /internal/regenerate-thumbnails/:libraryId/:photoId/:version
```

## Development

### Running Tests
```bash
npm test
npm run test:watch
```

### Code Quality
```bash
npm run lint
npm run format
npm run format:check
```

### Building
```bash
npm run build
node dist/server.js
```

## Configuration

See `.env.example` for all available configuration options.

Key settings:
- `STORAGE_MODE`: `local` or `firebase`
- `AUTH_MODE`: `mock` or `firebase`
- `PORT`: Server port (default: 3001)
- Thumbnail sizes and quality settings
- Cache TTL and size limits

## Non-Destructive Editing

Photos support versioned, non-destructive edits:

1. Original images are never modified
2. Edits are stored as operations in metadata
3. Thumbnails are regenerated when edits change
4. Full-size edited images are cached
5. Can revert to any previous version

See `src/models/Photo.ts` for the data model.