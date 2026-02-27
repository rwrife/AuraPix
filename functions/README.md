# AuraPix Backend Functions

Backend API for AuraPix photo management system with HMAC-signed URL authentication.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Generate Signing Secret

**IMPORTANT**: The backend requires a signing secret for HMAC-signed URLs.

```bash
# Generate a secure random secret
node generate-signing-secret.js
```

Save the generated secret - you'll need it for all deployments!

### 3. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env and paste your SIGNING_MASTER_SECRET
# (The 64-character hex string from step 2)
nano .env  # or use your preferred editor
```

### 4. Run Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:3001`

## Production Deployment

### Cloud Run Deployment

The deployment script will automatically handle the signing secret:

```bash
# From project root
./deploy-aurapix-cloudrun.sh
```

Or on Windows:

```powershell
.\deploy-aurapix-cloudrun.ps1
```

**First deployment**: The script will generate a signing secret automatically. Save it for future deployments!

**Subsequent deployments**: Set the secret in your environment:

```bash
export SIGNING_MASTER_SECRET="your-saved-secret-here"
./deploy-aurapix-cloudrun.sh
```

### Manual Cloud Run Deployment

```bash
# Build the Docker image
docker build -t gcr.io/YOUR_PROJECT_ID/aurapix-api:latest .

# Push to Google Container Registry
docker push gcr.io/YOUR_PROJECT_ID/aurapix-api:latest

# Deploy to Cloud Run with environment variables
gcloud run deploy aurapix-api \
  --image gcr.io/YOUR_PROJECT_ID/aurapix-api:latest \
  --region us-central1 \
  --allow-unauthenticated \
  --update-env-vars "NODE_ENV=production,SIGNING_MASTER_SECRET=your-secret-here"
```

### Firebase Functions Deployment

```bash
# Set the signing secret
firebase functions:config:set signing.master_secret="your-secret-here"

# Or add to .env file
echo "SIGNING_MASTER_SECRET=your-secret-here" >> .env

# Deploy
firebase deploy --only functions
```

## Environment Variables

### Required

- `SIGNING_MASTER_SECRET`: 64-character hex string (256 bits). Generate with `node generate-signing-secret.js`
  - **Must be set in production** - the app will refuse to start without it
  - Must remain consistent across deployments
  - Store securely in your deployment platform's environment variables

### Optional

- `PORT`: Server port (default: 3001)
- `NODE_ENV`: Environment ('development' or 'production')
- `STORAGE_MODE`: Storage backend ('local' or 'firebase')
- `SIGNING_KEY_EXPIRATION`: Key lifetime in seconds (default: 3600 = 1 hour)
- `SIGNED_URL_EXPIRATION`: URL lifetime in seconds (default: 600 = 10 minutes)

See `.env.example` for complete list.

## API Endpoints

### Health Check
- `GET /health` - Service health status

### Images
- `GET /api/images/:libraryId/:photoId` - Get image with signed URL validation
  - Query params: `size`, `format`, `sig`, `expiresAt`

### Signing Keys
- `POST /api/signing/key` - Get signing key (requires Bearer token)
- `POST /api/signing/key/share/:token` - Get signing key for share access

## Security

### HMAC-Signed URLs

All image URLs must be signed with HMAC-SHA256 to prevent unauthorized access:

1. Client requests signing key from backend
2. Client generates signed URLs using the key
3. Backend validates signature and expiration on each image request
4. Keys expire after 1 hour, URLs after 10 minutes

See `../docs/features/hmac-signed-urls.md` for detailed documentation.

## Development

### Run Tests

```bash
npm test
```

### Build

```bash
npm run build
```

### Lint

```bash
npm run lint
```

## Troubleshooting

### "SIGNING_MASTER_SECRET is required in production"

The app requires a signing secret to start. Generate one:

```bash
node generate-signing-secret.js
```

Then set it in your environment variables.

### "Failed to get signing key: 401 Unauthorized"

Check that:
1. Your auth token is valid
2. The `Authorization: Bearer <token>` header is included in the request
3. The auth service is properly configured

### Images not loading

Verify that:
1. The signing key is valid and not expired
2. The image URLs include valid `sig` and `expiresAt` parameters
3. The backend can access the storage location (local files or Cloud Storage)

## Documentation

- [HMAC Signed URLs](../docs/features/hmac-signed-urls.md)
- [Implementation Status](./IMPLEMENTATION_STATUS.md)
- [Deployment Guide](../../HMAC_SIGNED_URLS_DEPLOYMENT.md)