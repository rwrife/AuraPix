# Concurrent Frontend & Backend Development Setup

This document describes the configuration for running frontend and backend services concurrently during development.

## Overview

The project is configured to run both the React frontend (Vite) and Node.js backend (Express) simultaneously with a single command. The frontend includes health monitoring to detect when the backend is unavailable.

## Quick Start

```bash
# Install dependencies (first time only)
npm install

# Start both services
npm run dev
```

This starts:
- **Frontend**: http://localhost:5173
- **Backend**: http://localhost:3001

## Implementation Details

### 1. Package Scripts (package.json)

```json
{
  "scripts": {
    "dev": "npm-run-all --parallel dev:frontend dev:backend",
    "dev:frontend": "vite",
    "dev:backend": "npm --prefix functions run dev"
  }
}
```

- `dev` - Runs both services in parallel using `npm-run-all`
- `dev:frontend` - Starts Vite dev server (port 5173)
- `dev:backend` - Starts Express server in functions directory (port 3001)

### 2. Environment Configuration

#### Frontend (.env.local)

```env
VITE_API_BASE_URL=http://localhost:3001
VITE_ENV=development
```

The `VITE_API_BASE_URL` environment variable tells the frontend where to find the backend API.

#### Backend (functions/.env)

```env
NODE_ENV=development
PORT=3001
STORAGE_MODE=local
DATA_MODE=local
```

### 3. Health Check System

#### Backend Endpoint (functions/src/routes/internal.ts)

```typescript
router.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'aurapix-backend',
    version: '1.0.0'
  });
});
```

#### Frontend Service (src/services/healthCheck.ts)

The `HealthCheckService` class:
- Polls the backend health endpoint every 30 seconds
- Times out after 5 seconds per request
- Notifies subscribers of status changes
- Handles network errors gracefully

Key methods:
```typescript
class HealthCheckService {
  start(): void              // Start monitoring
  stop(): void               // Stop monitoring
  performCheck(): Promise    // Manual check
  subscribe(listener): void  // Listen to status changes
}
```

#### Warning Banner Component (src/components/HealthBanner.tsx)

- Displays a fixed red banner at the top when backend is unhealthy
- Shows error details (timeout, connection refused, HTTP errors)
- Automatically hides when backend recovers
- Uses React hooks to subscribe to health status

### 4. Integration in App.tsx

```typescript
function App() {
  useEffect(() => {
    initializeHealthCheck();  // Start monitoring on mount
    return () => {
      cleanupHealthCheck();   // Cleanup on unmount
    };
  }, []);

  return (
    <ServiceProvider services={services}>
      <HealthBanner />        // Banner shown at top level
      <BrowserRouter>
        {/* routes */}
      </BrowserRouter>
    </ServiceProvider>
  );
}
```

## Configuration for Different Environments

### Local Development

```env
# .env.local
VITE_API_BASE_URL=http://localhost:3001
```

### Staging (Firebase Cloud Functions)

```env
# .env.staging
VITE_API_BASE_URL=https://us-central1-aurapix-staging.cloudfunctions.net/api
```

### Production (Firebase Cloud Functions)

```env
# .env.production
VITE_API_BASE_URL=https://us-central1-aurapix-prod.cloudfunctions.net/api
```

## Health Check Behavior

### Normal Operation
- Health check runs every 30 seconds
- No visual indication (banner hidden)
- Backend responds with 200 OK

### Backend Down
1. Health check times out or fails
2. Red warning banner appears at top
3. Banner shows error message
4. Continues checking in background
5. Banner disappears when backend recovers

### Network Errors Detected
- Connection refused (backend not running)
- Request timeout (backend slow/hung)
- HTTP errors (4xx, 5xx responses)
- CORS errors (misconfiguration)

## Testing Health Monitoring

### Test Backend Unavailable

1. Start frontend only:
   ```bash
   npm run dev:frontend
   ```

2. Observe warning banner appears after ~5 seconds

3. Start backend:
   ```bash
   npm run dev:backend
   ```

4. Banner disappears within 30 seconds

### Test Backend Health Endpoint

```bash
# Direct curl test
curl http://localhost:3001/internal/health

# Expected response
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "service": "aurapix-backend",
  "version": "1.0.0"
}
```

### Test Health Check Service

```typescript
// In browser console
const service = window.__healthService;
await service.performCheck();
// Returns: { isHealthy: boolean, lastChecked: Date, error?: string }
```

## Architecture Benefits

1. **Developer Experience**
   - Single command to start both services
   - Immediate feedback when backend is down
   - Clear error messages for debugging

2. **Production Ready**
   - Same health check works with Firebase Functions
   - Environment variables control backend URL
   - No code changes needed for deployment

3. **Resilient**
   - Frontend continues working if backend is temporarily down
   - Automatic recovery when backend comes back
   - User-friendly error messaging

4. **Maintainable**
   - Health check service is reusable
   - Banner component is self-contained
   - Easy to adjust check intervals and timeouts

## Troubleshooting

### Banner Appears Despite Backend Running

1. Check backend is actually on port 3001:
   ```bash
   curl http://localhost:3001/internal/health
   ```

2. Verify VITE_API_BASE_URL matches backend port

3. Check browser console for CORS errors

4. Ensure no firewall blocking localhost connections

### Backend Changes Not Reflected

- Backend uses nodemon for auto-restart
- TypeScript compilation happens automatically
- Check terminal for build errors
- May need manual restart if package.json changed

### Frontend Changes Not Reflected

- Vite HMR should work automatically
- Hard refresh if styles seem cached (Ctrl+Shift+R)
- Check browser console for errors
- Restart Vite if hot reload breaks

## Future Enhancements

Potential improvements to the health check system:

1. **Retry Logic**: Retry failed checks before showing warning
2. **Detailed Status**: Show specific service health (database, storage, etc.)
3. **Performance Metrics**: Display response time, uptime percentage
4. **User Actions**: Add "Retry Now" button to banner
5. **Offline Mode**: Cache recent data for temporary offline use
6. **Service Worker**: Background health checks even when tab inactive
7. **Analytics**: Track backend availability over time

## Related Documentation

- [Local Development Guide](./local-development.md)
- [Environment Setup](./environment.md)
- [Firebase Deployment](./firebase-app-hosting-prep.md)