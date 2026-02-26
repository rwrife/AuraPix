# Local Development Guide

This guide covers setting up and running AuraPix in local development mode.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   npm --prefix functions install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env.local
   ```

3. **Start development servers**
   ```bash
   npm run dev
   ```

This starts both the frontend (port 5173) and backend (port 3001) concurrently.

## Environment Variables

### Frontend (.env.local)

```env
# Backend API URL
VITE_API_BASE_URL=http://localhost:3001

# Environment
VITE_ENV=development

# Feature flags
VITE_ENABLE_ANALYTICS=false
```

### Backend (functions/.env)

```env
# Node environment
NODE_ENV=development

# Server port
PORT=3001

# Storage configuration
STORAGE_MODE=local
LOCAL_STORAGE_PATH=./test-data/storage

# Data configuration
DATA_MODE=local
LOCAL_DATA_PATH=./test-data/db.json

# Cache configuration
CACHE_MODE=memory
```

## Available Scripts

### Root Level

- `npm run dev` - Start both frontend and backend
- `npm run dev:frontend` - Start frontend only
- `npm run dev:backend` - Start backend only
- `npm run build` - Build both for production
- `npm test` - Run frontend tests

### Backend (functions/)

- `npm run dev` - Start backend in watch mode
- `npm run build` - Build backend for production
- `npm test` - Run backend tests
- `npm run lint` - Lint backend code

## Health Monitoring

The frontend automatically monitors backend health:

- **Check interval**: Every 30 seconds
- **Timeout**: 5 seconds per check
- **Visual feedback**: Red banner at top of page when backend is down
- **Error details**: Displayed in banner (timeout, connection refused, HTTP errors)

### Health Check Endpoint

```
GET http://localhost:3001/internal/health

Response:
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "service": "aurapix-backend",
  "version": "1.0.0"
}
```

## Development Workflow

### 1. Frontend Development

The frontend runs on http://localhost:5173 with hot module replacement (HMR):

- Changes to React components are reflected instantly
- TypeScript errors appear in the browser console
- Redux DevTools available for state inspection

### 2. Backend Development

The backend runs on http://localhost:3001 with auto-restart on file changes:

- Changes to handlers/services trigger automatic restart
- API requests can be tested with curl or Postman
- Logs appear in the terminal

### 3. Full-Stack Features

When developing features that span frontend and backend:

1. Start both servers with `npm run dev`
2. The frontend will automatically connect to the local backend
3. API calls use the configured `VITE_API_BASE_URL`
4. Backend changes restart the server but don't affect frontend

## Port Configuration

Default ports:
- **Frontend**: 5173 (Vite default)
- **Backend**: 3001 (configured in functions/.env)

To change ports:

**Frontend (vite.config.ts)**:
```typescript
export default defineConfig({
  server: {
    port: 3000, // Change here
  },
});
```

**Backend (functions/.env)**:
```env
PORT=4000  # Change here
```

Remember to update `VITE_API_BASE_URL` in frontend `.env.local` if you change the backend port.

## Troubleshooting

### Backend Won't Start

1. Check if port 3001 is already in use:
   ```bash
   # Windows
   netstat -ano | findstr :3001
   
   # Kill the process if needed
   taskkill /PID <process_id> /F
   ```

2. Verify environment variables in `functions/.env`

3. Check for TypeScript errors:
   ```bash
   cd functions
   npm run build
   ```

### Frontend Can't Connect to Backend

1. Verify backend is running on correct port
2. Check `VITE_API_BASE_URL` in `.env.local`
3. Look for CORS errors in browser console
4. Verify health banner appears (indicates health check is working)

### Health Check Fails

If the warning banner persists even when backend is running:

1. Test health endpoint directly:
   ```bash
   curl http://localhost:3001/internal/health
   ```

2. Check browser console for CORS or network errors
3. Verify no firewall/antivirus blocking local connections

### Build Errors

If `npm run build` fails:

1. Clear node_modules and reinstall:
   ```bash
   rm -rf node_modules functions/node_modules
   npm install
   npm --prefix functions install
   ```

2. Check for TypeScript errors:
   ```bash
   npm run lint
   cd functions && npm run lint
   ```

## Testing

### Frontend Tests

```bash
# Run tests in watch mode
npm test

# Run tests once
npm test -- --run

# With coverage
npm run test:coverage
```

### Backend Tests

```bash
cd functions

# Run tests in watch mode
npm test

# Run tests once
npm test -- --run

# With coverage
npm run test:coverage
```

### Integration Tests

```bash
# Start backend first
npm run dev:backend

# In another terminal, run integration tests
cd functions
npm run test:integration
```

## Next Steps

- Review [Architecture Documentation](../IMPLEMENTATION_PLAN.md)
- Learn about [Firebase Setup](./firebase-app-hosting-prep.md)
- Explore [Feature Specifications](../features/)