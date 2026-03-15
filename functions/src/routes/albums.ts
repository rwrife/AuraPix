import { Router } from 'express';
import type { AlbumsService } from '../domain/albums/AlbumsService.js';

export function createAlbumsRouter(albums: AlbumsService): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const items = await albums.list(req.user.uid);
      res.json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const created = await albums.create({
        ownerId: req.user.uid,
        title: typeof req.body?.title === 'string' ? req.body.title : '',
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      });

      res.status(201).json(created);
    } catch (error) {
      if (error instanceof Error && error.message === 'album-title-required') {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      next(error);
    }
  });

  router.delete('/:albumId', async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const albumId = typeof req.params.albumId === 'string' ? req.params.albumId.trim() : '';
      if (!albumId) {
        res.status(400).json({ error: 'albumId is required' });
        return;
      }

      await albums.remove(req.user.uid, albumId);
      res.status(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'album-not-found') {
        res.status(404).json({ error: 'Album not found' });
        return;
      }

      next(error);
    }
  });

  return router;
}
