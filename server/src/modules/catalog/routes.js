import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { requireRole } from '../../middleware/roles.js';
import { validate } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { idParamSchema } from '../../validation/common.js';
import {
  createCategorySchema,
  createSubcategorySchema,
  listCategoriesQuerySchema,
  subcategoryParamSchema,
  updateCategorySchema,
  updateSubcategorySchema
} from './schemas.js';
import {
  createCategory,
  createSubcategory,
  getCategory,
  listCategories,
  listCategoriesForAdmin,
  updateCategory,
  updateSubcategory
} from './service.js';

export function createCategoriesRouter({ database = pool } = {}) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      if (req.user?.role === 'admin') {
        return await listAdminCategories(req, res);
      }
      return sendSuccess(res, await listCategories(database));
    } catch (error) {
      return next(error);
    }
  });

  async function listAdminCategories(req, res) {
    const query = req.validatedQuery ?? listCategoriesQuerySchema.parse({});
    const { categories, total } = await listCategoriesForAdmin(database, query);
    return sendSuccess(res, categories, 200, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit)
    });
  }

  router.get(
    '/admin',
    requireRole('admin'),
    validate(listCategoriesQuerySchema, 'query'),
    (req, res, next) => listAdminCategories(req, res).catch(next)
  );

  router.get('/:id', validate(idParamSchema, 'params'), async (req, res) => {
    const category = await getCategory(database, req.validatedParams.id, req.user?.role === 'admin');
    return sendSuccess(res, { category });
  });

  router.post(
    '/',
    requireRole('admin'),
    validate(createCategorySchema),
    async (req, res) => {
      const category = await withTransaction(database, async (client) => {
        const created = await createCategory(client, req.body);
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'category.created',
          entityType: 'category',
          entityId: created.id,
          details: { name: created.name },
          ipAddress: req.ip
        });
        return created;
      });
      return sendSuccess(res, { category }, 201);
    }
  );

  router.patch(
    '/:id',
    requireRole('admin'),
    validate(idParamSchema, 'params'),
    validate(updateCategorySchema),
    async (req, res) => {
      const category = await withTransaction(database, async (client) => {
        const updated = await updateCategory(client, req.validatedParams.id, req.body);
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'category.updated',
          entityType: 'category',
          entityId: updated.id,
          details: { fields: Object.keys(req.body) },
          ipAddress: req.ip
        });
        return updated;
      });
      return sendSuccess(res, { category });
    }
  );

  router.delete(
    '/:id',
    requireRole('admin'),
    validate(idParamSchema, 'params'),
    async (req, res) => {
      const category = await withTransaction(database, async (client) => {
        const updated = await updateCategory(client, req.validatedParams.id, { isActive: false });
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'category.deactivated',
          entityType: 'category',
          entityId: updated.id,
          details: { name: updated.name },
          ipAddress: req.ip
        });
        return updated;
      });
      return sendSuccess(res, { category });
    }
  );

  router.post(
    '/:id/subcategories',
    requireRole('admin'),
    validate(idParamSchema, 'params'),
    validate(createSubcategorySchema),
    async (req, res) => {
      const subcategory = await withTransaction(database, async (client) => {
        const created = await createSubcategory(client, req.validatedParams.id, req.body);
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'subcategory.created',
          entityType: 'subcategory',
          entityId: created.id,
          details: { categoryId: req.validatedParams.id, name: created.name },
          ipAddress: req.ip
        });
        return created;
      });
      return sendSuccess(res, { subcategory }, 201);
    }
  );

  router.patch(
    '/:id/subcategories/:subId',
    requireRole('admin'),
    validate(subcategoryParamSchema, 'params'),
    validate(updateSubcategorySchema),
    async (req, res) => {
      const { id, subId } = req.validatedParams;
      const subcategory = await withTransaction(database, async (client) => {
        const updated = await updateSubcategory(client, id, subId, req.body);
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'subcategory.updated',
          entityType: 'subcategory',
          entityId: updated.id,
          details: { categoryId: id, fields: Object.keys(req.body) },
          ipAddress: req.ip
        });
        return updated;
      });
      return sendSuccess(res, { subcategory });
    }
  );

  return router;
}
