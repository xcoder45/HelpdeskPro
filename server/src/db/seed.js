import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { pool, withPoolTransaction } from './pool.js';

const SLA_RULES = [
  { priority: 'Critical', response_minutes: 60 },
  { priority: 'High', response_minutes: 240 },
  { priority: 'Medium', response_minutes: 480 },
  { priority: 'Low', response_minutes: 1440 }
];

const CATEGORY_CATALOG = {
  Hardware: ['Laptop / Desktop', 'Peripherals', 'Printers'],
  Software: ['Applications', 'Operating System', 'Licensing'],
  Network: ['Wi-Fi', 'VPN', 'Connectivity'],
  'Access & Accounts': ['Password Reset', 'Account Provisioning', 'Permissions'],
  Facilities: ['Office Equipment', 'Building Services'],
  Other: ['General Inquiry', 'Unclassified']
};

function bootstrapUsers() {
  if (env.NODE_ENV === 'production' && !env.ALLOW_PRODUCTION_BOOTSTRAP_USERS) {
    console.warn('[seed] bootstrap users skipped in production; set ALLOW_PRODUCTION_BOOTSTRAP_USERS=true only for an intentional bootstrap');
    return [];
  }

  const candidates = [
    { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD, role: 'admin', first: 'Avery', last: 'Administrator' },
    { email: env.SEED_AGENT_EMAIL, password: env.SEED_AGENT_PASSWORD, role: 'agent', first: 'Sam', last: 'Support' },
    { email: env.SEED_EMPLOYEE_EMAIL, password: env.SEED_EMPLOYEE_PASSWORD, role: 'employee', first: 'Elena', last: 'Employee' }
  ];
  return candidates.filter((user) => user.email && user.password);
}

export async function seedReferenceData(activePool = pool, { includeBootstrapUsers = true } = {}) {
  return withPoolTransaction(async (client) => {
    for (const role of ['employee', 'agent', 'admin']) {
      await client.query(
        `INSERT INTO roles (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [role, `${role} role`]
      );
    }

    for (const rule of SLA_RULES) {
      await client.query(
        `INSERT INTO sla_rules (priority, response_minutes)
         VALUES ($1, $2) ON CONFLICT (priority) DO NOTHING`,
        [rule.priority, rule.response_minutes]
      );
    }

    let categoriesInserted = 0;
    let subcategoriesInserted = 0;

    for (const [categoryName, subcategories] of Object.entries(CATEGORY_CATALOG)) {
      const result = await client.query(
        `INSERT INTO categories (name, description)
         VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [categoryName, `${categoryName} related incidents`]
      );
      if (result.rowCount > 0) categoriesInserted += 1;

      const { rows: categoryRows } = await client.query(
        'SELECT id FROM categories WHERE name = $1',
        [categoryName]
      );
      const categoryId = categoryRows[0].id;

      for (const subcategoryName of subcategories) {
        const inserted = await client.query(
          `INSERT INTO subcategories (category_id, name)
           VALUES ($1, $2) ON CONFLICT (category_id, name) DO NOTHING`,
          [categoryId, subcategoryName]
        );
        if (inserted.rowCount > 0) subcategoriesInserted += 1;
      }
    }

    const { rows: roleRows } = await client.query('SELECT id, name FROM roles');
    const roleIds = new Map(roleRows.map((role) => [role.name, role.id]));

    let usersInserted = 0;
    if (includeBootstrapUsers) {
      for (const user of bootstrapUsers()) {
        const existing = await client.query(
          'SELECT 1 FROM users WHERE lower(email) = lower($1)',
          [user.email]
        );
        if (existing.rowCount > 0) continue;

        const passwordHash = await bcrypt.hash(user.password, 12);
        await client.query(
          `INSERT INTO users (first_name, last_name, email, password_hash, role_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.first, user.last, user.email, passwordHash, roleIds.get(user.role)]
        );
        usersInserted += 1;
      }
    }

    return {
      roles: roleIds.size,
      slaRules: SLA_RULES.length,
      categoriesInserted,
      subcategoriesInserted,
      usersInserted
    };
  }, activePool);
}

if (process.argv[1] && /[\\/]seed\.js$/.test(process.argv[1])) {
  seedReferenceData()
    .then((summary) => console.log('[seed] reference data ready:', summary))
    .catch((error) => {
      console.error('[seed] failed:', error.message || String(error));
      process.exitCode = 1;
    });
}
