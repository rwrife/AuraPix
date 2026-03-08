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

  return router;
}
