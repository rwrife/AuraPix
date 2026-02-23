# Feature Plan: Uploads, Processing & Storage

## Objective
Create a reliable upload and processing pipeline for originals and derivatives.

## Scope
- Secure upload session creation
- Cloud Storage object conventions
- Derivative generation (thumbnail/web previews)
- EXIF extraction and metadata persistence
- Quota accounting and lifecycle management

## Planned detail expansion
- Upload workflow sequence diagram
- Cloud Functions/Cloud Run processing responsibilities
- Retry/idempotency strategy
- Storage usage counters and reconciliation jobs
- Soft delete/trash retention and hard delete policies
