import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { handleApplyEdits, handleRevertVersion } from '../handlers/edits/applyEdits.js';

const router = Router();

// Apply edits to a photo (creates new version)
router.post('/:libraryId/:photoId', requireAuth, handleApplyEdits);

// Revert to a previous edit version
router.post('/:libraryId/:photoId/revert', requireAuth, handleRevertVersion);

export default router;