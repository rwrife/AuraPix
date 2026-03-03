import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  handleApplyEdits,
  handleListPlugins,
  handleRevertVersion,
} from '../handlers/edits/applyEdits.js';

const router = Router();

// Plugin contract and manifest
router.get('/plugins', requireAuth, handleListPlugins);

// Apply edits to a photo (creates new version)
router.post('/:libraryId/:photoId', requireAuth, handleApplyEdits);

// Revert to a previous edit version
router.post('/:libraryId/:photoId/revert', requireAuth, handleRevertVersion);

export default router;