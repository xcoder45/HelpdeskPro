export async function withTransaction(database, work) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] transaction rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}
