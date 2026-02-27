# HMAC-Signed URLs for Image Security

## Overview

Images are protected using cryptographically signed URLs with HMAC-SHA256 signatures. This replaces the previous Service Worker approach and provides stateless, time-limited access control.

## Architecture

### Key Components

1. **SigningKeyService** (Backend)
   - Derives signing keys from master secret
   - Issues keys with 1-hour expiration
   - Supports both authenticated users and share tokens

2. **SignatureValidator** (Backend)
   - Validates HMAC signatures on incoming requests
   - Checks signature expiration (10-minute URLs)
   - Stateless validation using derived keys

3. **ImageAuthorizer** (Backend)
   - Authorizes access to photos based on ownership or sharing
   - Checks library membership, album access, and share permissions

4. **SigningKeyManager** (Frontend)
   - Manages signing key lifecycle
   - Auto-refreshes keys 5 minutes before expiration
   - Caches keys in memory

5. **ImageAuthProvider** (Frontend)
   - React context for sharing signing keys
   - Initializes keys on app load
   - Manages keys across auth state changes

## Security Model

### Time-Based Expiration

- **Signing Keys**: 1 hour expiration (default, configurable)
- **Signed URLs**: 10 minutes expiration (default, configurable)
- **Auto-Refresh**: Keys refresh automatically 5 minutes before expiration

### Signature Generation

Client-side (browser):
```typescript
const canonical = `${libraryId}:${photoId}:${size}:${format}:${expiresAt}`;
const signature = await crypto.subtle.sign(
  'HMAC',
  signingKey,
  new TextEncoder().encode(canonical)
);
```

Server-side (validation):
```typescript
const canonical = `${libraryId}:${photoId}:${size}:${format}:${expiresAt}`;
const expectedSignature = crypto
  .createHmac('sha256', derivedKey)
  .update(canonical)
  .digest('base64url');
```

### Authorization Flow

1. Client requests signing key from `/api/signing/key` with Bearer token
2. Backend validates auth and returns time-limited signing key
3. Client generates signed URLs for all image requests
4. Backend middleware validates signature and authorizes access
5. If valid, image is served; if invalid, 403 Forbidden

## Configuration

### Backend Environment Variables

```env
# Key expiration (seconds)
SIGNING_KEY_EXPIRATION=3600        # 1 hour

# URL expiration (seconds)
SIGNED_URL_EXPIRATION=600          # 10 minutes

# Master secret (required in production)
SIGNING_MASTER_SECRET=<hex-string>
```

### Generating Master Secret

```bash
# Generate secure random 256-bit secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**⚠️ Critical**: Set `SIGNING_MASTER_SECRET` in production. If unset, a random secret is generated on startup, invalidating all keys on restart.

## API Endpoints

### Get Signing Key (Authenticated)

```http
POST /api/signing/key
Authorization: Bearer <token>
```

Response:
```json
{
  "key": "<base64-encoded-hmac-key>",
  "expiresAt": "2026-02-27T10:00:00Z",
  "userId": "user-123"
}
```

### Get Signing Key (Share Access)

```http
POST /api/signing/key/share/:token
```

Response:
```json
{
  "key": "<base64-encoded-hmac-key>",
  "expiresAt": "2026-02-27T10:00:00Z",
  "shareToken": "share-xyz"
}
```

### Signed Image Request

```http
GET /api/images/:libraryId/:photoId?size=medium&format=webp&expires=1709035200&sig=<base64url-signature>
```

## Frontend Integration

### Using ImageAuthProvider

```typescript
import { ImageAuthProvider } from './hooks/useImageAuth';

function App() {
  const services = useMemo(() => createLocalServices(), []);

  return (
    <ServiceProvider services={services}>
      <ImageAuthProvider authService={services.auth}>
        {/* App content */}
      </ImageAuthProvider>
    </ServiceProvider>
  );
}
```

### Using Signing Keys

```typescript
import { useImageAuth } from './hooks/useImageAuth';
import { getThumbnailUrl } from './utils/imageUrls';

function PhotoComponent({ photo }) {
  const { signingKey, isReady } = useImageAuth();

  if (!isReady || !signingKey) {
    return <div>Loading...</div>;
  }

  const imageUrl = getThumbnailUrl(
    photo.libraryId,
    photo.id, 
    signingKey
  );

  return <img src={imageUrl} alt={photo.name} />;
}
```

## Deployment Checklist

- [ ] Set `SIGNING_MASTER_SECRET` environment variable
- [ ] Configure `SIGNING_KEY_EXPIRATION` (default: 3600 = 1 hour)
- [ ] Configure `SIGNED_URL_EXPIRATION` (default: 600 = 10 minutes)
- [ ] Deploy backend with signing routes enabled
- [ ] Deploy frontend with ImageAuthProvider configured
- [ ] Test authenticated user access
- [ ] Test share link access
- [ ] Verify key auto-refresh works
- [ ] Monitor for signature validation failures

## Monitoring

### Key Metrics to Track

- **Signature validation failures**: High rate indicates clock skew or config issues
- **Key refresh rate**: Should match configured expiration times
- **Auth failures**: May indicate token expiration or misconfiguration
- **Image 403 errors**: Check authorization logic and share permissions

### Common Issues

1. **"Signature expired"**: Client clock skew or URL generated too long ago
2. **"Invalid signature"**: Mismatched master secret between instances
3. **"User not authenticated"**: Session expired, need to refresh token
4. **"Photo not found"**: Authorization succeeded but photo doesn't exist

## Future Enhancements

- [ ] Add `onAuthStateChanged` to AuthService contract for real-time updates
- [ ] Implement CDN integration with signed URLs
- [ ] Add signature validation metrics/logging
- [ ] Support rotating master secrets without downtime
- [ ] Add rate limiting per signing key