import { conflict, notFoundError } from '../../utils/errors.js';

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function formatCategory(row, includeInactive = false) {
  if (!row) return null;
  const subcategories = (row.subcategories ?? [])
    .filter((subcategory) => includeInactive || subcategory.isActive)
    .map((subcategory) => ({
      id: Number(subcategory.id),
      name: subcategory.name,
      isActive: Boolean(subcategory.isActive)
    }));
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description ?? '',
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subcategories
  };
}

const CATEGORY_SELECT = `
  SELECT c.*,
         COALESCE(
           json_agg(
             json_build_object('id', s.id, 'name', s.name, 'isActive', s.is_active) ORDER BY s.name
           ) FILTER (WHERE s.id IS NOT NULL),
           '[]'::json
         ) AS subcategories
  FROM categories c
  LEFT JOIN subcategories s ON s.category_id = c.id
`;

export async function listCategories(database) {
  const { rows } = await database.query(
    `${CATEGORY_SELECT}
     WHERE c.is_active = true
     GROUP BY c.id, c.name, c.description, c.is_active, c.created_at, c.updated_at
     ORDER BY c.name ASC`
  );
  return rows.map((row) => formatCategory(row));
}

export async function listCategoriesForAdmin(database, query) {
  const values = [];
  const conditions = ['1 = 1'];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (!query.includeInactive) {
    conditions.push('c.is_active = true');
  }
  if (query.search) {
    conditions.push(`(
      c.name ILIKE ${addValue(`%${escapeLike(query.search)}%`)} ESCAPE '\\'
      OR c.description ILIKE ${addValue(`%${escapeLike(query.search)}%`)} ESCAPE '\\'
    )`);
  }

  const where = conditions.join(' AND ');
  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total FROM categories c WHERE ${where}`,
    values
  );

  const sortColumns = { name: 'c.name', createdAt: 'c.created_at' };
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = addValue(query.limit);
  const offset = addValue((query.page - 1) * query.limit);
  const { rows } = await database.query(
    `${CATEGORY_SELECT}
     WHERE ${where}
     GROUP BY c.id, c.name, c.description, c.is_active, c.created_at, c.updated_at
     ORDER BY ${sortColumns[query.sort]} ${direction}, c.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  return { categories: rows.map((row) => formatCategory(row, true)), total: countRows[0].total };
}

export async function getCategory(database, id, includeInactive = true) {
  const { rows } = await database.query(
    `${CATEGORY_SELECT} WHERE c.id = $1 GROUP BY c.id, c.name, c.description, c.is_active, c.created_at, c.updated_at`,
    [id]
  );
  if (rows.length === 0 || (!includeInactive && !rows[0].is_active)) throw notFoundError('Category not found');
  return formatCategory(rows[0], includeInactive);
}

export async function createCategory(database, { name, description }) {
  try {
    const { rows } = await database.query(
      `INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING id`,
      [name, description]
    );
    return await getCategory(database, rows[0].id);
  } catch (error) {
    if (error.code === '23505') throw conflict('A category with this name already exists');
    throw error;
  }
}

export async function updateCategory(database, id, changes) {
  const columns = {
    name: 'name',
    description: 'description',
    isActive: 'is_active'
  };
  const values = [];
  const assignments = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in changes)) continue;
    values.push(changes[key]);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return getCategory(database, id);

  values.push(id);
  try {
    const result = await database.query(
      `UPDATE categories SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
      values
    );
    if (result.rowCount === 0) throw notFoundError('Category not found');
    return getCategory(database, id);
  } catch (error) {
    if (error.code === '23505') throw conflict('A category with this name already exists');
    throw error;
  }
}

export async function createSubcategory(database, categoryId, { name }) {
  const category = await getCategory(database, categoryId);
  if (!category.isActive) throw notFoundError('Category not found');
  try {
    const { rows } = await database.query(
      `INSERT INTO subcategories (category_id, name) VALUES ($1, $2) RETURNING id`,
      [categoryId, name]
    );
    await database.query('UPDATE categories SET updated_at = now() WHERE id = $1', [categoryId]);
    const result = await database.query(
      `SELECT id, name, is_active FROM subcategories WHERE id = $1`,
      [rows[0].id]
    );
    const row = result.rows[0];
    return { id: Number(row.id), name: row.name, isActive: Boolean(row.is_active) };
  } catch (error) {
    if (error.code === '23505') throw conflict('A subcategory with this name already exists in this category');
    throw error;
  }
}

export async function updateSubcategory(database, categoryId, subId, changes) {
  const values = [];
  const assignments = [];
  if ('name' in changes) {
    values.push(changes.name);
    assignments.push(`name = $${values.length}`);
  }
  if ('isActive' in changes) {
    values.push(changes.isActive);
    assignments.push(`is_active = $${values.length}`);
  }
  if (assignments.length === 0) {
    const { rows } = await database.query(
      `SELECT id, name, is_active FROM subcategories WHERE id = $1 AND category_id = $2`,
      [subId, categoryId]
    );
    if (rows.length === 0) throw notFoundError('Subcategory not found');
    return { id: Number(rows[0].id), name: rows[0].name, isActive: Boolean(rows[0].is_active) };
  }

  values.push(subId, categoryId);
  try {
    const result = await database.query(
      `UPDATE subcategories SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${values.length - 1} AND category_id = $${values.length} RETURNING id, name, is_active`,
      values
    );
    if (result.rowCount === 0) throw notFoundError('Subcategory not found');
    await database.query('UPDATE categories SET updated_at = now() WHERE id = $1', [categoryId]);
    const row = result.rows[0];
    return { id: Number(row.id), name: row.name, isActive: Boolean(row.is_active) };
  } catch (error) {
    if (error.code === '23505') throw conflict('A subcategory with this name already exists in this category');
    throw error;
  }
}
