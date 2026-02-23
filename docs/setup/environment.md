# Environment Configuration

AuraPix uses environment variables for runtime configuration. For local development:

1. Copy `.env.example` to `.env`
2. Fill values as needed for your environment
3. Restart the dev server after changes

## Variable reference

- `VITE_APP_NAME`: UI label for the app.
- `VITE_APP_ENV`: Environment name (`development`, `staging`, `production`).
- `VITE_API_BASE_URL`: Base URL for backend API.
- `VITE_FIREBASE_*`: Optional Firebase web config. Keep blank until Firebase integration work begins.

## Notes

- Never commit secrets in `.env`.
- `VITE_` prefixed values are exposed to the browser; do not place server-only secrets here.
